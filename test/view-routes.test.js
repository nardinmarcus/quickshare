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
  const { createdAt, expiresAt, ...metadataPage } = metadata.page;

  assert.equal(noExpiry.status, 200);
  assert.match(noExpiry.text, /&lt;h1&gt;no-expiry&lt;\/h1&gt;/);
  assert.equal(futureExpiry.status, 200);
  assert.match(futureExpiry.text, /&lt;h1&gt;future-expiry&lt;\/h1&gt;/);
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadata.success, true);
  assert.ok(Number.isFinite(createdAt));
  assert.ok(expiresAt > createdAt);
  assert.deepEqual(metadataPage, {
    id: 'future-expiry',
    accessRevision: '1',
    codeType: 'html',
    title: 'future-expiry',
    description: null,
    isProtected: false,
    markdownTheme: null
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

test('protected view uses a conventional password form compatible with legacy values', async () => {
  const response = await request('/view/future-protected');

  assert.equal(response.status, 200);
  assert.match(response.text, /此内容受密码保护/);
  assert.match(response.text, /<label[^>]*for="page-password"[^>]*>请输入密码<\/label>/);
  assert.match(response.text, /type="password"/);
  assert.match(response.text, /autocomplete="current-password"/);
  assert.match(response.text, /<button[^>]*type="submit"[^>]*>解锁并查看<\/button>/);
  assert.doesNotMatch(response.text, /inputmode="numeric"/);
  assert.doesNotMatch(response.text, /pattern="\[0-9\]\*"/);
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

// ---- #35: unpublished Shares share the missing projection (neutral 404). ----

test('an unpublished Share reads as the neutral 404 on every public surface', async () => {
  await seedPage({ id: 'unpublished-page' });
  const page = await app.locals.pageRepository.getById('unpublished-page');
  const result = await app.locals.pageRepository.setPublished('unpublished-page', {
    published: false,
    expectedAccessRevision: String(page.access_revision),
    returnUpdated: true
  });
  assert.equal(result.changed, true);

  const view = await request('/view/unpublished-page');
  assert.equal(view.status, 404);
  assert.match(view.text, /页面不存在/);
  assert.doesNotMatch(view.text, /unpublished-page body/);

  const password = await request('/view/unpublished-page/password', {
    method: 'POST',
    body: JSON.stringify({ password: 'whatever' }),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(password.status, 404);
  assert.deepEqual(JSON.parse(password.text), { valid: false });

  // Repository seam: getPublicById is THE public read; unpublished is null.
  assert.equal(await app.locals.pageRepository.getPublicById('unpublished-page'), null);
});

test('expiry only classifies published Shares: unpublished+expired is 404, not 410', async () => {
  await seedPage({ id: 'unpublished-expired', expiresAt: Date.now() - 60_000 });
  const page = await app.locals.pageRepository.getById('unpublished-expired');
  await app.locals.pageRepository.setPublished('unpublished-expired', {
    published: false,
    expectedAccessRevision: String(page.access_revision),
    returnUpdated: true
  });

  const publicById = await app.locals.pageRepository.getPublicById('unpublished-expired', Date.now());
  assert.equal(publicById, null, 'the public projection never exposes an unpublished Share');

  const view = await request('/view/unpublished-expired');
  assert.equal(view.status, 404);
  assert.doesNotMatch(view.text, /已失效/);
});

test('republishing keeps password and expiry independent and revives access', async () => {
  await seedPage({ id: 'unpublished-protected', password: '774411' });
  const before = await app.locals.pageRepository.getById('unpublished-protected');
  // Memory rows are live references: snapshot the baseline BEFORE any
  // transition mutates the row in place.
  const baselineRevision = String(before.access_revision);
  const baselinePasswordHash = before.password_hash;
  const baselineExpiry = before.expires_at;

  // Unlock BEFORE any transition: this cookie binds the pre-down revision.
  const unlockBefore = await request('/view/unpublished-protected/password', {
    method: 'POST',
    body: JSON.stringify({ password: '774411' }),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(unlockBefore.status, 200);
  const oldCookieHeader = ((unlockBefore.headers['set-cookie'] || [])[0] || '').split(';')[0];
  assert.ok(oldCookieHeader, 'unlock minted a version-bound cookie');

  await app.locals.pageRepository.setPublished('unpublished-protected', {
    published: false,
    expectedAccessRevision: String(before.access_revision),
    returnUpdated: true
  });
  assert.equal((await request('/view/unpublished-protected')).status, 404);
  assert.equal((await request('/view/unpublished-protected', { headers: { Cookie: oldCookieHeader } })).status, 404,
    'the pre-down cookie cannot revive an unpublished Share either');

  const afterDown = await app.locals.pageRepository.getById('unpublished-protected');
  const result = await app.locals.pageRepository.setPublished('unpublished-protected', {
    published: true,
    expectedAccessRevision: String(afterDown.access_revision),
    returnUpdated: true
  });
  assert.equal(result.changed, true);
  const afterUp = result.page;

  assert.equal(afterUp.password_hash, baselinePasswordHash, 'password untouched by either transition');
  assert.equal(afterUp.expires_at, baselineExpiry, 'expiry untouched by either transition');
  assert.equal(
    String(afterUp.access_revision) === String(BigInt(baselineRevision) + 2n),
    true,
    'both transitions bumped the revision exactly once each'
  );

  // The pre-transition cookie is version-bound: the republished Share is
  // locked again for that visitor (neutral password form, HTTP 200).
  const viewWithOldCookie = await request('/view/unpublished-protected', { headers: { Cookie: oldCookieHeader } });
  assert.equal(viewWithOldCookie.status, 200);
  assert.match(viewWithOldCookie.text, /password/i);
  assert.doesNotMatch(viewWithOldCookie.text, /unpublished-protected body/);

  const unlockAfter = await request('/view/unpublished-protected/password', {
    method: 'POST',
    body: JSON.stringify({ password: '774411' }),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(unlockAfter.status, 200);
  const freshCookie = ((unlockAfter.headers['set-cookie'] || [])[0] || '').split(';')[0];
  assert.equal((await request('/view/unpublished-protected', { headers: { Cookie: freshCookie } })).status, 200);
});
