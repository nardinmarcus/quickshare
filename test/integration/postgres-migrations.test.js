const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations, loadMigrations } = require('../../models/postgres-migrations');
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

test('Share access conditional writes and view events serialize across independent PostgreSQL connections', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 2 });
  const repo = Object.create(PostgresPageRepository.prototype);
  repo.pool = pool;
  let locker;
  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    const a = await pool.connect();
    const b = await pool.connect();
    assert.notEqual((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    a.release(); b.release();
    for (const id of ['race', 'other']) await repo.create({ id, htmlContent: 'ORIGINAL', createdAt: 1, isProtected: true, passwordHash: 'old-hash' });
    const results = await Promise.allSettled(['winner-a', 'winner-b'].map(htmlContent => repo.updatePage('race', {
      htmlContent, revokeAccess: true, expectedAccessRevision: '1', expectedContentRevision: '1'
    })));
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value === true).length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 412).length, 1);
    const winner = results.findIndex(r => r.status === 'fulfilled');
    const stored = await repo.getById('race');
    assert.equal(stored.html_content, ['winner-a', 'winner-b'][winner]);
    assert.equal(stored.access_revision, '2');
    assert.equal(stored.current_revision, '2', 'the content winner advanced the revision exactly once');
    assert.equal((await repo.getById('other')).access_revision, '1');
    await assert.rejects(repo.updatePage('race', { htmlContent: 'MUST NOT SAVE', expiresAt: 9000 }), { status: 428 });
    assert.equal((await repo.getById('race')).html_content, stored.html_content);

    // One connection commits revocation while the other is blocked in its conditional UPDATE.
    locker = await pool.connect();
    await locker.query('BEGIN');
    await locker.query("UPDATE pages SET access_revision = access_revision + 1 WHERE id = 'race'");
    const event = repo.recordViewEvent('race', 5000, '2');
    let waiting = false;
    for (let i = 0; i < 100; i += 1) {
      // Activity statistics are cached within this transaction; observe the live waiter.
      await locker.query('SELECT pg_stat_clear_snapshot()');
      const activity = await locker.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%SET view_count%'");
      if (activity.rows[0].count > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await locker.query('COMMIT');
    locker.release(); locker = null;
    assert.equal(await event, 'protected');
    assert.equal(waiting, true, 'second backend must actually wait on the policy writer');
    assert.equal((await repo.getById('race')).view_count, '0');
    assert.equal(await repo.recordViewEvent('race', 5000, '3'), 'counted');
    assert.equal(await repo.recordViewEvent('other', 5000, '1'), 'counted');
    // BIGINT survives the JS safe-integer boundary unchanged.
    await pool.query("UPDATE pages SET access_revision = 9007199254740993 WHERE id = 'race'");
    await repo.updatePage('race', { revokeAccess: true, expectedAccessRevision: '9007199254740993' });
    assert.equal((await repo.getById('race')).access_revision, '9007199254740994');
    const unchanged = await repo.updatePage('race', { returnUpdated: true });
    assert.equal(unchanged.access_revision, '9007199254740994');
    assert.equal(unchanged.html_content, stored.html_content);
    const samePolicy = await repo.updatePage('race', { expiresAt: null, expectedAccessRevision: unchanged.access_revision, returnUpdated: true });
    assert.equal(samePolicy.access_revision, unchanged.access_revision);
  } finally {
    if (locker) { await locker.query('ROLLBACK'); locker.release(); }
    await pool.end();
  }
});

