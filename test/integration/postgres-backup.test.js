const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// End-to-end backup/restore verification (T03, issue #27). Runs the real
// scripts/backup-restore-check.js drill against the embedded/local test
// Postgres: seed -> pg_dump -> pg_restore into a second _test database ->
// verify -> tamper -> verify must reject.
//
// Requires POSTGRES_TEST_URL (localhost, database name ending in _test) and
// pg_dump/pg_restore whose major version matches the server. Point
// QS_PG_BIN_DIR at the tool directory when they are not on PATH. When the
// tools are unavailable the tests skip explicitly instead of failing, so a
// missing local tool install is never mistaken for a passing restore check.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.replace(/^\//, '');
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

function findPgTools() {
  const dirs = [];

  if (process.env.QS_PG_BIN_DIR) {
    dirs.push(process.env.QS_PG_BIN_DIR);
  }

  dirs.push(...(process.env.PATH || '').split(path.delimiter).filter(Boolean));

  for (const dir of dirs) {
    const dump = path.join(dir, 'pg_dump');
    const restore = path.join(dir, 'pg_restore');

    if (fs.existsSync(dump) && fs.existsSync(restore)) {
      return dir;
    }
  }

  return null;
}

const pgBinDir = findPgTools();

function runDrill(schema) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', '..', 'scripts', 'backup-restore-check.js'), '--schema', schema],
      {
        env: {
          ...process.env,
          POSTGRES_TEST_URL: connectionString,
          POSTGRES_SSL: process.env.POSTGRES_SSL || 'false',
          ...(pgBinDir ? { QS_PG_BIN_DIR: pgBinDir } : {}),
          SESSION_SECRET: process.env.SESSION_SECRET || 'postgres-backup-integration-secret-0123456789'
        },
        timeout: 240000,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`backup-restore drill (${schema}) failed: ${error.message}\n${stderr}\n${stdout}`));
          return;
        }

        try {
          resolve({ summary: JSON.parse(stdout.trim()), stderr });
        } catch (parseError) {
          reject(new Error(`drill (${schema}) did not return a JSON summary: ${parseError.message}\n${stderr}\n${stdout}`));
        }
      }
    );
  });
}

const skipReason = pgBinDir
  ? null
  : 'pg_dump/pg_restore not found on PATH or QS_PG_BIN_DIR; backup/restore drill not run';

test('full backup restores into an isolated database and verifies (schema 001-007)', { skip: skipReason || false, timeout: 300000 }, async () => {
  const { summary, stderr } = await runDrill('full');

  assert.equal(summary.ok, true, `drill failures: ${summary.failures.join('; ')}\n${stderr}`);
  assert.deepEqual(summary.skipped, []);
  assert.equal(typeof summary.steps.backupDurationMs, 'number');
  assert.equal(typeof summary.steps.restoreDurationMs, 'number');
});

test('backup drill on a legacy 001-003 schema skips access_revision explicitly', { skip: skipReason || false, timeout: 300000 }, async () => {
  const { summary, stderr } = await runDrill('legacy');

  assert.equal(summary.ok, true, `drill failures: ${summary.failures.join('; ')}\n${stderr}`);
  assert.ok(
    summary.skipped.some(entry => entry.includes('access_revision')),
    `expected an explicit access_revision skip, got: ${JSON.stringify(summary.skipped)}`
  );
  assert.ok(
    summary.skipped.some(entry => entry.includes('publishing_writes_paused')),
    `expected an explicit publishing_writes_paused skip, got: ${JSON.stringify(summary.skipped)}`
  );
  assert.match(stderr, /SKIP access_revision/);
  assert.match(stderr, /SKIP publishing_writes_paused/);
});
