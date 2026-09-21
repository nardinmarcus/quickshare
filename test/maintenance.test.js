const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue28-synthetic-key';
const app = require('../app');
const repository = app.locals.pageRepository;
let server;
let origin;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function request(path, method = 'GET', body, headers = {}) {
  return fetch(origin + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.afterEach(async () => repository.setPublishingWritesPaused(false));

test('operator pause blocks Share creation, preserves reads and resumes publishing', async () => {
  const initial = await request('/api/v1/share', 'POST', { htmlContent: '<h1>Before maintenance</h1>' }, { 'X-API-Key': 'issue28-synthetic-key' });
  assert.equal(initial.status, 200);
  const { urlId } = await initial.json();
  assert.equal(await repository.getPublishingWritesPaused(), false);
  await repository.setPublishingWritesPaused(true);
  const blocked = await request('/api/v1/share', 'POST', { htmlContent: '<h1>Blocked</h1>' }, { 'X-API-Key': 'issue28-synthetic-key' });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, 'PUBLISHING_MAINTENANCE');
  assert.equal(await repository.countPages(), 1);
  assert.equal((await request(`/view/${urlId}`)).status, 200);
  assert.equal((await request('/admin/pages')).status, 200);
  await repository.setPublishingWritesPaused(false);
  const resumed = await request('/api/v1/share', 'POST', { htmlContent: '<h1>After maintenance</h1>' }, { 'X-API-Key': 'issue28-synthetic-key' });
  assert.equal(resumed.status, 200);
  assert.equal(await repository.countPages(), 2);
});

test('memory publishing rolls back failed work without replacing another completed writer', async () => {
  const { MemoryPageRepository } = require('../models/memory-pages');
  const { createPublishing } = require('../models/publishing');
  const memory = new MemoryPageRepository();
  const publishing = createPublishing(memory);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const failed = publishing.run(async transaction => {
    await transaction.create({ id: 'rolled-back', htmlContent: 'never visible', createdAt: 1 });
    entered();
    await barrier;
    throw new Error('synthetic failure');
  });
  const rejection = assert.rejects(failed, /synthetic failure/);
  await started;
  const completed = publishing.run(transaction => transaction.create({ id: 'committed', htmlContent: 'preserved', createdAt: 2 }));
  const pause = memory.setPublishingWritesPaused(true);
  assert.equal(await memory.getById('rolled-back'), null);
  release();
  await rejection;
  await completed;
  await pause;
  assert.equal(await memory.getById('rolled-back'), null);
  assert.equal((await memory.getById('committed')).html_content, 'preserved');
  await assert.rejects(publishing.run(transaction => transaction.deletePage('committed')), { code: 'PUBLISHING_MAINTENANCE' });
  await memory.setPublishingWritesPaused(false);
  await publishing.run(transaction => transaction.setFavorite('committed', true));
  assert.equal((await memory.getById('committed')).is_favorite, true);
});

test('every existing management write and eligible view event rejects maintenance without side effects', async () => {
  const created = await request('/api/v1/share', 'POST', { htmlContent: '<h1>Maintenance matrix</h1>' }, { 'X-API-Key': 'issue28-synthetic-key' });
  const { urlId } = await created.json();
  const keyResponse = await request('/admin/apis/keys', 'POST', { name: 'issue28 fixture' });
  const { apiKey } = await keyResponse.json();
  const before = structuredClone(await repository.getById(urlId));
  const count = await repository.countPages();
  const auditCount = await repository.countAuditLogs();
  await repository.setPublishingWritesPaused(true);
  for (const [path, method, body] of [
    ['/api/pages/create', 'POST', { htmlContent: '<h1>No write</h1>' }],
    [`/admin/pages/${urlId}`, 'PUT', { title: 'No write' }],
    [`/api/pages/${urlId}/protect`, 'POST', { isProtected: true, expectedAccessRevision: '1' }],
    [`/admin/pages/${urlId}/clone`, 'POST', {}],
    [`/admin/pages/${urlId}`, 'DELETE'],
    ['/admin/pages/batch', 'DELETE', { ids: [urlId] }],
    [`/admin/pages/${urlId}/favorite`, 'PUT', { isFavorite: true }],
    ['/admin/settings/homepage-access', 'PUT', { passwordRequired: false }],
    ['/admin/apis/keys', 'POST', { name: 'blocked' }],
    [`/admin/apis/keys/${apiKey.id}`, 'DELETE'],
    [`/view/${urlId}/view-event`, 'POST']
  ]) {
    const response = await request(path, method, body);
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal((await response.json()).code, 'PUBLISHING_MAINTENANCE');
  }
  assert.deepEqual(await repository.getById(urlId), before);
  assert.equal(await repository.countPages(), count);
  assert.equal(await repository.countAuditLogs(), auditCount);
  assert.equal(await repository.getHomepagePasswordRequired(), true);
  assert.ok(await repository.getApiKeyById(apiKey.id));
  const managed = await request('/api/v1/share', 'POST', { htmlContent: 'blocked managed write' }, { 'X-API-Key': apiKey.secret });
  assert.equal(managed.status, 503);
  assert.equal((await repository.getApiKeyById(apiKey.id)).last_used_at, null);
  assert.equal((await request('/api/v1/share', 'POST', { htmlContent: 'x' }, { 'X-API-Key': 'wrong' })).status, 401);
  assert.equal((await request(`/view/${urlId}/view-event`, 'POST', undefined, { Origin: 'https://invalid.example' })).status, 403);
  assert.equal((await request('/view/missing/view-event', 'POST')).status, 404);
  await repository.setPublishingWritesPaused(false);
  await repository.create({ id: 'issue28-locked', htmlContent: 'secret', createdAt: 1, isProtected: true });
  await repository.create({ id: 'issue28-expired', htmlContent: 'expired', createdAt: 1, expiresAt: 2 });
  await repository.setPublishingWritesPaused(true);
  assert.equal((await request('/view/issue28-locked/view-event', 'POST')).status, 403);
  assert.equal((await request('/view/issue28-expired/view-event', 'POST')).status, 410);
});
