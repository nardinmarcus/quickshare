const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue29-legacy';
process.env.BASE_URL = 'https://example.test/prefix/';
process.env.SHARE_BODY_LIMIT = '1kb';
process.env.SMALL_BODY_LIMIT = '512b';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
const app = require('../app');
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function get(path, key = 'issue29-legacy') {
  const response = await fetch(base + path, { headers: key ? { 'X-API-Key': key } : {} });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
test('Key discovery truthfully reports scopes, catalog and configured request bytes during maintenance', async () => {
  const me = await get('/api/v1/me');
  assert.equal(me.status, 200);
  // #36: discovery exposes the credential's scopes; legacy stays create-only.
  assert.deepEqual(me.body, { success: true, origin: 'https://example.test', credentialKind: 'legacy', scopes: ['share:create'] });
  const capabilities = await get('/api/v1/capabilities');
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.contentTypes, ['html', 'markdown', 'svg', 'mermaid']);
  assert.deepEqual(capabilities.body.markdownThemePresets, ['bytedance', 'github', 'apple', 'notion', 'claude', 'raycast', 'google', 'tesla', 'airbnb', 'bugatti', 'linear', 'playstation']);
  assert.deepEqual(capabilities.body.operations.map(({ id, method, path }) => ({ id, method, path })), [
    { id: 'share:create', method: 'POST', path: '/api/v1/share' },
    { id: 'share:create:status', method: 'GET', path: '/api/v1/operations/:requestId' },
    { id: 'share:list', method: 'GET', path: '/api/v1/shares' },
    { id: 'share:content:read', method: 'GET', path: '/api/v1/shares/:id/content' },
    { id: 'share:state:read', method: 'GET', path: '/api/v1/shares/:id/state' },
    { id: 'share:content:update', method: 'PUT', path: '/api/v1/shares/:id/content' },
    { id: 'share:revisions:read', method: 'GET', path: '/api/v1/shares/:id/revisions' },
    { id: 'share:revision:read', method: 'GET', path: '/api/v1/shares/:id/revisions/:revision' },
    { id: 'share:restore', method: 'POST', path: '/api/v1/shares/:id/restore' },
    { id: 'share:unpublish', method: 'POST', path: '/api/v1/shares/:id/unpublish' },
    { id: 'share:republish', method: 'POST', path: '/api/v1/shares/:id/republish' },
    { id: 'identity:read', method: 'GET', path: '/api/v1/me' },
    { id: 'capabilities:read', method: 'GET', path: '/api/v1/capabilities' }
  ]);
  assert.deepEqual(capabilities.body.operations.find(operation => operation.id === 'share:state:read').anyOf, [
    { scope: 'share:read', grant: 'can_read' },
    { scope: 'share:publish', grant: 'can_publish' }
  ]);
  assert.deepEqual(capabilities.body.scopes, {
    implemented: ['share:create', 'share:read', 'share:update', 'share:publish'],
    notImplemented: []
  });
  assert.deepEqual(capabilities.body.idempotency, {
    header: 'Idempotency-Key',
    pattern: '^[A-Za-z0-9_-]{16,128}$',
    appliesTo: ['share:create', 'share:content:update', 'share:restore', 'share:unpublish', 'share:republish'],
    conflictStatus: 409,
    replayRequiresSameInput: true
  });
  assert.deepEqual(capabilities.body.limits, { shareRequestBodyBytes: 1024, smallRequestBodyBytes: 512, rawContentBytes: null });
  assert.match(capabilities.headers.get('cache-control'), /no-store/);
  const oversized = await fetch(base + '/api/v1/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'issue29-legacy' }, body: JSON.stringify({ htmlContent: 'a'.repeat(1024) }) });
  assert.equal(oversized.status, 413, 'JSON envelope counts toward request bytes');
  await app.locals.pageRepository.setPublishingWritesPaused(true);
  assert.equal((await get('/api/v1/me')).status, 200);
  assert.deepEqual((await get('/api/v1/capabilities')).body, capabilities.body);
  await app.locals.pageRepository.setPublishingWritesPaused(false);
});
test('managed discovery exposes only necessary identity; cookies and absent/invalid Keys never authorize discovery', async () => {
  const created = await fetch(base + '/admin/apis/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Identity fixture' }) }).then(r => r.json());
  const { id, secret } = created.apiKey;
  // A fresh managed key starts create-only (#36): read access comes only
  // from explicit per-Share grants, never from discovery itself.
  assert.deepEqual((await get('/api/v1/me', secret)).body, { success: true, origin: 'https://example.test', credentialKind: 'managed', id, name: 'Identity fixture', credentialVersion: '1', scopes: ['share:create'] });
  assert.deepEqual((await get('/api/v1/capabilities', secret)).body, (await get('/api/v1/capabilities')).body);
  for (const path of ['/api/v1/me', '/api/v1/capabilities']) {
    assert.equal((await get(path, '')).status, 401);
    assert.equal((await get(path, 'invalid')).status, 401);
    assert.equal((await fetch(base + path, { headers: { Cookie: 'admin_session=invalid; dashboard_admin_session=invalid' } })).status, 401);
  }
});
