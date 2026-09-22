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
    '002_site_settings.sql',
    '003_page_favorites.sql',
    '004_page_access_revision.sql',
    '005_publishing_writes_paused.sql',
    '006_api_key_credential_version.sql',
    '007_share_revisions.sql',
    '008_publish_operations.sql',
    '009_share_revision_purge.sql'
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
  assert.match(migrations[2].sql, /ADD COLUMN IF NOT EXISTS is_favorite/i);
  assert.match(migrations[2].sql, /BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(migrations[4].sql, /publishing_writes_paused BOOLEAN NOT NULL DEFAULT FALSE/i);
  // #30: additive content-revision schema. Existing Shares keep their IDs,
  // URLs, content and published state; snapshots never carry policy fields.
  assert.match(migrations[6].sql, /ADD COLUMN current_revision BIGINT NOT NULL DEFAULT 1 CHECK \(current_revision > 0\)/i);
  assert.match(migrations[6].sql, /ADD COLUMN published BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(migrations[6].sql, /CREATE TABLE IF NOT EXISTS public\.share_revisions/i);
  assert.match(migrations[6].sql, /PRIMARY KEY \(share_id, revision\)/i);
  assert.match(migrations[6].sql, /REFERENCES public\.pages\(id\) ON DELETE CASCADE/i);
  assert.match(migrations[6].sql, /CHECK \(revision > 0\)/i);
  // Row-level provenance required by parent #24 §3, captured now — never
  // reconstructed from audit logs by a later ticket.
  assert.match(migrations[6].sql, /snapshot_hash TEXT NOT NULL/i);
  assert.match(migrations[6].sql, /source TEXT NOT NULL/i);
  assert.match(migrations[6].sql, /actor TEXT,/i);
  assert.match(migrations[6].sql, /restored_from BIGINT,/i);
  assert.doesNotMatch(migrations[6].sql, /password|expires_at|is_favorite|view_count/i);
  // #32: idempotent publish operations. The (actor_namespace, request_id)
  // ledger commits with its result, holds encrypted receipts only, and
  // carries NO foreign key: deletion tombstones outlive the Share lifecycle.
  assert.match(migrations[7].sql, /CREATE TABLE IF NOT EXISTS public\.publish_operations/i);
  assert.match(migrations[7].sql, /PRIMARY KEY \(actor_namespace, request_id\)/i);
  assert.match(migrations[7].sql, /request_digest TEXT NOT NULL/i);
  assert.match(migrations[7].sql, /receipt_encrypted TEXT/i);
  assert.match(migrations[7].sql, /deleted_at BIGINT/i);
  assert.match(migrations[7].sql, /CREATE INDEX IF NOT EXISTS publish_operations_result_share_idx/i);
  assert.doesNotMatch(migrations[7].sql, /REFERENCES public\.pages/i,
    { message: 'operation records must be independent of the pages lifecycle' });
  // #34: purge tombstones. The snapshot payload and its hash go NULL together
  // with the recorded purge moment; publish_operations gains the companion
  // receipt-purge timestamp. deleted_at stays the whole-Share marker.
  assert.match(migrations[8].sql, /ALTER TABLE public\.share_revisions/i);
  assert.match(migrations[8].sql, /ADD COLUMN purged_at BIGINT/i);
  assert.match(migrations[8].sql, /ALTER TABLE public\.publish_operations/i);
  assert.match(migrations[8].sql, /ADD COLUMN purged_at BIGINT/i);
  assert.doesNotMatch(migrations[8].sql, /DROP COLUMN|DROP TABLE|ADD CONSTRAINT|SET NOT NULL/i,
    'purge migration stays additive: no payload drop at migration time, no backfill lock');
});

// #32 boundary: migrations 001-007 are accepted history; this ticket may
// only add 008. Their bytes are pinned so any accidental touch fails here.
test('accepted migrations 001-007 keep their recorded byte identity', () => {
  const { createHash } = require('node:crypto');
  const migrations = loadMigrations();
  const recordedChecksums = {
    '001_baseline.sql': 'cc3f6b15aacc440d347137cbf545a67a56cff24f5bff9d3a4ddc156e01758864',
    '002_site_settings.sql': 'cbd1bcc11c4a9c158e6a4c6a9f94f07ba6f809e844b8dc38afd1bd286087ba57',
    '003_page_favorites.sql': 'b3780fb75edd16e556868a7f4d0043f587c5a47122cbc81f558d9969dbc4df7e',
    '004_page_access_revision.sql': 'b6d0c91f4bb0647a7138260314a9884de28b8e4a07f058eeb7a3ebaace42bc07',
    '005_publishing_writes_paused.sql': '295b7667dee2662094b63542650dcbb815daf457a8a3b21f4f7f46b662895031',
    '006_api_key_credential_version.sql': 'e935ff208dfdf297d61659ac61b72f2bdbc4973a6f5872c175e088791d050ac3',
    '007_share_revisions.sql': 'c34867fb0c303d832ec9a77e0adcb25639defc4d6a5fb2621c90f978d4018810'
  };

  for (const migration of migrations) {
    const expected = recordedChecksums[migration.name];
    if (!expected) continue; // 008 and later are owned by their own tickets.
    assert.equal(
      createHash('sha256').update(migration.sql).digest('hex'),
      expected,
      `${migration.name} must stay byte-identical`
    );
  }
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

  assert.deepEqual(first, { applied: ['001', '002', '003', '004', '005', '006', '007', '008', '009'], skipped: [] });
  assert.deepEqual(second, { applied: [], skipped: ['001', '002', '003', '004', '005', '006', '007', '008', '009'] });
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
