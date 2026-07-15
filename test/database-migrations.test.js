const test = require('node:test');
const assert = require('node:assert/strict');

const { loadMigrations, runMigrations } = require('../models/postgres-migrations');

function createFakePool(initialApplied = []) {
  const applied = new Map(initialApplied.map(row => [row.version, row]));
  const queries = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      queries.push({ sql: normalized, params });

      if (normalized.startsWith('SELECT version, name, checksum')) {
        return { rows: Array.from(applied.values()) };
      }

      if (normalized.startsWith('INSERT INTO public.quickshare_schema_migrations')) {
        applied.set(params[0], {
          version: params[0],
          name: params[1],
          checksum: params[2]
        });
      }

      return { rows: [] };
    },
    release() {
      released = true;
    }
  };

  return {
    pool: {
      async connect() {
        return client;
      }
    },
    queries,
    wasReleased() {
      return released;
    }
  };
}

test('migrations contain every runtime table, column, index, and site setting', () => {
  const migrations = loadMigrations();

  assert.deepEqual(migrations.map(migration => migration.name), [
    '001_baseline.sql',
    '002_site_settings.sql'
  ]);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS public\.pages/i);
  assert.match(migrations[0].sql, /ADD COLUMN IF NOT EXISTS password_hash/i);
  assert.match(migrations[0].sql, /ADD COLUMN IF NOT EXISTS encrypted_password/i);
  assert.match(migrations[0].sql, /ADD COLUMN IF NOT EXISTS markdown_theme/i);
  assert.match(migrations[0].sql, /ADD COLUMN IF NOT EXISTS view_count/i);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS public\.audit_logs/i);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS public\.api_keys/i);
  assert.match(migrations[0].sql, /idx_pages_created_at/i);
  assert.match(migrations[0].sql, /idx_pages_view_count/i);
  assert.match(migrations[0].sql, /idx_audit_logs_created_at/i);
  assert.match(migrations[0].sql, /idx_audit_logs_page_id/i);
  assert.match(migrations[0].sql, /idx_api_keys_created_at/i);
  assert.match(migrations[1].sql, /CREATE TABLE public\.site_settings/i);
  assert.match(migrations[1].sql, /homepage_password_required BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(migrations[1].sql, /CHECK \(id = 1\)/i);
  assert.match(migrations[1].sql, /ON CONFLICT \(id\) DO NOTHING/i);
});

test('migration runner applies pending files once and releases its client', async () => {
  const fake = createFakePool();
  let commitWasVisibleWhenLogged = false;

  const first = await runMigrations(fake.pool, {
    logger: {
      info() {
        commitWasVisibleWhenLogged = fake.queries.some(query => query.sql === 'COMMIT');
      }
    }
  });
  const second = await runMigrations(fake.pool, { logger: { info() {} } });
  const migrationSql = loadMigrations().map(migration => migration.sql.trim());

  assert.deepEqual(first, { applied: ['001', '002'], skipped: [] });
  assert.deepEqual(second, { applied: [], skipped: ['001', '002'] });
  for (const sql of migrationSql) {
    assert.equal(fake.queries.filter(query => query.sql === sql).length, 1);
  }
  assert.equal(fake.queries.some(query => query.sql === 'BEGIN'), true);
  assert.equal(fake.queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(commitWasVisibleWhenLogged, true);
  assert.equal(
    fake.queries
      .filter(query => query.sql.includes('quickshare_schema_migrations'))
      .every(query => query.sql.includes('public.quickshare_schema_migrations')),
    true
  );
  assert.equal(fake.wasReleased(), true);
});

test('migration runner rejects a modified migration that was already applied', async () => {
  const migration = loadMigrations()[0];
  const fake = createFakePool([{
    version: migration.version,
    name: migration.name,
    checksum: 'stale-checksum'
  }]);

  await assert.rejects(
    runMigrations(fake.pool, { logger: { info() {} } }),
    /checksum mismatch/i
  );
  assert.equal(fake.wasReleased(), true);
});

test('migration runner rejects a database version missing from local files', async () => {
  const fake = createFakePool([{
    version: '999',
    name: '999_future.sql',
    checksum: 'future-checksum'
  }]);

  await assert.rejects(
    runMigrations(fake.pool, { logger: { info() {} } }),
    /unknown applied migration: 999/i
  );
  assert.equal(fake.queries.some(query => query.sql === 'ROLLBACK'), true);
  assert.equal(fake.wasReleased(), true);
});
