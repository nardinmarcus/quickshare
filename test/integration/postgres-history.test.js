// #31 owner history against real PostgreSQL: exact BIGINT descending
// pagination, metadata-only projection, single-revision isolation, sandboxed
// preview hygiene, read-only guarantees and honest empty history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');

const { validateCanonicalPostgresSuiteUrl } = require('../../scripts/release-readiness-check');
const url = validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '5',
  POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue31-pg-history-secret';
// Inject only the database boundary: HTTP uses a real PostgreSQL adapter.
const selector = require('../../models/pageRepository');
const originalFactory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = originalFactory;
let server;
let origin;

test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await repository.pool.end();
});

const etag = (id, revision) => `"content:${id}:${revision}"`;

async function createShare() {
  const response = await fetch(`${origin}/api/pages/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ htmlContent: '<h1>PG31 BASE</h1>', codeType: 'html', title: 'Pg history' })
  });
  assert.equal(response.status, 200);
  return (await response.json()).urlId;
}

async function saveBody(id, revision, body) {
  const response = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, revision) },
    body: JSON.stringify({ htmlContent: body })
  });
  assert.equal(response.status, 200, await response.text());
}

test('repository pagination orders exact BIGINT revisions descending without reading bodies', async () => {
  const id = await createShare();
  await saveBody(id, '1', '<h1>PG31 TWO</h1>');
  // Synthetic pre-2^53 and near-2^62 revisions: string ordering would rank
  // '9007199254740993' above '4611686018427387904'; exact numeric order must not.
  await repository.pool.query(
    `INSERT INTO share_revisions (share_id, revision, html_content, code_type, title, description, markdown_theme, created_at, snapshot_hash, source, actor, restored_from)
     VALUES ($1, 9007199254740993, '<h1>PG31 HUGE A</h1>', 'html', NULL, NULL, NULL, $2, 'synthetic', 'web', NULL, NULL)`,
    [id, Date.now()]
  );
  await repository.pool.query(
    `INSERT INTO share_revisions (share_id, revision, html_content, code_type, title, description, markdown_theme, created_at, snapshot_hash, source, actor, restored_from)
     VALUES ($1, 4611686018427387904, '<h1>PG31 HUGE B</h1>', 'html', NULL, NULL, NULL, $2, 'synthetic', 'web', NULL, NULL)`,
    [id, Date.now()]
  );

  const firstPage = await repository.listContentRevisionPage(id, { limit: 2, offset: 0 });
  assert.equal(firstPage.total, '4');
  assert.deepEqual(firstPage.items.map(item => item.revision), ['4611686018427387904', '9007199254740993'],
    'descending order uses exact BIGINT arithmetic, never Number or string order');
  for (const item of firstPage.items) {
    assert.deepEqual(Object.keys(item).sort(), ['created_at', 'purged_at', 'restored_from', 'revision', 'share_id', 'source'],
      'the SQL projection selects metadata columns only');
    assert.equal(item.html_content, undefined, 'bodies are not even SELECTed for list pages');
  }

  const secondPage = await repository.listContentRevisionPage(id, { limit: 2, offset: 2 });
  assert.deepEqual(secondPage.items.map(item => item.revision), ['2', '1']);
  assert.equal(secondPage.total, '4');

  const single = await repository.getContentRevision(id, '9007199254740993');
  assert.equal(single.html_content, '<h1>PG31 HUGE A</h1>', 'single reads isolate the exact requested body');
  assert.equal(await repository.getContentRevision(id, '4611686018427387905'), null);
});

test('HTTP history endpoints project metadata only and isolate single bodies on PostgreSQL', async () => {
  const id = await createShare();
  await saveBody(id, '1', '<h1>PG31 HTTP TWO with SECRET-V1-MARKER</h1>');
  await saveBody(id, '2', '<h1>PG31 HTTP THREE</h1>');

  const list = await fetch(`${origin}/admin/pages/${id}/revisions?limit=2`);
  assert.equal(list.status, 200);
  const listText = await list.text();
  const listBody = JSON.parse(listText);
  assert.equal(listBody.pagination.total, '3');
  assert.deepEqual(listBody.revisions.map(item => item.revision), ['3', '2']);
  assert.ok(!listText.includes('SECRET-V1-MARKER'), 'list responses carry no body text');
  assert.match(list.headers.get('cache-control'), /no-store/);

  const single = JSON.parse((await (await fetch(`${origin}/admin/pages/${id}/revisions/2`)).text()));
  assert.equal(single.revision.htmlContent, '<h1>PG31 HTTP TWO with SECRET-V1-MARKER</h1>');
  assert.equal(single.revision.revision, '2');

  const missing = await fetch(`${origin}/admin/pages/${id}/revisions/42`);
  assert.equal(missing.status, 404);
});

test('preview endpoint serves the sandboxed historical document without public tracking on PostgreSQL', async () => {
  const id = await createShare();
  await saveBody(id, '1', '<h1>PG31 PREVIEW V2</h1><script>alert("x")</script>');

  const preview = await fetch(`${origin}/admin/pages/${id}/revisions/2/preview`);
  assert.equal(preview.status, 200);
  const text = await preview.text();
  assert.match(preview.headers.get('cache-control'), /no-store/);
  assert.ok(text.includes('allow-same-origin') === false, 'no same-origin grant');
  assert.ok(text.includes('referrerpolicy="no-referrer"'));
  assert.ok(text.includes('&lt;script&gt;alert'), 'the historical body appears only escaped inside srcdoc');
  assert.ok(!text.includes('umami') && !text.includes('view-event'), 'no public analytics or view counting');
  assert.ok(!text.includes('<h1>PG31 PREVIEW V2</h1>'), 'the raw body is never live markup in the wrapper document');
  const current = await repository.getById(id);
  assert.equal(current.html_content, '<h1>PG31 PREVIEW V2</h1><script>alert("x")</script>', 'preview never changes the current projection');
  assert.equal(String(current.current_revision), '2', 'preview never advances the content pointer');
});

test('history reads stay read-only and keep counting/protection untouched on PostgreSQL', async () => {
  const id = await createShare();
  await saveBody(id, '1', '<h1>PG31 RO V2</h1>');
  await fetch(`${origin}/admin/pages/${id}/favorite`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ isFavorite: true })
  }).then(response => assert.equal(response.status, 200));

  const before = await repository.getById(id);
  const snapshotCount = await repository.pool.query('SELECT count(*)::text AS total FROM share_revisions WHERE share_id = $1', [id]);

  for (const path of [`/admin/pages/${id}/revisions`, `/admin/pages/${id}/revisions/1`, `/admin/pages/${id}/revisions/2/preview`, `/admin/pages/${id}/history`]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
  }

  const after = await repository.getById(id);
  assert.equal(after.current_revision, before.current_revision);
  assert.equal(after.access_revision, before.access_revision);
  assert.equal(after.is_favorite, true);
  assert.equal(after.view_count, before.view_count);
  assert.equal(after.published, before.published);
  const afterCount = await repository.pool.query('SELECT count(*)::text AS total FROM share_revisions WHERE share_id = $1', [id]);
  assert.equal(afterCount.rows[0].total, snapshotCount.rows[0].total, 'no snapshot rows are added or removed');
});

test('history remains readable while publishing writes are paused on PostgreSQL', async () => {
  const id = await createShare();
  await saveBody(id, '1', '<h1>PG31 PAUSED V2</h1>');
  await repository.setPublishingWritesPaused(true);
  try {
    const list = await fetch(`${origin}/admin/pages/${id}/revisions`);
    assert.equal(list.status, 200);
    const preview = await fetch(`${origin}/admin/pages/${id}/revisions/1/preview`);
    assert.equal(preview.status, 200);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }
});

test('a Share with zero snapshots reports an honest empty history on PostgreSQL', async () => {
  const id = await createShare();
  await repository.pool.query('DELETE FROM share_revisions WHERE share_id = $1', [id]);

  const list = JSON.parse(await (await fetch(`${origin}/admin/pages/${id}/revisions`)).text());
  assert.deepEqual(list.revisions, []);
  assert.equal(list.pagination.total, '0');

  const single = await fetch(`${origin}/admin/pages/${id}/revisions/1`);
  assert.equal(single.status, 404, 'missing snapshots are never guessed');
});
