const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');
const { createPublishing } = require('../../models/publishing');
const url = new URL(process.env.POSTGRES_TEST_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Isolated localhost _test database required');
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '5',
  POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});
const publishing = createPublishing(repository);
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue28-http-key';
// Inject only the database boundary: HTTP uses a real PostgreSQL adapter.
const selector = require('../../models/pageRepository');
const originalFactory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = originalFactory;
let server;
let origin;

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterEach(() => repository.setPublishingWritesPaused(false));
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await repository.pool.end();
});

async function cli(action) {
  const env = { ...process.env, DATABASE_URL: '', POSTGRES_URL: '', DATABASE_URL_UNPOOLED: '', POSTGRES_URL_NON_POOLING: '', DATABASE_MIGRATION_URL: url.href, POSTGRES_SSL: 'false' };
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/maintenance.js', action], { env });
  return JSON.parse(stdout);
}

test('operator CLI persists pause/status/resume using explicit database configuration', async () => {
  assert.equal((await cli('pause')).publishingWritesPaused, true);
  assert.equal((await cli('status')).publishingWritesPaused, true);
  assert.equal(await repository.getPublishingWritesPaused(), true);
  assert.equal((await cli('resume')).publishingWritesPaused, false);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/maintenance.js', 'pause'], {
    env: { ...process.env, DATABASE_URL: '', POSTGRES_URL: '', DATABASE_MIGRATION_URL: '', DATABASE_URL_UNPOOLED: '', POSTGRES_URL_NON_POOLING: '' }
  }), error => error.code === 1 && /DATABASE_MIGRATION_URL/.test(error.stderr));
});

test('title backfill CLI keeps dry-run read-only and gates --write on its single connection', async () => {
  await repository.create({ id: 'backfill-maintenance', htmlContent: '<h1>Derived title</h1>', createdAt: Date.now() });
  const env = { ...process.env, DATABASE_URL: url.href, POSTGRES_URL: '', DATABASE_MIGRATION_URL: '', DATABASE_URL_UNPOOLED: '', POSTGRES_URL_NON_POOLING: '', POSTGRES_SSL: 'false' };
  const run = args => promisify(execFile)(process.execPath, ['scripts/backfill-page-titles.js', ...args], { env, timeout: 5000 });
  await repository.setPublishingWritesPaused(true);
  assert.match((await run([])).stdout, /dry-run backfill-maintenance: Derived title/);
  assert.equal((await repository.getById('backfill-maintenance')).title, null);
  await assert.rejects(run(['--write']), error => error.code === 1 && /PUBLISHING_MAINTENANCE/.test(error.stderr));
  assert.equal((await repository.getById('backfill-maintenance')).title, null);
  await repository.setPublishingWritesPaused(false);
  assert.match((await run(['--write'])).stdout, /update backfill-maintenance: Derived title/);
  assert.equal((await repository.getById('backfill-maintenance')).title, 'Derived title');
});

