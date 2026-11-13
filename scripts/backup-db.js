#!/usr/bin/env node
'use strict';

// Create a complete QuickShare database backup (T03, issue #27).
//
// Produces, inside --output-dir:
//   quickshare-backup.dump  pg_dump custom-format archive (the private,
//                           restorable artifact; contains password hashes
//                           and encrypted passwords, so store it privately)
//   manifest.json           digests + metadata only, safe to share for
//                           verification; never contains secret material
//
// The dump and the manifest snapshot are taken from one exported Postgres
// snapshot, so they always describe the same consistent point in time.
//
// Usage:
//   node scripts/backup-db.js --database-url postgres://user:pass@127.0.0.1:5432/quickshare_test --output-dir ./backup-2026-01-01
//
// The database must be on localhost and its name must end in _test unless
// --allow-non-test is passed explicitly. pg_dump must match the server's
// major version; point --pg-bin-dir (or QS_PG_BIN_DIR) at the tool directory
// when the tools are not on PATH.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createPostgresPool } = require('../models/postgres-config');
const {
  assertIsolatedDatabaseUrl,
  buildManifest,
  collectSnapshot,
  parseArgs,
  pgToolConnection,
  pgToolMajorVersion,
  resolvePgTool,
  runCommand,
  sha256Hex
} = require('./backup-lib');

const DUMP_FILENAME = 'quickshare-backup.dump';
const MANIFEST_FILENAME = 'manifest.json';

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    databaseUrl: { type: 'string', default: process.env.DATABASE_URL || process.env.POSTGRES_URL },
    outputDir: { type: 'string', required: true },
    pgBinDir: { type: 'string' },
    allowNonTest: { type: 'boolean' }
  });

  if (!options.databaseUrl) {
    throw new Error('Missing required option: --database-url (or DATABASE_URL env)');
  }

  const source = assertIsolatedDatabaseUrl(options.databaseUrl, {
    allowNonTest: options.allowNonTest,
    purpose: 'backup source database'
  });

  const pgDump = resolvePgTool('pg_dump', { binDir: options.pgBinDir });
  const dumpToolMajor = await pgToolMajorVersion(pgDump);

  fs.mkdirSync(options.outputDir, { recursive: true });
  const dumpPath = path.join(options.outputDir, DUMP_FILENAME);
  const manifestPath = path.join(options.outputDir, MANIFEST_FILENAME);

  if (fs.existsSync(dumpPath) || fs.existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite an existing backup in ${options.outputDir}`);
  }

  const pool = createPostgresPool(options.databaseUrl, { max: 1 });
  const client = await pool.connect();
  const startedAt = Date.now();
  let snapshotId = null;
  let snapshot;
  let restorePoint;

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const snapshotResult = await client.query('SELECT pg_export_snapshot() AS snapshot_id');
    snapshotId = snapshotResult.rows[0].snapshot_id;

    const collected = await collectSnapshot((text, params) => client.query(text, params));
    snapshot = collected.snapshot;

    if (dumpToolMajor !== snapshot.serverMajor) {
      throw new Error(
        `pg_dump major version ${dumpToolMajor} does not match server major version ${snapshot.serverMajor}`
      );
    }

    restorePoint = {
      backedUpAt: startedAt,
      auditHighWaterId: snapshot.audit.highWaterId,
      auditHighWaterCreatedAt: snapshot.audit.highWaterCreatedAt
    };

    const connection = pgToolConnection(options.databaseUrl);
    const dumpStartedAt = Date.now();
    const dumpResult = await runCommand(pgDump, [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--snapshot=${snapshotId}`,
      `--file=${dumpPath}`,
      ...connection.args
    ], {
      env: { ...process.env, ...connection.env }
    });
    const backupDurationMs = Date.now() - dumpStartedAt;

    if (dumpResult.code !== 0) {
      throw new Error(`pg_dump failed: ${dumpResult.stderr.trim()}`);
    }

    await client.query('COMMIT');

    const dumpBytes = fs.readFileSync(dumpPath);
    const manifest = buildManifest({
      snapshot,
      source,
      dump: {
        file: DUMP_FILENAME,
        sha256: sha256Hex(dumpBytes),
        bytes: dumpBytes.length
      },
      restorePoint,
      backupDurationMs,
      createdAt: Date.now()
    });

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(JSON.stringify({
      ok: true,
      outputDir: options.outputDir,
      dumpFile: DUMP_FILENAME,
      manifestFile: MANIFEST_FILENAME,
      dumpSha256: manifest.dump.sha256,
      dumpBytes: manifest.dump.bytes,
      backupDurationMs,
      restorePoint,
      tables: snapshot.tables,
      counts: snapshot.counts
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    fs.rmSync(dumpPath, { force: true });
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[db:backup] failed: ${error.message}`);
  process.exitCode = 1;
});
