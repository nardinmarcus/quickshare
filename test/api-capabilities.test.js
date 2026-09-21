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
test('Key discovery truthfully reports create-only identity, catalog and configured request bytes during maintenance', async () => {
  const me = await get('/api/v1/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { success: true, origin: 'https://example.test', credentialKind: 'legacy' });
  const capabilities = await get('/api/v1/capabilities');
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.contentTypes, ['html', 'markdown', 'svg', 'mermaid']);
  assert.deepEqual(capabilities.body.markdownThemePresets, ['bytedance', 'github', 'apple', 'notion', 'claude', 'raycast', 'google', 'tesla', 'airbnb', 'bugatti', 'linear', 'playstation']);
  assert.deepEqual(capabilities.body.operations, [{ id: 'share:create', method: 'POST', path: '/api/v1/share' }]);
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
  assert.deepEqual((await get('/api/v1/me', secret)).body, { success: true, origin: 'https://example.test', credentialKind: 'managed', id, name: 'Identity fixture', credentialVersion: '1' });
  assert.deepEqual((await get('/api/v1/capabilities', secret)).body, (await get('/api/v1/capabilities')).body);
  for (const path of ['/api/v1/me', '/api/v1/capabilities']) {
    assert.equal((await get(path, '')).status, 401);
    assert.equal((await get(path, 'invalid')).status, 401);
    assert.equal((await fetch(base + path, { headers: { Cookie: 'admin_session=invalid; dashboard_admin_session=invalid' } })).status, 401);
  }
});