test('baseline revision backfill CLI requires the live paused window and repeats skipped', async () => {
  const env = { ...process.env, DATABASE_URL: url.href, POSTGRES_URL: '', DATABASE_MIGRATION_URL: '', DATABASE_URL_UNPOOLED: '', POSTGRES_URL_NON_POOLING: '', POSTGRES_SSL: 'false' };
  const run = args => promisify(execFile)(process.execPath, ['scripts/backfill-page-revisions.js', ...args], { env, timeout: 8000 });

  // A legacy-shaped row without a Revision 1 snapshot (pre-007 content).
  await repository.create({ id: 'backfill-rev-maintenance', htmlContent: '<p>legacy body</p>', createdAt: 12345 });
  await repository.pool.query('DELETE FROM share_revisions WHERE share_id = $1', ['backfill-rev-maintenance']);

  // Dry run reads even while paused and never writes.
  await repository.setPublishingWritesPaused(true);
  const dryRun = await run([]);
  assert.match(dryRun.stdout, /dry-run backfill-rev-maintenance: would backfill Revision 1/);
  assert.equal((await repository.listContentRevisions('backfill-rev-maintenance')).length, 0);

  // --write inside the live paused window succeeds and is exactly repeatable.
  const writeRun = await run(['--write']);
  assert.match(writeRun.stdout, /backfill backfill-rev-maintenance: Revision 1 written/);
  assert.match(writeRun.stdout, /backfilled 1 of 1 scanned Shares/);
  const repeatRun = await run(['--write']);
  assert.match(repeatRun.stdout, /no Shares are missing Revision 1/);
  const baseline = await repository.listContentRevisions('backfill-rev-maintenance');
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].html_content, '<p>legacy body</p>');
  assert.equal((await repository.getById('backfill-rev-maintenance')).current_revision, '1');
  await repository.setPublishingWritesPaused(false);

  // --write outside the window refuses: allowPaused is not paused evidence.
  await repository.create({ id: 'backfill-rev-open', htmlContent: '<p>open window</p>', createdAt: 12346 });
  await repository.pool.query('DELETE FROM share_revisions WHERE share_id = $1', ['backfill-rev-open']);
  await assert.rejects(run(['--write']), error => error.code === 1 && /BASELINE_WINDOW_REQUIRED/.test(error.stderr));
  assert.equal((await repository.listContentRevisions('backfill-rev-open')).length, 0);
  await repository.setPublishingWritesPaused(true);
  const lateRun = await run(['--write']);
  assert.match(lateRun.stdout, /backfill backfill-rev-open: Revision 1 written/);
  await repository.setPublishingWritesPaused(false);
});

