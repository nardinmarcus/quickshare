#!/usr/bin/env node
// One-off production release verification (read-only).
// Prints the migration ledger, key schema-shape checks from
// docs/deployment.md step 4, and row counts. Exits 1 on any failed check.
require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');

const connectionString = process.env.DATABASE_MIGRATION_URL
  || process.env.DATABASE_URL_UNPOOLED
  || process.env.POSTGRES_URL_NON_POOLING
  || process.env.DATABASE_URL
  || process.env.POSTGRES_URL;

if (!connectionString) {
  console.error('[release-check] no database URL configured');
  process.exit(1);
}

const EXPECTED_LEDGER = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'];

async function main() {
  const pool = createPostgresPool(connectionString, { max: 1 });
  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };
  try {
    const ledger = await pool.query(
      'SELECT version FROM public.quickshare_schema_migrations ORDER BY version ASC'
    );
    const versions = ledger.rows.map((r) => String(r.version).padStart(3, '0'));
    console.log(`ledger: ${versions.join(',') || '(empty)'}`);
    check('ledger is exactly 001-010', JSON.stringify(versions) === JSON.stringify(EXPECTED_LEDGER));

    const col = async (table, column) => {
      const r = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
        [table, column]
      );
      return r.rows[0] || null;
    };
    const expectCol = async (table, column, type, nullable) => {
      const c = await col(table, column);
      check(
        `${table}.${column}`,
        !!c && c.data_type === type && (nullable === undefined || c.is_nullable === (nullable ? 'YES' : 'NO')),
        c ? `${c.data_type} nullable=${c.is_nullable}` : 'missing'
      );
    };

    await expectCol('pages', 'access_revision', 'bigint', false);
    await expectCol('pages', 'current_revision', 'bigint', true);
    await expectCol('pages', 'published', 'boolean', false);
    await expectCol('pages', 'is_favorite', 'boolean', false);
    await expectCol('api_keys', 'credential_version', 'bigint', false);
    const scopes = await col('api_keys', 'scopes');
    check('api_keys.scopes exists', !!scopes, scopes ? scopes.data_type : 'missing');
    const autoGrant = await col('api_keys', 'auto_grant_new_share_edit');
    check('api_keys.auto_grant_new_share_edit exists', !!autoGrant, autoGrant ? autoGrant.data_type : 'missing');
    await expectCol('site_settings', 'publishing_writes_paused', 'boolean', false);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1)`,
      [['pages', 'audit_logs', 'api_keys', 'site_settings', 'share_revisions', 'publish_operations', 'share_grants']]
    );
    const existing = new Set(tables.rows.map((r) => r.table_name));
    check('all 7 application tables exist', existing.size === 7, `found ${existing.size}`);

    const pkOf = async (table) => {
      const r = await pool.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary
          ORDER BY a.attname`,
        [`public.${table}`]
      );
      return r.rows.map((row) => row.attname);
    };
    if (existing.has('share_grants')) {
      const pk = await pkOf('share_grants');
      check('share_grants PK is (api_key_id, share_id)',
        JSON.stringify(pk) === JSON.stringify(['api_key_id', 'share_id']), pk.join(','));
    } else {
      check('share_grants PK is (api_key_id, share_id)', false, 'table missing');
    }
    if (existing.has('publish_operations')) {
      const pk = await pkOf('publish_operations');
      check('publish_operations PK is (actor_namespace, request_id)',
        JSON.stringify(pk) === JSON.stringify(['actor_namespace', 'request_id']), pk.join(','));
    } else {
      check('publish_operations PK is (actor_namespace, request_id)', false, 'table missing');
    }

    const pausedCol = await col('site_settings', 'publishing_writes_paused');
    if (pausedCol) {
      const settings = await pool.query('SELECT id, publishing_writes_paused FROM public.site_settings WHERE id = 1');
      check('site_settings id=1 exists', settings.rows.length === 1,
        settings.rows.length ? `paused=${settings.rows[0].publishing_writes_paused}` : 'missing');
    } else {
      check('site_settings id=1 exists', false, 'publishing_writes_paused column missing');
    }

    for (const t of ['pages', 'share_revisions', 'api_keys', 'share_grants', 'publish_operations', 'audit_logs']) {
      if (!existing.has(t)) {
        console.log(`count ${t}: (table missing)`);
        continue;
      }
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM public.${t}`);
      console.log(`count ${t}: ${c.rows[0].n}`);
    }
    if (await col('pages', 'current_revision')) {
      const nullRev = await pool.query('SELECT COUNT(*)::int AS n FROM public.pages WHERE current_revision IS NULL');
      console.log(`pages with current_revision NULL (awaiting baseline): ${nullRev.rows[0].n}`);
    } else {
      console.log('pages with current_revision NULL: (column missing)');
    }

    if (failures.length) {
      console.error(`[release-check] ${failures.length} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log('[release-check] all checks passed');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[release-check] failed: ${error.message}`);
  process.exit(1);
});