test('baseline migration handles empty and legacy databases idempotently', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });

  try {
    await resetPublicSchema(pool);
    const emptyResult = await runMigrations(pool, { logger: { info() {} } });
    assert.deepEqual(emptyResult, { applied: ['001', '002', '003', '004', '005', '006', '007', '008', '009'], skipped: [] });

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
      'publish_operations',
      'quickshare_schema_migrations',
      'share_revisions',
      'site_settings'
    ]);

    const defaultSettings = await pool.query(
      'SELECT id, homepage_password_required, publishing_writes_paused FROM site_settings'
    );
    assert.deepEqual(defaultSettings.rows, [{
      id: 1,
      homepage_password_required: true,
      publishing_writes_paused: false
    }]);
    const favoriteColumn = await pool.query(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pages'
        AND column_name = 'is_favorite'
    `);
    assert.deepEqual(favoriteColumn.rows, [{
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false'
    }]);

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
    const migratedSentinel = await pool.query(
      'SELECT id, html_content, created_at, title, view_count, is_favorite FROM pages WHERE id = $1',
      ['sentinel']
    );
    await pool.query('UPDATE pages SET is_favorite = TRUE WHERE id = $1', ['sentinel']);
    const repeatedResult = await runMigrations(pool, { logger: { info() {} } });
    const repeatedSentinel = await pool.query(
      'SELECT is_favorite FROM pages WHERE id = $1',
      ['sentinel']
    );
    const migrationCount = await pool.query('SELECT COUNT(*)::int AS count FROM quickshare_schema_migrations');

    assert.deepEqual(legacyResult, { applied: ['001', '002', '003', '004', '005', '006', '007', '008', '009'], skipped: [] });
    assert.deepEqual(repeatedResult, { applied: [], skipped: ['001', '002', '003', '004', '005', '006', '007', '008', '009'] });
    assert.deepEqual(migratedSentinel.rows, [{
      id: 'sentinel',
      html_content: '<h1>Keep me</h1>',
      created_at: '1234',
      title: 'Sentinel',
      view_count: '0',
      is_favorite: false
    }]);
    assert.deepEqual(repeatedSentinel.rows, [{ is_favorite: true }]);
    assert.equal(migrationCount.rows[0].count, 9);
    const accessColumn = await pool.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'access_revision'");
    assert.deepEqual(accessColumn.rows, [{ data_type: 'bigint', is_nullable: 'NO', column_default: '1' }]);
    assert.equal((await pool.query("SELECT access_revision FROM pages WHERE id = 'sentinel'")).rows[0].access_revision, '1');
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

test('site settings migration rejects an unexpected existing table', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });

  try {
    await resetPublicSchema(pool);
    await pool.query(`
      CREATE TABLE site_settings (
        id SMALLINT PRIMARY KEY,
        homepage_password_required BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at BIGINT NOT NULL
      )
    `);

    await assert.rejects(
      runMigrations(pool, { logger: { info() {} } }),
      /relation "site_settings" already exists/i
    );

    const migrationTable = await pool.query(
      "SELECT to_regclass('public.quickshare_schema_migrations') AS name"
    );
    assert.equal(migrationTable.rows[0].name, null);
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
    assert.equal(await repository.recordViewEvent('protected', 5000, '1'), 'counted');
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

test('Postgres favorite mutation persists transitions and preserves idempotency', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    await repository.create({
      id: 'favorite-postgres',
      htmlContent: '<h1>Postgres favorite</h1>',
      createdAt: 1000
    });

    assert.equal((await repository.getById('favorite-postgres')).is_favorite, false);
    assert.deepEqual(await repository.setFavorite('favorite-postgres', true), {
      found: true,
      changed: true,
      isFavorite: true,
      previousValue: false
    });
    assert.deepEqual(await repository.setFavorite('favorite-postgres', true), {
      found: true,
      changed: false,
      isFavorite: true,
      previousValue: true
    });
    assert.deepEqual(await repository.setFavorite('favorite-postgres', false), {
      found: true,
      changed: true,
      isFavorite: false,
      previousValue: true
    });
    assert.deepEqual(await repository.setFavorite('missing-postgres', true), {
      found: false,
      changed: false,
      isFavorite: false,
      previousValue: null
    });
  } finally {
    await pool.end();
  }
});

test('Postgres Favorite Shares combine with every admin list condition and aligned counts', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    const fixtures = [
      ['favorite-filter-match', 'Quarterly Favorite Match', 'markdown', true, '2026-07-10T12:00:00Z', true],
      ['favorite-filter-html', 'Quarterly Favorite HTML', 'html', true, '2026-07-11T12:00:00Z', true],
      ['favorite-filter-public', 'Quarterly Favorite Public', 'markdown', false, '2026-07-12T12:00:00Z', true],
      ['favorite-filter-unmarked', 'Quarterly Unmarked Match', 'markdown', true, '2026-07-13T12:00:00Z', false],
      ['favorite-filter-old', 'Quarterly Favorite Old', 'markdown', true, '2026-06-30T12:00:00Z', true]
    ];

    for (const [id, title, codeType, isProtected, date, favorite] of fixtures) {
      await repository.create({
        id,
        htmlContent: '# Postgres favorite filter fixture',
        title,
        codeType,
        isProtected,
        createdAt: Date.parse(date)
      });
      if (favorite) await repository.setFavorite(id, true);
    }

    const filters = {
      search: 'Quarterly',
      codeType: 'markdown',
      isProtected: 'protected',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      isFavorite: true
    };
    const pages = await repository.listAdminPages(filters);

    assert.deepEqual(pages.map(page => page.id), ['favorite-filter-match']);
    assert.equal(pages[0].is_favorite, true);
    assert.equal(await repository.countPages(filters), 1);
  } finally {
    await pool.end();
  }
});

test('Postgres Favorite Share lifecycle preserves admin state and public boundaries', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    await repository.create({
      id: 'favorite-lifecycle-source',
      htmlContent: '<h1>Favorite lifecycle source</h1>',
      createdAt: 1000,
      title: 'Favorite lifecycle source',
      isFavorite: true
    });

    assert.equal((await repository.getById('favorite-lifecycle-source')).is_favorite, false);
    await repository.setFavorite('favorite-lifecycle-source', true);
    await repository.updatePage('favorite-lifecycle-source', {
      expectedAccessRevision: '1',
      expectedContentRevision: '1',
      title: 'Edited favorite lifecycle source',
      description: 'Still managed after expiry',
      htmlContent: '<h1>Edited favorite lifecycle source</h1>',
      expiresAt: 5000,
      isProtected: true,
      passwordHash: 'password-hash',
      encryptedPassword: 'encrypted-password'
    });

    const updatedSource = await repository.getById('favorite-lifecycle-source');
    const publicLookup = await repository.getPublicById('favorite-lifecycle-source', 5000);

    assert.equal(updatedSource.is_favorite, true);
    assert.equal(updatedSource.expires_at, '5000');
    assert.equal(updatedSource.is_protected, 1);
    assert.equal(publicLookup.expired, true);
    assert.equal(Object.hasOwn(publicLookup.page, 'is_favorite'), false);
    assert.equal((await repository.setFavorite('favorite-lifecycle-source', false)).isFavorite, false);
    assert.equal((await repository.setFavorite('favorite-lifecycle-source', true)).isFavorite, true);

    await repository.create({
      id: 'favorite-lifecycle-clone',
      htmlContent: updatedSource.html_content,
      passwordHash: null,
      encryptedPassword: null,
      isProtected: false,
      codeType: updatedSource.code_type,
      title: `${updatedSource.title} (Copy)`,
      description: updatedSource.description,
      createdAt: 2000,
      expiresAt: null,
      markdownTheme: updatedSource.markdown_theme
    });
    await pool.query(`
      INSERT INTO pages (id, html_content, created_at)
      SELECT 'favorite-export-' || number, '<p>Export boundary</p>', 2000 + number
      FROM generate_series(1, 51) AS generated(number)
    `);

    const adminPages = await repository.listAdminPages({ limit: null });
    const adminSource = adminPages.find(page => page.id === 'favorite-lifecycle-source');
    const adminClone = adminPages.find(page => page.id === 'favorite-lifecycle-clone');

    assert.equal(adminPages.length, 53);
    assert.equal(adminSource.is_favorite, true);
    assert.equal(adminSource.expires_at, '5000');
    assert.equal(adminClone.is_favorite, false);

    assert.equal(await repository.deletePage('favorite-lifecycle-source'), true);
    assert.equal(await repository.getById('favorite-lifecycle-source'), null);
    assert.deepEqual(await repository.setFavorite('favorite-lifecycle-source', true), {
      found: false,
      changed: false,
      isFavorite: false,
      previousValue: null
    });
    assert.equal(
      (await repository.listAdminPages({ limit: null }))
        .some(page => page.id === 'favorite-lifecycle-source'),
      false
    );
  } finally {
    await pool.end();
  }
});

test('site settings persist real transitions and audit them exactly once', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });

    assert.equal(await repository.getHomepagePasswordRequired(), true);

    const changed = await repository.setHomepagePasswordRequired({
      passwordRequired: false,
      ip: '203.0.113.21'
    });
    const unchanged = await repository.setHomepagePasswordRequired({
      passwordRequired: false,
      ip: '203.0.113.22'
    });

    assert.deepEqual(changed, { passwordRequired: false, changed: true });
    assert.deepEqual(unchanged, { passwordRequired: false, changed: false });
    assert.equal(await repository.getHomepagePasswordRequired(), false);

    const repeatedMigration = await runMigrations(pool, { logger: { info() {} } });
    assert.deepEqual(repeatedMigration, { applied: [], skipped: ['001', '002', '003', '004', '005', '006', '007', '008', '009'] });
    assert.equal(await repository.getHomepagePasswordRequired(), false);

    const logs = await repository.listAuditLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'settings.homepage_password_required.update');
    assert.deepEqual(JSON.parse(logs[0].details), { from: true, to: false });
    assert.equal(logs[0].ip, '203.0.113.21');
  } finally {
    await pool.end();
  }
});

test('site setting changes roll back when the audit record cannot be written', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 1 });
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = pool;

  try {
    await resetPublicSchema(pool);
    await runMigrations(pool, { logger: { info() {} } });
    await pool.query(`
      ALTER TABLE audit_logs
      ADD CONSTRAINT reject_homepage_setting_audit
      CHECK (action <> 'settings.homepage_password_required.update')
    `);

    await assert.rejects(
      repository.setHomepagePasswordRequired({
        passwordRequired: false,
        ip: '203.0.113.23'
      }),
      /reject_homepage_setting_audit/
    );

    assert.equal(await repository.getHomepagePasswordRequired(), true);
    assert.equal(await repository.countAuditLogs(), 0);
  } finally {
    await pool.query(
      'ALTER TABLE IF EXISTS audit_logs DROP CONSTRAINT IF EXISTS reject_homepage_setting_audit'
    ).catch(() => {});
    await pool.end();
  }
});

test('share revision expansion upgrades a legacy two-phase database and repeats skipped', async () => {
  const pool = createPostgresPool(connectionString, { env, max: 2 });
  const localPoolEnv = { POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '2' };

  try {
    await resetPublicSchema(pool);
    // Phase 1: build a genuine pre-007 deployment state — schema and ledger
    // exactly at 001–006, then rows written by the old version.
    await runMigrations(pool, { logger: { info() {} } });
    await pool.query('DROP TABLE public.share_revisions');
    await pool.query('ALTER TABLE public.pages DROP COLUMN current_revision, DROP COLUMN published');
    await pool.query("DELETE FROM public.quickshare_schema_migrations WHERE version = '007'");
    await pool.query(
      `INSERT INTO pages (id, html_content, created_at, code_type, title, description, markdown_theme)
       VALUES ($1, $2, $3, 'markdown', $4, $5, 'github')`,
      ['issue30-legacy', '<h1>Legacy body</h1>', 777, 'Legacy title', 'Legacy description']
    );
    await pool.query(
      `INSERT INTO pages (id, html_content, created_at, code_type) VALUES ($1, $2, $3, 'html')`,
      ['issue30-legacy-plain', '<p>plain</p>', 778]
    );

    // Phase 2: the additive expansion applies; existing rows receive the
    // defaults without touching IDs, URLs, bodies or policy.
    const result = await runMigrations(pool, { logger: { info() {} } });
    assert.deepEqual(result, {
      applied: ['007'],
      skipped: ['001', '002', '003', '004', '005', '006', '008', '009']
    });

    const defaults = await pool.query(
      `SELECT id, current_revision, published FROM pages ORDER BY id`
    );
    assert.deepEqual(defaults.rows, [
      { id: 'issue30-legacy', current_revision: '1', published: true },
      { id: 'issue30-legacy-plain', current_revision: '1', published: true }
    ]);

    const revisionTable = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'share_revisions'
      ORDER BY column_name
    `);
    assert.deepEqual(revisionTable.rows.map(row => [row.column_name, row.data_type, row.is_nullable]), [
      ['actor', 'text', 'YES'],
      ['code_type', 'text', 'NO'],
      ['created_at', 'bigint', 'NO'],
      ['description', 'text', 'YES'],
      ['html_content', 'text', 'NO'],
      ['markdown_theme', 'text', 'YES'],
      ['restored_from', 'bigint', 'YES'],
      ['revision', 'bigint', 'NO'],
      ['share_id', 'text', 'NO'],
      ['snapshot_hash', 'text', 'NO'],
      ['source', 'text', 'NO'],
      ['title', 'text', 'YES']
    ]);

    // The controlled baseline backfill (separate from the migration runner)
    // completes the two-phase flow; a second run reports nothing to do.
    const repository = new PostgresPageRepository(connectionString, {
      ...localPoolEnv,
      POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000'
    });
    const { runBackfill } = require('../../scripts/backfill-page-revisions');
    await repository.setPublishingWritesPaused(true);
    const first = await runBackfill(repository, { write: true, limit: 10 });
    assert.equal(first.backfilled, 2);
    const second = await runBackfill(repository, { write: true, limit: 10 });
    assert.equal(second.scanned, 0, 'repeat baseline run must be all skipped');

    const baseline = await repository.listContentRevisions('issue30-legacy');
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].html_content, '<h1>Legacy body</h1>');
    assert.equal(baseline[0].code_type, 'markdown');
    assert.equal(baseline[0].title, 'Legacy title');
    assert.equal(baseline[0].markdown_theme, 'github');
    // The baseline stamps the actual capture moment, not the Share creation
    // time (777), and carries row-level provenance.
    assert.ok(Number(baseline[0].created_at) >= 777 + 500, `baseline created_at must be the capture moment, got ${baseline[0].created_at}`);
    assert.equal(baseline[0].source, 'baseline-backfill');
    assert.equal(baseline[0].actor, 'maintenance:baseline-backfill');
    assert.equal(baseline[0].restored_from, null);
    assert.equal((await repository.getById('issue30-legacy')).current_revision, '1');

    // Deleting a Share removes its snapshots with it (ON DELETE CASCADE).
    await repository.deletePage('issue30-legacy-plain');
    const orphaned = await pool.query(
      'SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1',
      ['issue30-legacy-plain']
    );
    assert.equal(orphaned.rows[0].n, 0, 'revision payload never outlives its Share');

    const repeat = await runMigrations(pool, { logger: { info() {} } });
    assert.deepEqual(repeat, { applied: [], skipped: ['001', '002', '003', '004', '005', '006', '007', '008', '009'] });
    await repository.pool.end();
  } finally {
    await pool.end();
  }
});
