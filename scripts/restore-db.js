#!/usr/bin/env node
'use strict';

/*
 * Native restore for QuickShare PostgreSQL backups.
 *
 * Restores a pg_dump custom-format backup (produced by scripts/backup-db.js)
 * into an isolated restore database. The target must differ from the source;
 * a matching database name with any non-loopback endpoint is rejected because
 * URL hostnames cannot prove remote server identity. Both URLs must also
 * satisfy the localhost `_test` guard unless separately authorized. A restored
 * database is never wired to an application; it stays offline by default
 * (see docs/backup-restore.md).
 */

const fs = require('fs');
const path = require('path');

const {
  assertTestDatabaseUrl,
  assertToolMatchesServer,
  deriveInternalUrl,
  isLocalHost,
  localPoolEnv,
  parseCliArgs,
  parseConnectionStringParts,
  parsePostgresMajorFromServerVersionNum,
  redactUrl,
  samePostgresEndpoint,
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

function normalizeEndpoint(endpoint, label) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error(`${label} endpoint is required`);
  }

  const { host, database } = endpoint;
  const rawPort = endpoint.port;
  const port = typeof rawPort === 'number' && Number.isInteger(rawPort)
    ? String(rawPort)
    : rawPort;

  if (typeof host !== 'string' || host.length === 0 || host !== host.trim()
      || /[\s\/@?#]/.test(host)) {
    throw new Error(`${label} endpoint host is missing or malformed`);
  }

  try {
    const hostAuthority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const parsedHost = new URL(`postgresql://${hostAuthority}/`);
    if (!parsedHost.hostname || parsedHost.port || parsedHost.username || parsedHost.password
        || parsedHost.pathname !== '/') {
      throw new Error('invalid host authority');
    }
  } catch {
    throw new Error(`${label} endpoint host is missing or malformed`);
  }

  if ((typeof port !== 'string' && typeof port !== 'number')
      || !/^\d+$/.test(String(port))
      || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${label} endpoint port is missing or malformed`);
  }

  if (typeof database !== 'string' || database.trim().length === 0 || database.includes('\0')) {
    throw new Error(`${label} endpoint database is missing or malformed`);
  }

  return { host, port: String(port), database };
}

function assertManifestSourceMatchesSourceUrl(manifest, sourceUrlParts) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('A backup manifest is required');
  }

  const manifestSource = normalizeEndpoint(manifest, 'Backup manifest source');
  const trustedSource = normalizeEndpoint(sourceUrlParts, 'Trusted source URL');

  if (!samePostgresEndpoint(manifestSource, trustedSource)) {
    throw new Error('Backup manifest source endpoint does not match the independently supplied --source-url');
  }

  return true;
}

function assertRestoreTargetDiffers(source, target) {
  const sourceEndpoint = normalizeEndpoint(source, 'Trusted source');
  const targetEndpoint = normalizeEndpoint(target, 'Restore target');

  const sameDatabaseName = sourceEndpoint.database === targetEndpoint.database;
  const hasNonLoopbackEndpoint = !isLocalHost(sourceEndpoint.host) || !isLocalHost(targetEndpoint.host);
  if (sameDatabaseName && hasNonLoopbackEndpoint) {
    throw new Error(`Restore source and target use the same database name "${sourceEndpoint.database}" ` +
      'and at least one endpoint is non-loopback; hostname aliases and tunnels cannot prove separate PostgreSQL instances. ' +
      'Refusing before reading the dump or connecting. Use a separately authorized restore to a distinct database name ' +
      'and follow the verified operator flow; --allow-non-test does not override this guard.');
  }

  if (samePostgresEndpoint(sourceEndpoint, targetEndpoint)) {
    throw new Error(`Restore target must differ from the trusted source database ` +
      `(${sourceEndpoint.host}:${sourceEndpoint.port}/${sourceEndpoint.database}); refusing an in-place overwrite.`);
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
  sourceUrl,
  dockerContainer,
  toolBin,
  clean = true,
  allowNonTest
}) {
  if (!sourceUrl) {
    throw new Error('A trusted backup source URL is required (--source-url)');
  }
  if (!targetUrl) {
    throw new Error('A restore target URL is required (--target-url or RESTORE_DATABASE_URL)');
  }

  const sourceParts = parseConnectionStringParts(sourceUrl);
  const targetParts = parseConnectionStringParts(targetUrl);

  // This guard is intentionally independent of editable manifest metadata and
  // runs before the local/test guard, reading the dump, constructing a Pool,
  // or invoking pg_restore. Remote URL authorities cannot prove server identity.
  assertRestoreTargetDiffers(sourceParts, targetParts);

  assertTestDatabaseUrl(sourceUrl, { allowNonTest });
  const guard = assertTestDatabaseUrl(targetUrl, { allowNonTest });
  const testGuardBypassed = guard === true ? false : guard.testGuardBypassed;

  const resolvedManifest = manifest
    || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (resolvedManifest.kind !== 'quickshare-native-consistent-backup') {
    throw new Error(`Unexpected manifest kind: ${resolvedManifest.kind}`);
  }

  // The manifest is editable and its dump digest binds only dump bytes. Treat
  // endpoint fields as consistency claims, never as source identity proof.
  assertManifestSourceMatchesSourceUrl(resolvedManifest, sourceParts);

  const resolvedDumpPath = dumpPath
    || (manifestPath
      ? path.join(path.dirname(manifestPath), resolvedManifest.dumpFile)
      : null);

  if (!resolvedDumpPath) {
    throw new Error('A dump path is required (--dump or via --manifest directory)');
  }

  verifyDumpSha256(resolvedDumpPath, resolvedManifest.dumpSha256);

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

  if (!args.manifest) {
    throw new Error('A backup manifest is required: pass --manifest <path>; --dump only overrides its dump path');
  }

  const restoreManifest = await restoreBackup({
    manifestPath: args.manifest,
    dumpPath: args.dump,
    sourceUrl: args.sourceUrl,
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
  assertManifestSourceMatchesSourceUrl,
  assertRestoreTargetDiffers,
  restoreBackup,
  verifyDumpSha256
};
