#!/usr/bin/env node
'use strict';

/*
 * Native restore for QuickShare PostgreSQL backups.
 *
 * Restores a pg_dump custom-format backup (produced by scripts/backup-db.js)
 * into an isolated restore database. The restore target must differ from the
 * backup source database and must satisfy the same localhost `_test` guard.
 * A restored database is never wired to an application by this script; it
 * stays offline by default (see docs/backup-restore.md).
 */

const fs = require('fs');
const path = require('path');

const {
  assertTestDatabaseUrl,
  assertToolMatchesServer,
  deriveInternalUrl,
  localPoolEnv,
  parseCliArgs,
  parseConnectionStringParts,
  parsePostgresMajorFromServerVersionNum,
  redactUrl,
  resolveToolCommand,
  runCommand
} = require('./backup-db');

const DOCKER_STAGING_PATH = '/tmp/issue27-restore.dump';

function verifyDumpSha256(dumpPath, expectedSha256) {
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump file not found: ${dumpPath}`);
  }

  const { computeFileSha256 } = require('./backup-db');
  const actual = computeFileSha256(dumpPath);

  if (actual !== expectedSha256) {
    throw new Error(`Dump digest mismatch: expected ${expectedSha256}, found ${actual}. ` +
      'Refusing to restore a backup that does not match its manifest.');
  }

  return true;
}

function assertRestoreTargetDiffers(manifest, target) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('A backup manifest is required');
  }

  const sameDatabase = manifest.database === target.database
    && String(manifest.port || '5432') === String(target.port || '5432')
    && (manifest.host === target.host
      || (manifest.host === 'localhost' && target.host === '127.0.0.1')
      || (manifest.host === '127.0.0.1' && target.host === 'localhost'));

  if (sameDatabase) {
    throw new Error(`Restore target must differ from the backup source database ` +
      `(${manifest.host}:${manifest.port}/${manifest.database}); refusing an in-place overwrite.`);
  }

  return true;
}

async function readRestoreServerState(connectionString) {
  const { createPostgresPool } = require('../models/postgres-config');
  const pool = createPostgresPool(connectionString, {
    env: localPoolEnv(connectionString),
    max: 1
  });

  try {
    const versionNum = await pool.query('SHOW server_version_num');
    const version = await pool.query('SHOW server_version');

    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number.parseInt(versionNum.rows[0].server_version_num, 10)
    };
  } finally {
    await pool.end();
  }
}

async function restoreBackup({
  manifest,
  manifestPath,
  dumpPath,
  targetUrl,
  dockerContainer,
  toolBin,
  clean = true,
  allowNonTest
}) {
  if (!targetUrl) {
    throw new Error('A restore target URL is required (--target-url or RESTORE_DATABASE_URL)');
  }

  const guard = assertTestDatabaseUrl(targetUrl, { allowNonTest });
  const testGuardBypassed = guard === true ? false : guard.testGuardBypassed;

  const resolvedManifest = manifest
    || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (resolvedManifest.kind !== 'quickshare-native-consistent-backup') {
    throw new Error(`Unexpected manifest kind: ${resolvedManifest.kind}`);
  }

  const resolvedDumpPath = dumpPath
    || (manifestPath
      ? path.join(path.dirname(manifestPath), resolvedManifest.dumpFile)
      : null);

  if (!resolvedDumpPath) {
    throw new Error('A dump path is required (--dump or via --manifest directory)');
  }

  verifyDumpSha256(resolvedDumpPath, resolvedManifest.dumpSha256);

  const targetParts = parseConnectionStringParts(targetUrl);
  assertRestoreTargetDiffers(resolvedManifest, targetParts);

  const targetServer = await readRestoreServerState(targetUrl);
  const targetMajor = parsePostgresMajorFromServerVersionNum(targetServer.serverVersionNum);

  const tool = await resolveToolCommand({
    tool: 'pg_restore',
    dockerContainer,
    toolBin
  });
  assertToolMatchesServer({ toolName: 'pg_restore', toolMajor: tool.major, serverMajor: targetMajor });

  const restoreArgs = [
    '--no-owner', '--no-privileges', '--exit-on-error'
  ];
  if (clean) {
    restoreArgs.push('--clean', '--if-exists');
  }

  const restoreStarted = Date.now();
  if (tool.dockerContainer) {
    const copy = await runCommand(['docker', 'cp', resolvedDumpPath, `${tool.dockerContainer}:${DOCKER_STAGING_PATH}`]);
    if (copy.code !== 0) {
      throw new Error(`docker cp failed: ${copy.stderr.trim().slice(0, 400)}`);
    }

    const result = await runCommand([
      ...tool.execPrefix({ tool: 'pg_restore' }),
      ...restoreArgs,
      '--dbname', deriveInternalUrl(targetUrl),
      DOCKER_STAGING_PATH
    ]);

    await runCommand(['docker', 'exec', tool.dockerContainer, 'rm', '-f', DOCKER_STAGING_PATH]);

    if (result.code !== 0) {
      throw new Error(`pg_restore failed inside container: ${result.stderr.trim().slice(0, 400)}`);
    }
  } else {
    const result = await runCommand([
      ...tool.execPrefix({ tool: 'pg_restore' }),
      ...restoreArgs,
      '--dbname', targetUrl,
      resolvedDumpPath
    ]);

    if (result.code !== 0) {
      throw new Error(`pg_restore failed: ${result.stderr.trim().slice(0, 400)}`);
    }
  }
  const restoreMs = Date.now() - restoreStarted;

  const restoreManifest = {
    kind: 'quickshare-native-restore',
    restoredAt: Date.now(),
    target: targetParts,
    targetServerVersion: targetServer.serverVersion,
    sourceBackup: {
      kind: resolvedManifest.kind,
      database: resolvedManifest.database,
      snapshotAt: resolvedManifest.snapshotAt,
      snapshotWalLsn: resolvedManifest.snapshotWalLsn,
      dumpSha256: resolvedManifest.dumpSha256,
      testGuardBypassed: resolvedManifest.testGuardBypassed === true
    },
    toolVersion: tool.versionOutput,
    clean,
    durationsMs: { restoreMs },
    testGuardBypassed,
    isolation: 'offline-by-default'
  };

  return restoreManifest;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const targetUrl = args.targetUrl || process.env.RESTORE_DATABASE_URL;

  if (!args.manifest && !args.dump) {
    throw new Error('A backup manifest is required: pass --manifest <path>');
  }

  const restoreManifest = await restoreBackup({
    manifestPath: args.manifest,
    dumpPath: args.dump,
    targetUrl,
    dockerContainer: args.docker || undefined,
    toolBin: args.toolBin || process.env.PG_RESTORE_BIN || undefined,
    clean: args.noClean !== true,
    allowNonTest: args.allowNonTest === true
  });

  console.log(`[restore:db] restored into ${redactUrl(`postgresql://${restoreManifest.target.host}:${restoreManifest.target.port}/${restoreManifest.target.database}`)}`);
  console.log(`[restore:db] source snapshot: ${new Date(restoreManifest.sourceBackup.snapshotAt).toISOString()}`);
  console.log(`[restore:db] pg_restore took ${restoreManifest.durationsMs.restoreMs}ms`);
  console.log('[restore:db] the restored database stays offline; run scripts/verify-backup.js next');
  if (restoreManifest.testGuardBypassed) {
    console.log('[restore:db] WARNING: test database guard explicitly bypassed (--allow-non-test)');
  }

  if (args.output) {
    fs.writeFileSync(args.output, `${JSON.stringify(restoreManifest, null, 2)}\n`);
    console.log(`[restore:db] manifest: ${args.output}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[restore:db] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertRestoreTargetDiffers,
  restoreBackup,
  verifyDumpSha256
};
