const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'view-route-secret';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');

let server;
let baseUrl;

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
    }, (res) => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function seedPage({ id, expiresAt = null, password = null }) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: `<h1>${id}</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: id,
    description: null,
    expiresAt,
    markdownTheme: null
  });
}

test.before(async () => {
  const now = Date.now();

  await seedPage({ id: 'no-expiry' });
  await seedPage({ id: 'future-expiry', expiresAt: now + 60_000 });
  await seedPage({ id: 'future-protected', expiresAt: now + 60_000, password: '654321' });
  await seedPage({ id: 'expired-page', expiresAt: now - 60_000 });
  await seedPage({ id: 'expired-protected', expiresAt: now - 60_000, password: '123456' });
  await seedPage({ id: 'expiry-boundary', expiresAt: now + 120_000 });

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

test('public repository treats expires_at <= now as expired', async () => {
  const page = await app.locals.pageRepository.getById('expiry-boundary');
  const beforeExpiry = await app.locals.pageRepository.getPublicById('expiry-boundary', page.expires_at - 1);
  const atExpiry = await app.locals.pageRepository.getPublicById('expiry-boundary', page.expires_at);
  const afterExpiry = await app.locals.pageRepository.getPublicById('expiry-boundary', page.expires_at + 1);

  assert.equal(beforeExpiry.page.id, 'expiry-boundary');
  assert.equal(beforeExpiry.expired, false);
  assert.equal(atExpiry.expired, true);
  assert.equal(afterExpiry.expired, true);
  assert.equal(await app.locals.pageRepository.getPublicById('missing-page', Date.now()), null);
});

test('public view works without expiry and before a future expiry', async () => {
  const noExpiry = await request('/view/no-expiry');
  const futureExpiry = await request('/view/future-expiry');
  const metadataResponse = await request('/api/pages/future-expiry');
  const metadata = JSON.parse(metadataResponse.text);
  const { createdAt, ...metadataPage } = metadata.page;

  assert.equal(noExpiry.status, 200);
  assert.match(noExpiry.text, /&lt;h1&gt;no-expiry&lt;\/h1&gt;/);
  assert.equal(futureExpiry.status, 200);
  assert.match(futureExpiry.text, /&lt;h1&gt;future-expiry&lt;\/h1&gt;/);
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadata.success, true);
  assert.ok(Number.isFinite(createdAt));
  assert.deepEqual(metadataPage, {
    id: 'future-expiry',
    codeType: 'html',
    title: 'future-expiry',
    description: null,
    isProtected: false
  });
});

test('password validation still grants access before expiry', async () => {
  const passwordBody = JSON.stringify({ password: '654321' });
  const response = await request('/view/future-protected/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: passwordBody
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    valid: true,
    redirectUrl: '/view/future-protected'
  });
  assert.ok(response.headers['set-cookie']?.some(cookie => cookie.startsWith('page_access_future-protected=')));
});

test('expired public routes return 410 without granting access', async () => {
  const viewResponse = await request('/view/expired-page');
  const metadataResponse = await request('/api/pages/expired-page');
  const passwordBody = JSON.stringify({ password: '123456' });
  const passwordResponse = await request('/view/expired-protected/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: passwordBody
  });

  assert.equal(viewResponse.status, 410);
  assert.match(viewResponse.text, /此分享已失效/);
  assert.equal(metadataResponse.status, 410);
  assert.deepEqual(JSON.parse(metadataResponse.text), {
    success: false,
    error: '此分享已失效'
  });
  assert.equal(passwordResponse.status, 410);
  assert.deepEqual(JSON.parse(passwordResponse.text), {
    valid: false,
    error: '此分享已失效'
  });
  assert.equal(passwordResponse.headers['set-cookie'], undefined);
});

test('expired rows remain available in admin while missing rows stay 404', async () => {
  const adminResponse = await request('/admin/pages/expired-page');
  const missingView = await request('/view/missing-page');
  const missingMetadata = await request('/api/pages/missing-page');

  assert.equal(adminResponse.status, 200);
  assert.match(adminResponse.text, /expired-page/);
  assert.equal(missingView.status, 404);
  assert.equal(missingMetadata.status, 404);
});
