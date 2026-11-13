const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const {
  setPublishingWritesPaused,
  withPublishingWrite
} = require('../../models/publishing');
const {
  MAINTENANCE_GATE_LOCK_KEY,
  isPublishingPausedError
} = require('../../utils/publishing');

// Publishing write maintenance against real Postgres (T04, issue #28).
// The drain/race guarantees rest on transaction-scoped advisory locks, so
// they are proven here with (at least) two independent connections, never
// with two queries multiplexed over one client.
//
// This file uses its own `quickshare_maintenance_test` database, created
// and dropped by the file itself, so it cannot interfere with the schema
// resets in postgres-migrations.test.js or the backup drill databases.

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

const MAINTENANCE_DB = 'quickshare_maintenance_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const maintenanceUrl = serverBaseUrl(MAINTENANCE_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let adminPool;
let repository;

async function resetState() {
  await repository.pool.query('DELETE FROM public.pages');
  await repository.pool.query('DELETE FROM public.audit_logs');
  await repository.pool.query('DELETE FROM public.api_keys');
  await repository.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

async function seedPage(id) {
  await repository.pool.query(
    `INSERT INTO public.pages (id, html_content, created_at, is_protected, code_type, title)
     VALUES ($1, $2, $3, 0, 'html', $1)`,
    [id, `<h1>${id}</h1>`, Date.now()]
  );
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${MAINTENANCE_DB}`);
  await adminPool.query(`CREATE DATABASE ${MAINTENANCE_DB}`);

  repository = new PostgresPageRepository(maintenanceUrl, env);
  await runMigrations(repository.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repository.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${MAINTENANCE_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('pause refuses repository writes, keeps reads, and resume restores publishing', async () => {
  assert.equal(await repository.getPublishingWritesPaused(), false);

  await repository.create({
    id: 'pg-maint-page',
    htmlContent: '<p>body</p>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Page',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
  assert.equal(
    await repository.recordViewEvent('pg-maint-page', Date.now(), false),
    'counted'
  );

  const paused = await repository.setPublishingWritesPaused({ paused: true, ip: '203.0.113.60' });
  assert.deepEqual(paused, { paused: true, changed: true });
  assert.equal(await repository.getPublishingWritesPaused(), true);

  const toggleLogs = (await repository.listAuditLogs())
    .filter(log => log.action === 'settings.publishing_writes_paused.update');
  assert.equal(toggleLogs.length, 1);
  assert.deepEqual(JSON.parse(toggleLogs[0].details), { from: false, to: true });

  await assert.rejects(
    repository.create({
      id: 'pg-maint-refused',
      htmlContent: 'x',
      createdAt: Date.now()
    }),
    error => isPublishingPausedError(error)
  );
  await assert.rejects(
    repository.updatePageWithAccessPolicy('pg-maint-page', { title: 'Nope' }, {}),
    error => isPublishingPausedError(error)
  );
  await assert.rejects(
    repository.deletePage('pg-maint-page'),
    error => isPublishingPausedError(error)
  );
  await assert.rejects(
    repository.setHomepagePasswordRequired({ passwordRequired: false, ip: '203.0.113.61' }),
    error => isPublishingPausedError(error)
  );

  // View events are not counted during maintenance; reads keep working.
  assert.equal(
    await repository.recordViewEvent('pg-maint-page', Date.now(), false),
    'maintenance'
  );
  const page = await repository.getById('pg-maint-page');
  assert.equal(Number(page.view_count), 1);
  assert.equal(page.title, 'Page');
  assert.equal(await repository.getById('pg-maint-refused'), null);

  const repeated = await repository.setPublishingWritesPaused({ paused: true, ip: '203.0.113.62' });
  assert.deepEqual(repeated, { paused: true, changed: false });

  const resumed = await repository.setPublishingWritesPaused({ paused: false, ip: '203.0.113.63' });
  assert.deepEqual(resumed, { paused: false, changed: true });
  await repository.create({
    id: 'pg-maint-refused',
    htmlContent: 'x',
    createdAt: Date.now()
  });
  assert.ok(await repository.getById('pg-maint-refused'));
});

test('pause drains an in-flight publishing transaction on another connection before returning', async () => {
  const writerPool = createPostgresPool(maintenanceUrl, { env, max: 1 });
  const togglePool = createPostgresPool(maintenanceUrl, { env, max: 1 });
  // A third connection purely as an observer: querying through togglePool
  // would queue behind the toggle's own lock wait and prove nothing.
  const observerPool = createPostgresPool(maintenanceUrl, { env, max: 1 });
  const events = [];

  try {
    const write = withPublishingWrite(writerPool, async (client) => {
      await client.query(
        `INSERT INTO public.pages (id, html_content, created_at, is_protected, code_type, title)
         VALUES ('drain-share', '<p>drain</p>', $1, 0, 'html', 'drain-share')`,
        [Date.now()]
      );
      events.push('write:inserted-uncommitted');
      await sleep(500);
      events.push('write:finishing');
    }).then(() => { events.push('write:committed'); });

    // Give the writer time to take the shared gate lock and insert.
    await sleep(150);

    let pauseReturned = false;
    const pause = setPublishingWritesPaused(togglePool, { paused: true, ip: 'drain-test' })
      .then((result) => {
        pauseReturned = true;
        events.push('pause:returned');
        return result;
      });

    await sleep(150);
    assert.equal(pauseReturned, false, 'pause must wait for the in-flight write to drain');
    // The uncommitted insert is invisible to the observer connection.
    const duringDrain = await observerPool.query(
      "SELECT COUNT(*)::int AS count FROM public.pages WHERE id = 'drain-share'"
    );
    assert.equal(duringDrain.rows[0].count, 0);

    await write;
    const pauseResult = await pause;
    assert.equal(pauseReturned, true);
    assert.deepEqual(pauseResult, { paused: true, changed: true });
    assert.deepEqual(events, [
      'write:inserted-uncommitted',
      'write:finishing',
      'write:committed',
      'pause:returned'
    ]);

    // The drained write really committed before the pause landed.
    const afterPause = await observerPool.query(
      "SELECT COUNT(*)::int AS count FROM public.pages WHERE id = 'drain-share'"
    );
    assert.equal(afterPause.rows[0].count, 1);

    // And after the pause returned, new writes are refused.
    await assert.rejects(
      repository.create({ id: 'after-pause', htmlContent: 'x', createdAt: Date.now() }),
      error => isPublishingPausedError(error)
    );
  } finally {
    await setPublishingWritesPaused(togglePool, { paused: false, ip: 'drain-cleanup' }).catch(() => {});
    await writerPool.end();
    await togglePool.end();
    await observerPool.end();
  }
});

test('a writer queued behind the exclusive gate cannot commit once the pause lands', async () => {
  const gatePool = createPostgresPool(maintenanceUrl, { env, max: 1 });
  const gateClient = await gatePool.connect();

  try {
    // Simulate the toggle mid-flight: exclusive gate held, flag not yet set.
    await gateClient.query('BEGIN');
    await gateClient.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [MAINTENANCE_GATE_LOCK_KEY]
    );

    let createSettled = false;
    const create = repository.create({
      id: 'queued-share',
      htmlContent: '<p>queued</p>',
      createdAt: Date.now()
    }).then(
      () => { createSettled = true; return { ok: true }; },
      (error) => { createSettled = true; return { ok: false, error }; }
    );

    await sleep(200);
    assert.equal(createSettled, false, 'the writer must block behind the exclusive gate');

    // The toggle now sets the flag and commits.
    await gateClient.query(
      'UPDATE public.site_settings SET publishing_writes_paused = true WHERE id = 1'
    );
    await gateClient.query('COMMIT');

    const result = await create;
    assert.equal(result.ok, false, 'the queued writer must be refused, not committed');
    assert.ok(isPublishingPausedError(result.error));
    assert.equal(await repository.getById('queued-share'), null);
  } finally {
    gateClient.release();
    await gatePool.end();
    await repository.setPublishingWritesPaused({ paused: false, ip: 'queued-cleanup' });
  }
});

test('a failing publishing transaction rolls back content and audit and releases the gate', async () => {
  await assert.rejects(
    withPublishingWrite(repository.pool, async (client) => {
      await client.query(
        `INSERT INTO public.pages (id, html_content, created_at, is_protected, code_type, title)
         VALUES ('rollback-share', '<p>x</p>', $1, 0, 'html', 'rollback-share')`,
        [Date.now()]
      );
      await client.query(
        `INSERT INTO public.audit_logs (action, page_id, details, ip, created_at)
         VALUES ('test.rollback', 'rollback-share', NULL, NULL, $1)`,
        [Date.now()]
      );
      throw new Error('simulated write failure');
    }),
    /simulated write failure/
  );

  assert.equal(await repository.getById('rollback-share'), null);
  assert.equal(
    (await repository.listAuditLogs()).filter(log => log.action === 'test.rollback').length,
    0
  );

  // The gate lock was released with the rolled-back transaction: a pause
  // toggle completes promptly and publishing works after resume.
  assert.deepEqual(
    await repository.setPublishingWritesPaused({ paused: true, ip: 'rollback-check' }),
    { paused: true, changed: true }
  );
  assert.deepEqual(
    await repository.setPublishingWritesPaused({ paused: false, ip: 'rollback-check' }),
    { paused: false, changed: true }
  );
  await repository.create({ id: 'rollback-share', htmlContent: 'x', createdAt: Date.now() });
  assert.ok(await repository.getById('rollback-share'));
});

test('a deferred COMMIT failure rolls back the whole publishing transaction and releases the gate', async () => {
  const pool = repository.pool;

  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_commit_share() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'simulated commit failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE CONSTRAINT TRIGGER reject_commit_share_trigger
    AFTER INSERT ON public.pages
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.id = 'commit-fail-share')
    EXECUTE FUNCTION reject_commit_share()
  `);

  try {
    await assert.rejects(
      withPublishingWrite(pool, async (client) => {
        await client.query(
          `INSERT INTO public.pages (id, html_content, created_at, is_protected, code_type, title)
           VALUES ('commit-fail-share', '<p>x</p>', $1, 0, 'html', 'commit-fail-share')`,
          [Date.now()]
        );
        await client.query(
          `INSERT INTO public.audit_logs (action, page_id, details, ip, created_at)
           VALUES ('test.commit-failure', 'commit-fail-share', NULL, NULL, $1)`,
          [Date.now()]
        );
        // Both statements succeed; the deferred trigger fires at COMMIT.
      }),
      /simulated commit failure/
    );

    // Nothing from the aborted transaction is visible.
    assert.equal(await repository.getById('commit-fail-share'), null);
    assert.equal(
      (await repository.listAuditLogs()).filter(log => log.action === 'test.commit-failure').length,
      0
    );

    // The gate lock died with the transaction: pause/resume and a normal
    // write proceed without contention errors or a stuck session.
    assert.deepEqual(
      await repository.setPublishingWritesPaused({ paused: true, ip: 'commit-fail-check' }),
      { paused: true, changed: true }
    );
    assert.deepEqual(
      await repository.setPublishingWritesPaused({ paused: false, ip: 'commit-fail-check' }),
      { paused: false, changed: true }
    );
    await repository.create({ id: 'commit-fail-recovery', htmlContent: 'x', createdAt: Date.now() });
    assert.ok(await repository.getById('commit-fail-recovery'));
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS reject_commit_share_trigger ON public.pages');
    await pool.query('DROP FUNCTION IF EXISTS reject_commit_share()');
  }
});

