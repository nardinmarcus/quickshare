const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'boundary-admin';
process.env.ADMIN_DASHBOARD_PASSWORD = 'boundary-dashboard';
process.env.SHARE_API_KEY = 'boundary-api-key';
process.env.SESSION_SECRET = 'boundary-session-secret';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');

let server;
let baseUrl;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request(new URL(path, baseUrl), {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null
      }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(path, body, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test.before(async () => {
  const password = 'Ab9!_?~';

  await app.locals.pageRepository.create({
    id: 'boundary-protected',
    htmlContent: '<h1>Protected boundary</h1>',
    createdAt: Date.now(),
    passwordHash: await hashSecret(password),
    encryptedPassword: encryptSecret(password),
    isProtected: true,
    codeType: 'html',
    title: 'Protected boundary',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

test('responses expose baseline security headers without Express fingerprinting', async () => {
  const response = await request('/login');

  assert.equal(response.status, 200);
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
});

test('login, admin, password, metadata, and secret-bearing responses are private no-store', async () => {
  const login = await request('/login');
  const admin = await request('/admin/login');
  const protectedView = await request('/view/boundary-protected');
  const metadata = await request('/api/pages/boundary-protected');
  const password = await jsonRequest('/view/boundary-protected/password', { password: 'wrong' });
  const created = await jsonRequest('/api/v1/share', {
    htmlContent: '<h1>Boundary response</h1>',
    isProtected: true
  }, { 'X-API-Key': 'boundary-api-key' });

  for (const response of [login, admin, protectedView, metadata, password, created]) {
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});

test('small form and JSON routes reject bodies above 16 KB', async () => {
  const oversizedLogin = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${'a'.repeat(17 * 1024)}`
  });
  const oversizedPassword = await jsonRequest('/view/boundary-protected/password', {
    password: 'a'.repeat(17 * 1024)
  });

  assert.equal(oversizedLogin.status, 413);
  assert.equal(oversizedPassword.status, 413);
  assert.equal(oversizedPassword.body.error, '请求内容过大');
});

test('share routes accept ordinary content and reject bodies above 2 MB', async () => {
  const ordinary = await jsonRequest('/api/v1/share', {
    htmlContent: `<h1>Ordinary</h1><p>${'a'.repeat(32 * 1024)}</p>`
  }, { 'X-API-Key': 'boundary-api-key' });
  const oversized = await jsonRequest('/api/v1/share', {
    htmlContent: 'a'.repeat((2 * 1024 * 1024) + 1)
  }, { 'X-API-Key': 'boundary-api-key' });

  assert.equal(ordinary.status, 200);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, '请求内容过大');
});
