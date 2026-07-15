const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');

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

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_POOL_MAX: '1',
  POSTGRES_CONNECTION_TIMEOUT_MS: '500',
  POSTGRES_STATEMENT_TIMEOUT_MS: '1000',
  POSTGRES_QUERY_TIMEOUT_MS: '1200'
};

async function resetPublicSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

test('baseline migration handles empty and legacy databases idempotently', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });

  try {
    await resetPublicSchema(pool);
    const emptyResult = await runMigrations(pool, { logger: { info() {} } });
    assert.deepEqual(emptyResult, { applied: ['001'], skipped: [] });

    const emptyTables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    assert.deepEqual(emptyTables.rows.map(row => row.table_name), [
      'api_keys',
      'audit_logs',
      'pages',
      'quickshare_schema_migrations'
    ]);

    await resetPublicSchema(pool);
    await pool.query(`
      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        html_content TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        password_hash TEXT,
        is_protected INTEGER DEFAULT 0,
        code_type TEXT DEFAULT 'html',
        title TEXT,
        description TEXT,
        expires_at BIGINT
      )
    `);
    await pool.query(
      'INSERT INTO pages (id, html_content, created_at, title) VALUES ($1, $2, $3, $4)',
      ['sentinel', '<h1>Keep me</h1>', 1234, 'Sentinel']
    );

    const legacyResult = await runMigrations(pool, { logger: { info() {} } });
    const repeatedResult = await runMigrations(pool, { logger: { info() {} } });
    const sentinel = await pool.query(
      'SELECT id, html_content, created_at, title, view_count FROM pages WHERE id = $1',
      ['sentinel']
    );
    const migrationCount = await pool.query('SELECT COUNT(*)::int AS count FROM quickshare_schema_migrations');

    assert.deepEqual(legacyResult, { applied: ['001'], skipped: [] });
    assert.deepEqual(repeatedResult, { applied: [], skipped: ['001'] });
    assert.deepEqual(sentinel.rows, [{
      id: 'sentinel',
      html_content: '<h1>Keep me</h1>',
      created_at: '1234',
      title: 'Sentinel',
      view_count: '0'
    }]);
    assert.equal(migrationCount.rows[0].count, 1);
  } finally {
    await pool.end();
  }
});

test('incompatible legacy schema rolls back the migration transaction', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });

  try {
    await resetPublicSchema(pool);
    await pool.query('CREATE TABLE pages (id INTEGER PRIMARY KEY, html_content TEXT, created_at BIGINT)');

    await assert.rejects(
      runMigrations(pool, { logger: { info() {} } }),
      /incompatible quickshare schema/i
    );

    const migrationTable = await pool.query("SELECT to_regclass('public.quickshare_schema_migrations') AS name");
    const idType = await pool.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pages' AND column_name = 'id'
    `);

    assert.equal(migrationTable.rows[0].name, null);
    assert.equal(idType.rows[0].data_type, 'integer');
  } finally {
    await pool.end();
  }
});

test('baseline migration rejects incompatible optional and existing table columns', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const incompatibleSchemas = [
    {
      name: 'pages optional column',
      sql: `
        CREATE TABLE pages (
          id TEXT PRIMARY KEY,
          html_content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          view_count TEXT
        )
      `
    },
    {
      name: 'audit_logs required column',
      sql: `
        CREATE TABLE audit_logs (
          id SERIAL PRIMARY KEY,
          action TEXT NOT NULL,
          page_id TEXT,
          details TEXT,
          created_at BIGINT NOT NULL
        )
      `
    },
    {
      name: 'api_keys primary key type',
      sql: `
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          last_used_at BIGINT
        )
      `
    }
  ];

  try {
    for (const schema of incompatibleSchemas) {
      await resetPublicSchema(pool);
      await pool.query(schema.sql);

      await assert.rejects(
        runMigrations(pool, { logger: { info() {} } }),
        /incompatible quickshare schema/i,
        schema.name
      );

      const migrationTable = await pool.query(
        "SELECT to_regclass('public.quickshare_schema_migrations') AS name"
      );
      assert.equal(migrationTable.rows[0].name, null, schema.name);
    }
  } finally {
    await pool.end();
  }
});

test('statement timeout fails well below the Vercel function budget', async () => {
  const pool = createPostgresPool(connectionString, {
    env: {
      ...env,
      POSTGRES_STATEMENT_TIMEOUT_MS: '300',
      POSTGRES_QUERY_TIMEOUT_MS: '500'
    },
    max: 1
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(pool.query('SELECT pg_sleep(2)'), /statement timeout|canceling statement/i);
    assert.equal(Date.now() - startedAt < 1000, true);
  } finally {
    await pool.end();
  }
});

test('view events atomically enforce page availability without loading content', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    await pool.query(
      `
        INSERT INTO pages (id, html_content, created_at, is_protected, expires_at)
        VALUES
          ('active', '<h1>Active</h1>', 1, 0, NULL),
          ('protected', '<h1>Protected</h1>', 1, 1, NULL),
          ('expired', '<h1>Expired</h1>', 1, 0, 5000)
      `
    );

    assert.equal(await repository.recordViewEvent('active', 5000, false), 'counted');
    assert.equal(await repository.recordViewEvent('protected', 5000, false), 'protected');
    assert.equal(await repository.recordViewEvent('protected', 5000, true), 'counted');
    assert.equal(await repository.recordViewEvent('expired', 5000, false), 'expired');
    assert.equal(await repository.recordViewEvent('missing', 5000, false), 'not_found');

    const counts = await pool.query('SELECT id, view_count FROM pages ORDER BY id');
    assert.deepEqual(counts.rows, [
      { id: 'active', view_count: '1' },
      { id: 'expired', view_count: '0' },
      { id: 'protected', view_count: '1' }
    ]);
  } finally {
    await pool.end();
  }
});