function runScript(scriptName, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', '..', 'scripts', scriptName), ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: maintenanceUrl,
          POSTGRES_SSL: 'false',
          ...extraEnv
        },
        timeout: 60000
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test('operator CLI reports, pauses, and resumes publishing writes', async () => {
  const statusBefore = await runScript('maintenance.js', ['status']);
  assert.equal(statusBefore.code, 0, statusBefore.stderr);
  assert.deepEqual(JSON.parse(statusBefore.stdout), {
    ok: true,
    command: 'status',
    publishingWritesPaused: false
  });

  const pause = await runScript('maintenance.js', ['pause']);
  assert.equal(pause.code, 0, pause.stderr);
  const pauseSummary = JSON.parse(pause.stdout);
  assert.equal(pauseSummary.publishingWritesPaused, true);
  assert.equal(pauseSummary.changed, true);
  assert.equal(typeof pauseSummary.durationMs, 'number');

  assert.equal(await repository.getPublishingWritesPaused(), true);
  await assert.rejects(
    repository.create({ id: 'cli-paused', htmlContent: 'x', createdAt: Date.now() }),
    error => isPublishingPausedError(error)
  );

  const pauseAgain = await runScript('maintenance.js', ['pause']);
  assert.equal(JSON.parse(pauseAgain.stdout).changed, false);

  const resume = await runScript('maintenance.js', ['resume']);
  assert.equal(resume.code, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).changed, true);
  assert.equal(await repository.getPublishingWritesPaused(), false);

  const invalid = await runScript('maintenance.js', ['bogus']);
  assert.notEqual(invalid.code, 0);
});

