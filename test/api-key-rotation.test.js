const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
const app = require('../app');
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function request(path, method = 'GET', body, key) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
test('rotation keeps the managed Key identity and only the new secret can create a Share', async () => {
  const created = await request('/admin/apis/keys', 'POST', { name: 'Rotation fixture' });
  assert.equal(created.status, 201);
  const old = created.body.apiKey;
  const rotated = await request(`/admin/apis/keys/${old.id}/rotate`, 'POST', {});
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.apiKey.id, old.id);
  assert.equal(old.credential_version, '1');
  assert.equal(rotated.body.apiKey.credential_version, '2');
  assert.notEqual(rotated.body.apiKey.secret, old.secret);
  assert.equal('key_hash' in rotated.body.apiKey, false);
  assert.equal((await request('/api/v1/share', 'POST', { htmlContent: '<h1>Share</h1>' }, old.secret)).status, 401);
  assert.equal((await request('/api/v1/share', 'POST', { htmlContent: '<h1>Share</h1>' }, rotated.body.apiKey.secret)).status, 200);
  const listing = await fetch(base + '/admin/apis').then(response => response.text());
  assert.ok(!listing.includes(rotated.body.apiKey.secret));
  assert.ok(!listing.includes(old.secret));
  assert.match(listing, /轮换 API 密钥 Rotation fixture/);
  assert.match(listing, /\/api\/v1\/capabilities/);
});

for (const action of ['rotate', 'delete']) {
  test(`memory Adapter rejects authenticated old requests after ${action} commits`, async () => {
    const key = (await request('/admin/apis/keys', 'POST', { name: 'memory race' })).body.apiKey;
    const data = JSON.stringify({ htmlContent: 'stale Share' });
    let pending;
    const response = new Promise((resolve, reject) => {
      pending = http.request(base + '/api/v1/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-API-Key': key.secret } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      pending.on('error', reject); pending.flushHeaders();
    });
    try {
      const deadline = Date.now() + 3000;
      while (!(await app.locals.pageRepository.getApiKeyById(key.id)).last_used_at && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok((await app.locals.pageRepository.getApiKeyById(key.id)).last_used_at);
      assert.equal((await request(`/admin/apis/keys/${key.id}${action === 'rotate' ? '/rotate' : ''}`, action === 'rotate' ? 'POST' : 'DELETE')).status, 200);
      const count = await app.locals.pageRepository.countPages();
      pending.end(data);
      assert.equal(await response, 401);
      assert.equal(await app.locals.pageRepository.countPages(), count);
    } finally { pending.end(data); await response; }
  });
}

test('memory rotation audit failure preserves old secret and does not disclose a replacement', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'rollback' })).body.apiKey;
  const repository = app.locals.pageRepository;
  const audit = repository.createAuditLog;
  repository.createAuditLog = async () => { throw new Error('synthetic audit failure'); };
  try {
    const result = await request(`/admin/apis/keys/${key.id}/rotate`, 'POST');
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: 'Failed to rotate API key' });
  } finally { repository.createAuditLog = audit; }
  assert.equal((await request('/api/v1/me', 'GET', undefined, key.secret)).body.credentialVersion, '1');
});