test('paused PostgreSQL view events retain access rejections, skip counting and allow reads', async () => {
  await repository.create({ id: 'event-public', htmlContent: '<h1>readable</h1>', createdAt: 1 });
  await repository.create({ id: 'event-locked', htmlContent: 'secret', createdAt: 1, isProtected: true });
  await repository.create({ id: 'event-expired', htmlContent: 'expired', createdAt: 1, expiresAt: 2 });
  await repository.createApiKey({ id: 'maintenance-key', name: 'synthetic', keyHash: 'fixture-hash', keyPrefix: 'fixture', createdAt: 1 });
  await repository.setPublishingWritesPaused(true);
  await repository.touchApiKey('maintenance-key');
  assert.equal((await repository.getApiKeyById('maintenance-key')).last_used_at, null);
  for (const [id, expected] of [['event-public', 503], ['event-locked', 403], ['event-expired', 410], ['event-missing', 404]]) {
    const response = await fetch(`${origin}/view/${id}/view-event`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, expected);
    if (expected === 503) assert.equal((await response.json()).code, 'PUBLISHING_MAINTENANCE');
  }
  assert.equal((await repository.getById('event-public')).view_count, '0');
  assert.equal((await fetch(`${origin}/view/event-public`)).status, 200);
  assert.equal((await fetch(`${origin}/admin/pages`)).status, 200);
  await repository.setPublishingWritesPaused(false);
  const resumed = await fetch(`${origin}/view/event-public/view-event`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(resumed.status, 204);
  assert.equal((await repository.getById('event-public')).view_count, '1');
});

async function createOverHttp(content) {
  return fetch(`${origin}/api/v1/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'issue28-http-key' },
    body: JSON.stringify({ htmlContent: content })
  });
}

test('HTTP success waits for same-client audit COMMIT and SQL audit failure rolls back Share creation', async () => {
  const observer = await repository.pool.connect();
  let pending;
  try {
    // A test-only deferred trigger blocks the actual COMMIT, rather than an
    // earlier INSERT. An HTTP response sent inside the callback would leak here.
    await observer.query(`
      CREATE FUNCTION issue28_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(20828002); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER issue28_commit_barrier AFTER INSERT ON audit_logs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue28_commit_barrier();
    `);
    await observer.query('BEGIN');
    await observer.query('SELECT pg_advisory_xact_lock(20828002)');
    let settled = false;
    pending = createOverHttp('<h1>await audit commit</h1>').then(response => { settled = true; return response; });
    await waitForLock(observer, 'COMMIT');
    assert.equal(settled, false);
    assert.equal((await repository.pool.query("SELECT count(*)::int AS n FROM pages WHERE title = 'await audit commit'")).rows[0].n, 0);
    await observer.query('COMMIT');
    const response = await pending;
    assert.equal(response.status, 200);
    const { urlId } = await response.json();
    assert.ok(await repository.getById(urlId));
    assert.equal((await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE page_id = $1', [urlId])).rows[0].n, 1);
    // Test-only fault injection, never application/startup DDL.
    await observer.query("ALTER TABLE audit_logs ADD CONSTRAINT issue28_audit_failure CHECK (action <> 'page.create') NOT VALID");
    const count = await repository.countPages();
    const failed = await createOverHttp('<h1>must roll back</h1>');
    assert.equal(failed.status, 500);
    assert.equal(await repository.countPages(), count);
  } finally {
    await observer.query('ROLLBACK');
    await observer.query('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS issue28_audit_failure');
    await observer.query('DROP TRIGGER IF EXISTS issue28_commit_barrier ON audit_logs; DROP FUNCTION IF EXISTS issue28_commit_barrier()');
    if (pending) await pending;
    observer.release();
  }
});

test('a real deferred COMMIT failure rolls back Share and audit, releases the gate, and permits recovery', async () => {
  const observer = await repository.pool.connect();
  let pending;
  let writerPid;
  const beforePages = await repository.countPages();
  const beforeAudits = await repository.countAuditLogs();
  try {
    await observer.query(`
      CREATE FUNCTION issue28_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(20828003);
        RAISE EXCEPTION 'issue28 synthetic COMMIT failure' USING ERRCODE = '23514';
      END $$;
      CREATE CONSTRAINT TRIGGER issue28_commit_failure AFTER INSERT ON audit_logs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue28_commit_failure();
    `);
    await observer.query('BEGIN');
    await observer.query('SELECT pg_advisory_xact_lock(20828003)');
    let responseSettled = false;
    pending = createOverHttp('<h1>issue28 failed at COMMIT</h1>').then(response => {
      responseSettled = true;
      return response;
    });
    // Observe the HTTP backend waiting inside COMMIT. The deferred trigger has
    // not run at INSERT, and no mocked client or repository method is involved.
    writerPid = await waitForLock(observer, 'COMMIT');
    assert.equal(responseSettled, false, 'HTTP must not succeed before the failing COMMIT');
    await observer.query('COMMIT');
    const failed = await pending;
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).success, false);
    assert.equal(await repository.countPages(), beforePages, 'content INSERT rolls back');
    assert.equal(await repository.countAuditLogs(), beforeAudits, 'necessary audit INSERT rolls back');
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM pages WHERE title = 'issue28 failed at COMMIT'")).rows[0].n, 0);
    const writerState = await observer.query('SELECT xact_start FROM pg_stat_activity WHERE pid = $1', [writerPid]);
    assert.equal(writerState.rows[0]?.xact_start ?? null, null, 'failed transaction is no longer open');
    const locks = await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [writerPid]);
    assert.equal(locks.rows[0].n, 0, 'transaction advisory locks are released');
    // The operator acquires the exclusive maintenance gate after the failure.
    assert.deepEqual(await repository.setPublishingWritesPaused(true), { publishingWritesPaused: true });
    await observer.query('DROP TRIGGER issue28_commit_failure ON audit_logs; DROP FUNCTION issue28_commit_failure()');
    await repository.setPublishingWritesPaused(false);
    const recovered = await createOverHttp('<h1>issue28 recovered after COMMIT failure</h1>');
    assert.equal(recovered.status, 200);
    const { urlId } = await recovered.json();
    assert.equal((await repository.getById(urlId)).html_content, '<h1>issue28 recovered after COMMIT failure</h1>');
    assert.equal(await repository.countPages(), beforePages + 1);
    assert.equal(await repository.countAuditLogs(), beforeAudits + 1);
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM audit_logs WHERE page_id = $1 AND action = 'page.create'", [urlId])).rows[0].n, 1);
  } finally {
    await observer.query('ROLLBACK');
    if (pending) await pending;
    await observer.query('DROP TRIGGER IF EXISTS issue28_commit_failure ON audit_logs; DROP FUNCTION IF EXISTS issue28_commit_failure()');
    observer.release();
  }
});

async function waitForLock(observer, queryFragment) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const result = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND position($1 in query) > 0", [queryFragment]);
    if (result.rowCount) return result.rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`No independent backend waited for ${queryFragment}`);
}

test('pause drains active Share transactions, excludes queued writers, and resumes after rollback', async () => {
  assert.equal(await repository.getPublishingWritesPaused(), false);
  const entered = deferred();
  const release = deferred();
  const observer = await repository.pool.connect();
  let writer, pause, queued;
  try {
    writer = publishing.run(async transaction => {
      const pid = (await transaction.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await transaction.create({ id: 'drained', htmlContent: 'committed before pause', createdAt: 1 });
      // Existing setting transaction must not COMMIT the outer gate.
      await transaction.setHomepagePasswordRequired({ passwordRequired: false });
      entered.resolve(pid);
      await release.promise;
      await transaction.createAuditLog({ action: 'page.create', pageId: 'drained' });
    });
    const writerPid = await entered.promise;
    pause = repository.setPublishingWritesPaused(true);
    const pausePid = await waitForLock(observer, 'pg_advisory_xact_lock(');
    assert.notEqual(writerPid, pausePid);
    queued = publishing.run(transaction => transaction.create({ id: 'queued', htmlContent: 'must not commit', createdAt: 2 }));
    // Attach rejection immediately while deliberately holding the writer.
    const rejected = assert.rejects(queued, { code: 'PUBLISHING_MAINTENANCE' });
    const queuedPid = await waitForLock(observer, 'pg_advisory_xact_lock_shared(');
    assert.notEqual(queuedPid, pausePid);
    assert.equal(await repository.getById('drained'), null, 'no success becomes visible before commit');
    release.resolve();
    await writer;
    assert.deepEqual(await pause, { publishingWritesPaused: true });
    await rejected;
    assert.equal((await repository.getById('drained')).html_content, 'committed before pause');
    assert.equal(await repository.getById('queued'), null);
    assert.equal(await repository.getHomepagePasswordRequired(), false);
    const drainAudits = await repository.pool.query("SELECT action FROM audit_logs WHERE page_id = 'drained' OR action = 'settings.homepage_password_required.update'");
    assert.equal(drainAudits.rowCount, 2);
    await repository.setPublishingWritesPaused(false);
    await assert.rejects(publishing.run(async transaction => {
      await transaction.create({ id: 'rollback', htmlContent: 'not committed', createdAt: 3 });
      await transaction.pool.query('SELECT 1/0');
    }), { code: '22012' });
    assert.equal(await repository.getById('rollback'), null);
    await publishing.run(transaction => transaction.create({ id: 'resumed', htmlContent: 'resumed', createdAt: 4 }));
    assert.ok(await repository.getById('resumed'));
    await assert.rejects(publishing.run(async transaction => {
      await transaction.create({ id: 'swallowed', htmlContent: 'not committed', createdAt: 5 });
      try { await transaction.pool.query('SELECT 1/0'); } catch { /* Emulate a swallowed audit error. */ }
      return 'must not report success';
    }), { code: '22012' });
    assert.equal(await repository.getById('swallowed'), null);
    await publishing.run(async transaction => {
      await assert.rejects(transaction.create({ id: 'resumed', htmlContent: 'collision', createdAt: 5 }), { code: '23505' });
      await transaction.create({ id: 'after-collision', htmlContent: 'retry succeeds in the same transaction', createdAt: 6 });
    });
    assert.ok(await repository.getById('after-collision'));
  } finally {
    release.resolve();
    await Promise.allSettled([writer, pause, queued].filter(Boolean));
    observer.release();
  }
});