test('title backfill --write passes the gate; dry-run stays a read', async () => {
  // A page whose title equals its id is a backfill candidate.
  await seedPage('backfill-target');
  await repository.pool.query(
    "UPDATE public.pages SET html_content = '# Derived Heading', code_type = 'markdown' WHERE id = 'backfill-target'"
  );

  const written = await runScript('backfill-page-titles.js', ['--write']);
  assert.equal(written.code, 0, written.stderr);
  const afterWrite = await repository.getById('backfill-target');
  assert.notEqual(afterWrite.title, 'backfill-target');

  // Reset the candidate and pause: --write must now be refused by the gate
  // and must not touch the row, while the dry-run read still works.
  await repository.pool.query(
    "UPDATE public.pages SET title = 'backfill-target' WHERE id = 'backfill-target'"
  );
  await repository.setPublishingWritesPaused({ paused: true, ip: 'backfill-test' });

  try {
    const refused = await runScript('backfill-page-titles.js', ['--write']);
    assert.notEqual(refused.code, 0, 'backfill --write must fail while paused');
    assert.match(refused.stderr + refused.stdout, /paused for maintenance/i);
    assert.equal((await repository.getById('backfill-target')).title, 'backfill-target');

    const dryRun = await runScript('backfill-page-titles.js', []);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /would update 1 of 1/);
    assert.equal((await repository.getById('backfill-target')).title, 'backfill-target');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: 'backfill-cleanup' });
  }
});

