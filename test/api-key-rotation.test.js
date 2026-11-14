const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { hashSecret } = require('../utils/security');
const { ApiKeyCredentialChangedError } = require('../utils/apiKeyIdentity');

// Managed Key rotation (T05, issue #29): rotation keeps the logical Key
// ID, replaces the secret, advances credential_version, and invalidates
// the old secret immediately — including for a write that verified the old
// credential before the rotation committed.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin123';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard-secret';
process.env.SESSION_SECRET = 'api-key-rotation-secret';
process.env.TZ = 'UTC';

const app = require('../app');
const repository = app.locals.pageRepository;

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const body = options.body || '';
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? '' : JSON.stringify(body)
  }).then(res => ({ ...res, json: JSON.parse(res.text) }));
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard-secret'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCsrf(cookie) {
  const page = await request('/admin/apis', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const match = page.text.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function createKeyViaAdmin(cookie, csrf, name) {
  const res = await jsonRequest('/admin/apis/keys', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { name }
  });

  assert.equal(res.status, 201);
  return res.json.apiKey;
}

function createShare(secret, htmlContent = '<h1>rotation test</h1>') {
  return jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': secret },
    body: { htmlContent }
  });
}

test('rotation keeps the logical Key, invalidates old secrets, and only shows the new secret once', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const created = await createKeyViaAdmin(cookie, csrf, 'Rotation lifecycle key');

  assert.equal(created.credential_version, '1');
  assert.match(created.secret, /^qs\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(created.key_hash, undefined);

  // The original secret works and reports credential version 1.
  assert.equal((await createShare(created.secret)).status, 200);
  const meBefore = await jsonRequest('/api/v1/me', { headers: { 'X-API-Key': created.secret } });
  assert.equal(meBefore.json.credential.keyId, created.id);
  assert.equal(meBefore.json.credential.credentialVersion, '1');

  // Rotation requires the dashboard session and CSRF, like create/delete.
  const noSession = await request(`/admin/apis/keys/${created.id}/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(noSession.status, 302);

  const noCsrf = await jsonRequest(`/admin/apis/keys/${created.id}/rotate`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: {}
  });
  assert.equal(noCsrf.status, 403);

  const rotated = await jsonRequest(`/admin/apis/keys/${created.id}/rotate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });

  assert.equal(rotated.status, 200);
  const rotatedKey = rotated.json.apiKey;
  assert.equal(rotatedKey.id, created.id);
  assert.equal(rotatedKey.name, created.name);
  assert.equal(rotatedKey.created_at, created.created_at);
  assert.equal(rotatedKey.credential_version, '2');
  assert.ok(rotatedKey.secret);
  assert.notEqual(rotatedKey.secret, created.secret);
  assert.equal(rotatedKey.key_hash, undefined);

  // The old secret is dead everywhere, immediately.
  assert.equal((await createShare(created.secret)).status, 401);
  const meOld = await jsonRequest('/api/v1/me', { headers: { 'X-API-Key': created.secret } });
  assert.equal(meOld.status, 401);

  // The new secret works and reports version 2.
  assert.equal((await createShare(rotatedKey.secret)).status, 200);
  const meAfter = await jsonRequest('/api/v1/me', { headers: { 'X-API-Key': rotatedKey.secret } });
  assert.equal(meAfter.json.credential.keyId, created.id);
  assert.equal(meAfter.json.credential.credentialVersion, '2');

  // The admin list shows the new version and never any secret or hash.
  const listPage = await request('/admin/apis', { headers: { Cookie: cookie } });
  const rowStart = listPage.text.indexOf(`data-api-key-id="${created.id}"`);
  assert.ok(rowStart >= 0);
  const row = listPage.text.slice(rowStart, rowStart + 2000);
  assert.match(row, /api-key-version">2</);
  assert.ok(!listPage.text.includes(created.secret));
  assert.ok(!listPage.text.includes(rotatedKey.secret));
  assert.ok(!listPage.text.includes('key_hash'));

  // Rotation is audited with the new version and without secret material.
  const rotateLogs = (await repository.listAuditLogs({ limit: 200 }))
    .filter(log => log.action === 'api_key.rotate');
  assert.equal(rotateLogs.length, 1);
  assert.deepEqual(JSON.parse(rotateLogs[0].details), {
    apiKeyId: created.id,
    credentialVersion: '2'
  });
  assert.ok(!rotateLogs[0].details.includes(rotatedKey.secret));

  // A second rotation advances to 3 and kills the second secret too.
  const rotatedAgain = await jsonRequest(`/admin/apis/keys/${created.id}/rotate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });
  assert.equal(rotatedAgain.json.apiKey.credential_version, '3');
  assert.equal((await createShare(rotatedKey.secret)).status, 401);
  assert.equal((await createShare(rotatedAgain.json.apiKey.secret)).status, 200);

  // Existing delete behavior still works after rotations.
  const deleted = await jsonRequest(`/admin/apis/keys/${created.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf }
  });
  assert.equal(deleted.status, 200);
  assert.equal((await createShare(rotatedAgain.json.apiKey.secret)).status, 401);
});

