#!/usr/bin/env node
'use strict';

// Restore a complete QuickShare backup into an isolated database
// (T03, issue #27). The target database must already exist, must be on
// localhost, its name must end in _test unless --allow-non-test is passed,
// and its server major version must match the backup. A non-empty target is
// refused unless --clean is passed, which drops and recreates the public
// schema of the TARGET database only.
//
// A restored database is evidence, not a service: it must stay offline
// (safeToServe stays false) until verify-backup passes and the owner has
// reviewed revocations that may have happened after the restore point.
//
// Usage:
//   node scripts/restore-db.js --input-dir ./backup-2026-01-01 --database-url postgres://user:pass@127.0.0.1:5432/quickshare_restore_test

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createPostgresPool } = require('../models/postgres-config');
const {
  assertIsolatedDatabaseUrl,
  parseArgs,
  pgToolConnection,
  pgToolMajorVersion,
  resolvePgTool,
  runCommand,
  sha256Hex
} = require('./backup-lib');

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    inputDir: { type: 'string', required: true },
    databaseUrl: { type: 'string', required: true },
    pgBinDir: { type: 'string' },
    receipt: { type: 'string' },
    allowNonTest: { type: 'boolean' },
    clean: { type: 'boolean' }
  });

  const target = assertIsolatedDatabaseUrl(options.databaseUrl, {
    allowNonTest: options.allowNonTest,
    purpose: 'restore target database'
  });

  const manifestPath = path.join(options.inputDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.format !== 'quickshare-full-backup') {
    throw new Error(`${manifestPath} is not a quickshare-full-backup manifest`);
  }

  const dumpPath = path.join(options.inputDir, manifest.dump.file);

  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump file not found: ${dumpPath}`);
  }

  const dumpSha256 = sha256Hex(fs.readFileSync(dumpPath));

  if (dumpSha256 !== manifest.dump.sha256) {
    throw new Error('Dump file checksum does not match the manifest; refusing to restore');
  }

  const pgRestore = resolvePgTool('pg_restore', { binDir: options.pgBinDir });
  const restoreToolMajor = await pgToolMajorVersion(pgRestore);

  if (restoreToolMajor !== manifest.source.serverMajor) {
    throw new Error(
      `pg_restore major version ${restoreToolMajor} does not match backup server major version ${manifest.source.serverMajor}`
    );
  }

  const pool = createPostgresPool(options.databaseUrl, { max: 1 });

  try {
    const serverResult = await pool.query(
      "SELECT current_setting('server_version_num') AS version_num"
    );
    const targetMajor = Math.floor(Number(serverResult.rows[0].version_num) / 10000);

    if (targetMajor !== manifest.source.serverMajor) {
      throw new Error(
        `Restore target server major version ${targetMajor} does not match backup server major version ${manifest.source.serverMajor}`
      );
    }

    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const existingTables = tablesResult.rows.map(row => row.table_name);

    if (existingTables.length > 0 && !options.clean) {
      throw new Error(
        `Restore target already contains tables (${existingTables.join(', ')}); pass --clean to drop and recreate its public schema`
      );
    }

    if (options.clean) {
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
    }
  } finally {
    await pool.end();
  }

  const connection = pgToolConnection(options.databaseUrl);
  const restoreStartedAt = Date.now();
  const restoreResult = await runCommand(pgRestore, [
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    ...connection.args,
    dumpPath
  ], {
    env: { ...process.env, ...connection.env }
  });
  const restoreDurationMs = Date.now() - restoreStartedAt;

  if (restoreResult.code !== 0) {
    throw new Error(`pg_restore failed: ${restoreResult.stderr.trim()}`);
  }

  const receipt = {
    format: 'quickshare-restore-receipt',
    version: 1,
    restoredAt: Date.now(),
    restoreDurationMs,
    target: { host: target.host, port: target.port, database: target.database },
    manifestCreatedAt: manifest.createdAt,
    restorePoint: manifest.restorePoint,
    dumpSha256,
    safeToServe: false,
    note: 'Restored databases stay offline. Run verify-backup and review post-restore-point revocations before any restored content or credential is allowed to serve.'
  };

  const receiptPath = options.receipt || path.join(options.inputDir, 'restore-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  console.log(JSON.stringify({ ok: true, receipt }));
}

main().catch((error) => {
  console.error(`[db:restore] failed: ${error.message}`);
  process.exitCode = 1;
});
