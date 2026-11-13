const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');

// History metadata pagination against real Postgres (T07, issue #31).
// The September preflight for this ticket explicitly refused to waive
// native-PG proof for new repository query behavior, so the paginated
// history query is verified here against a real database — including
// the cross-page selection range (Revisions 1..130 span several list
// pages) and decimal-string fidelity for BIGINT revision numbers.
//
// This file uses its own `quickshare_history_test` database, created
// and dropped by the file itself.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.slice(1);
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

const HISTORY_DB = 'quickshare_history_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const historyUrl = serverBaseUrl(HISTORY_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

let adminPool;
let repo;

async function resetState() {
  await repo.pool.query('DELETE FROM public.pages');
  await repo.pool.query('DELETE FROM public.audit_logs');
  await repo.pool.query('DELETE FROM public.api_keys');
  await repo.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

function pageFixture(id, overrides = {}) {
  return {
    id,
    htmlContent: `<h1>${id} body</h1>`,
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: `${id} title`,
    description: null,
    expiresAt: null,
    markdownTheme: null,
    ...overrides
  };
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${HISTORY_DB}`);
  await adminPool.query(`CREATE DATABASE ${HISTORY_DB}`);

  repo = new PostgresPageRepository(historyUrl, env);
  await runMigrations(repo.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repo.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${HISTORY_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('history meta is newest-first, metadata-only, and consistent with the stored snapshots', async () => {
  await repo.create(pageFixture('hist-basic', { htmlContent: 'hist-body-rev1' }));
  await repo.updatePage('hist-basic', { htmlContent: 'hist-body-rev2', title: 'hist-basic title 2' });
  await repo.updatePage('hist-basic', { htmlContent: 'hist-body-rev3' });

  const { total, revisions } = await repo.listContentRevisionMeta('hist-basic', { limit: 20, offset: 0 });

  assert.equal(total, 3);
  assert.deepEqual(revisions.map(item => item.revision), ['3', '2', '1']);

  for (const item of revisions) {
    // Metadata only: the paginated query must not surface bodies.
    // purged_at (T10) is metadata — the tombstone marker belongs here.
    assert.deepEqual(
      Object.keys(item).sort(),
      ['actor_type', 'created_at', 'purged_at', 'restored_from_revision', 'revision', 'source']
    );
    assert.equal(typeof item.revision, 'string');
    assert.equal(item.restored_from_revision, null);
  }

  assert.equal(revisions[2].source, 'web-create');
  assert.equal(revisions[0].source, 'legacy-update');

  const snapshot = await repo.getContentSnapshot('hist-basic', revisions[0].revision);
  assert.equal(snapshot.html_content, 'hist-body-rev3');
  assert.equal(String(snapshot.created_at), String(revisions[0].created_at));
  assert.equal(snapshot.source, revisions[0].source);
});

test('history meta paginates across the full range without rounding BIGINT revisions', async () => {
  await repo.create(pageFixture('hist-many', { htmlContent: 'many-body-0' }));

  for (let index = 1; index <= 129; index += 1) {
    await repo.updatePage('hist-many', { htmlContent: `many-body-${index}` });
  }

  const firstPage = await repo.listContentRevisionMeta('hist-many', { limit: 100, offset: 0 });
  assert.equal(firstPage.total, 130);
  assert.equal(firstPage.revisions.length, 100);
  assert.equal(firstPage.revisions[0].revision, '130');
  assert.equal(firstPage.revisions[99].revision, '31');

  // The cross-page pair the September review required: Revision 130 on
  // page 1 and Revision 1 on page 2 are both addressable exactly.
  const secondPage = await repo.listContentRevisionMeta('hist-many', { limit: 100, offset: 100 });
  assert.equal(secondPage.revisions.length, 30);
  assert.equal(secondPage.revisions[0].revision, '30');
  assert.equal(secondPage.revisions[29].revision, '1');

  const defaultPage = await repo.listContentRevisionMeta('hist-many', {});
  assert.equal(defaultPage.revisions.length, 20);
  assert.equal(defaultPage.revisions[0].revision, '130');

  const oldest = await repo.getContentSnapshot('hist-many', secondPage.revisions[29].revision);
  assert.equal(oldest.html_content, 'many-body-0');
  const newest = await repo.getContentSnapshot('hist-many', firstPage.revisions[0].revision);
  assert.equal(newest.html_content, 'many-body-129');

  // Regression pin: ordering must be numeric on the BIGINT column, not
  // lexicographic on its text cast ('99' must not sort above '130').
  // This covers listContentSnapshots (T06) as well as the history query.
  const all = await repo.listContentSnapshots('hist-many');
  assert.equal(all.length, 130);
  assert.equal(all[0].revision, '1');
  assert.equal(all[99].revision, '100');
  assert.equal(all[129].revision, '130');
});

test('history meta for a missing or unbaselined Share is an empty page', async () => {
  const missing = await repo.listContentRevisionMeta('hist-missing', { limit: 20, offset: 0 });
  assert.deepEqual(missing, { total: 0, revisions: [] });
});

test('history reads never mutate the snapshots or the current pointer', async () => {
  await repo.create(pageFixture('hist-readonly', { htmlContent: 'readonly-body-1' }));
  await repo.updatePage('hist-readonly', { htmlContent: 'readonly-body-2' });

  const before = await repo.listContentSnapshots('hist-readonly');
  await repo.listContentRevisionMeta('hist-readonly', { limit: 20, offset: 0 });
  await repo.getContentSnapshot('hist-readonly', '1');
  const after = await repo.listContentSnapshots('hist-readonly');

  assert.deepEqual(after, before);
  const page = await repo.getById('hist-readonly');
  assert.equal(String(page.current_revision), '2');
});