test('writers racing a pause either commit before it or are refused; none commit after it lands', async () => {
  const ids = ['race-1', 'race-2', 'race-3', 'race-4', 'race-5', 'race-6'];

  const attempts = ids.map(id => repository.create({
    id,
    htmlContent: '<p>race</p>',
    createdAt: Date.now()
  }).then(
    () => ({ id, ok: true }),
    (error) => ({ id, ok: false, error })
  ));
  const pause = repository.setPublishingWritesPaused({ paused: true, ip: 'race-test' });

  const results = await Promise.all(attempts);
  await pause;

  const succeeded = results.filter(result => result.ok);
  const refused = results.filter(result => !result.ok);
  assert.equal(succeeded.length + refused.length, ids.length);
  refused.forEach(result => assert.ok(
    isPublishingPausedError(result.error),
    `refused writer ${result.id} must fail with the maintenance error, got: ${result.error}`
  ));

  const stored = await repository.pool.query(
    'SELECT id FROM public.pages WHERE id = ANY($1)',
    [ids]
  );
  assert.deepEqual(
    stored.rows.map(row => row.id).sort(),
    succeeded.map(result => result.id).sort(),
    'exactly the writers that reported success are committed'
  );

  await repository.setPublishingWritesPaused({ paused: false, ip: 'race-cleanup' });
});
