const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = '<redacted>';
process.env.SESSION_SECRET = '<redacted>';

const app = require('../app');
const {
  encryptSecret,
  hashSecret
} = require('../utils/security');
const {
  NEUTRAL_PAGE_TITLE,
  NEUTRAL_PAGE_DESCRIPTION
} = require('../utils/publicProjection');

let server;
let baseUrl;

test.before(async () => {
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

function jsonRequest(path, method, body, headers = {}) {
  return request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const REAL_TITLE = 't02-real-title-marker';
const REAL_DESCRIPTION = 't02-real-description-marker';

async function seedPage({ id, password = null, expiresAt = null, isProtected = null }) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: `<h1>secret-body-${id}</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: isProtected !== null ? isProtected : Boolean(password),
    codeType: 'html',
    title: REAL_TITLE,
    description: REAL_DESCRIPTION,
    expiresAt,
    markdownTheme: null
  });
}

async function unlock(id, password) {
  const response = await jsonRequest(`/view/${id}/password`, 'POST', { password });
  assert.equal(response.status, 200);
  assert.equal(response.body.valid, true);
  const cookieHeader = response.headers['set-cookie']?.find(cookie => cookie.startsWith(`page_access_${id}=`));
  assert.ok(cookieHeader);
  return cookieHeader.split(';')[0];
}

test('locked protected share metadata is neutral and leaks no real title or description', async () => {
  await seedPage({ id: 't02-locked', password: 'First1!' });

  const metadata = await request('/api/pages/t02-locked');

  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.success, true);
  assert.equal(metadata.body.page.id, 't02-locked');
  assert.equal(metadata.body.page.isProtected, true);
  assert.equal(metadata.body.page.accessRevision, '1');
  assert.equal(metadata.body.page.title, NEUTRAL_PAGE_TITLE);
  assert.equal(metadata.body.page.description, NEUTRAL_PAGE_DESCRIPTION);
  assert.doesNotMatch(metadata.text, new RegExp(REAL_TITLE));
  assert.doesNotMatch(metadata.text, new RegExp(REAL_DESCRIPTION));
  assert.doesNotMatch(metadata.text, /secret-body-t02-locked/);
});

test('locked protected view page source carries no real title, description, or content', async () => {
  await seedPage({ id: 't02-locked-page', password: 'First1!' });

  const view = await request('/view/t02-locked-page');

  assert.equal(view.status, 200);
  assert.match(view.text, /此内容受密码保护/);
  assert.doesNotMatch(view.text, new RegExp(REAL_TITLE));
  assert.doesNotMatch(view.text, new RegExp(REAL_DESCRIPTION));
  assert.doesNotMatch(view.text, /secret-body-t02-locked-page/);

  const ogTitle = view.text.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const ogDescription = view.text.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
  assert.ok(ogTitle && !ogTitle.includes(REAL_TITLE));
  assert.ok(ogDescription && !ogDescription.includes(REAL_DESCRIPTION));
  assert.match(view.text, /<meta property="og:image" content="[^"]*\/icon\/web\/icon-512\.png/);
});

test('valid unlock restores real metadata and readable content', async () => {
  await seedPage({ id: 't02-unlocked', password: 'First1!' });
  const cookie = await unlock('t02-unlocked', 'First1!');

  const metadata = await request('/api/pages/t02-unlocked', { headers: { Cookie: cookie } });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.page.title, REAL_TITLE);
  assert.equal(metadata.body.page.description, REAL_DESCRIPTION);

  const view = await request('/view/t02-unlocked', { headers: { Cookie: cookie } });
  assert.equal(view.status, 200);
  assert.match(view.text, /secret-body-t02-unlocked/);
  assert.match(view.text, new RegExp(`<meta property="og:title" content="[^"]*${REAL_TITLE}`));
});

test('public share keeps its real title and description everywhere', async () => {
  await seedPage({ id: 't02-public' });

  const metadata = await request('/api/pages/t02-public');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.page.isProtected, false);
  assert.equal(metadata.body.page.title, REAL_TITLE);
  assert.equal(metadata.body.page.description, REAL_DESCRIPTION);

  const view = await request('/view/t02-public');
  assert.equal(view.status, 200);
  assert.match(view.text, /secret-body-t02-public/);
  assert.match(view.text, new RegExp(`<meta property="og:title" content="[^"]*${REAL_TITLE}`));
  assert.match(view.text, new RegExp(`<meta property="og:description" content="${REAL_DESCRIPTION}"`));
});

test('expired protected share returns 410 with no content-derived information', async () => {
  await seedPage({ id: 't02-expired', password: 'First1!', expiresAt: Date.now() - 60_000 });

  const metadata = await request('/api/pages/t02-expired');
  assert.equal(metadata.status, 410);
  assert.deepEqual(metadata.body, { success: false, error: '此分享已失效' });
  assert.doesNotMatch(metadata.text, new RegExp(REAL_TITLE));

  const view = await request('/view/t02-expired');
  assert.equal(view.status, 410);
  assert.match(view.text, /此分享已失效/);
  assert.doesNotMatch(view.text, new RegExp(REAL_TITLE));
  assert.doesNotMatch(view.text, new RegExp(REAL_DESCRIPTION));
  assert.doesNotMatch(view.text, /secret-body-t02-expired/);
});

test('missing share stays a generic 404 on metadata and view surfaces', async () => {
  const metadata = await request('/api/pages/t02-missing');
  assert.equal(metadata.status, 404);
  assert.deepEqual(metadata.body, { success: false, error: '页面不存在' });

  const view = await request('/view/t02-missing');
  assert.equal(view.status, 404);
  assert.match(view.text, /页面未找到|页面不存在/);
});

test('a credential revoked by a policy change falls back to neutral metadata', async () => {
  await seedPage({ id: 't02-revoked', password: 'First1!' });
  const staleCookie = await unlock('t02-revoked', 'First1!');

  const before = await request('/api/pages/t02-revoked', { headers: { Cookie: staleCookie } });
  assert.equal(before.body.page.title, REAL_TITLE);

  const newHash = await hashSecret('Second2@');
  const result = await app.locals.pageRepository.updateProtectionWithAccessRevision('t02-revoked', {
    isProtected: true,
    passwordHash: newHash,
    encryptedPassword: encryptSecret('Second2@')
  }, {
    expectedAccessRevision: '1',
    advanceAccessRevision: true
  });
  assert.equal(result.status, 'updated');

  const after = await request('/api/pages/t02-revoked', { headers: { Cookie: staleCookie } });
  assert.equal(after.status, 200);
  assert.equal(after.body.page.title, NEUTRAL_PAGE_TITLE);
  assert.equal(after.body.page.description, NEUTRAL_PAGE_DESCRIPTION);
  assert.doesNotMatch(after.text, new RegExp(REAL_TITLE));

  const freshCookie = await unlock('t02-revoked', 'Second2@');
  const restored = await request('/api/pages/t02-revoked', { headers: { Cookie: freshCookie } });
  assert.equal(restored.body.page.title, REAL_TITLE);
});