test('rotating an unknown Key is a 404 and does not create anything', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);

  const res = await jsonRequest('/admin/apis/keys/no-such-key-id/rotate', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });

  assert.equal(res.status, 404);
  assert.equal(res.json.success, false);
  assert.equal(await repository.getApiKeyById('no-such-key-id'), null);
});

test('a write carrying a pre-rotation credential version is refused after rotation commits', async () => {
  // This is the request lifecycle the version recheck exists for: the
  // credential verified successfully (version 1 recorded), then the owner
  // rotated, and only then did the write reach the repository. The HTTP
  // race itself is proven against real Postgres in
  // test/integration/postgres-api-keys.test.js; here the same repository
  // contract is exercised through the in-memory Adapter.
  const id = 'stale-write-key';
  const secret = 'stale-write-secret-12345';
  await repository.createApiKey({
    id,
    name: 'Stale write key',
    keyHash: await hashSecret(secret),
    keyPrefix: 'qs.stalewri…',
    createdAt: Date.now()
  });

  const verifiedCredential = { type: 'managed', keyId: id, credentialVersion: '1' };
  const page = {
    id: 'stale-write-page',
    htmlContent: '<h1>must not be stored</h1>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Stale',
    description: null,
    expiresAt: null,
    markdownTheme: null
  };

  await repository.rotateApiKey(id, {
    keyHash: await hashSecret('stale-write-secret-rotated'),
    keyPrefix: 'qs.stalewri…'
  });

  await assert.rejects(
    repository.create(page, { apiCredential: verifiedCredential }),
    error => error instanceof ApiKeyCredentialChangedError
      && error.code === 'api_key_credential_changed'
  );
  assert.equal(await repository.getById(page.id), null);

  // The current version still writes.
  await repository.create(
    { ...page, id: 'fresh-write-page' },
    { apiCredential: { type: 'managed', keyId: id, credentialVersion: '2' } }
  );
  assert.ok(await repository.getById('fresh-write-page'));

  // Deletion is the same revocation: a write verified before the delete
  // committed is refused and stores nothing.
  const deleteId = 'deleted-write-key';
  await repository.createApiKey({
    id: deleteId,
    name: 'Deleted write key',
    keyHash: await hashSecret('deleted-write-secret-123'),
    keyPrefix: 'qs.deletedw…',
    createdAt: Date.now()
  });
  await repository.deleteApiKey(deleteId);

  await assert.rejects(
    repository.create(
      { ...page, id: 'deleted-write-page' },
      { apiCredential: { type: 'managed', keyId: deleteId, credentialVersion: '1' } }
    ),
    error => error.code === 'api_key_credential_changed'
  );
  assert.equal(await repository.getById('deleted-write-page'), null);
});

test('rotation is a gated write: refused during write maintenance, available after resume', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const created = await createKeyViaAdmin(cookie, csrf, 'Maintenance rotation key');

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const res = await jsonRequest(`/admin/apis/keys/${created.id}/rotate`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
      body: {}
    });

    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'maintenance');
    // The refused rotation changed nothing: version and secret stand.
    const stored = await repository.getApiKeyById(created.id);
    assert.equal(stored.credential_version, '1');
    assert.equal((await createShare(created.secret)).status, 503);
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  const rotated = await jsonRequest(`/admin/apis/keys/${created.id}/rotate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.json.apiKey.credential_version, '2');
});
