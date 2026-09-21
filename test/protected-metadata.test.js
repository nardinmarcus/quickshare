const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'Owner123';
process.env.SHARE_API_KEY = 'issue26-create-only';
process.env.SESSION_SECRET = 'issue26-synthetic-session-secret';
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
// Optional real adapter run uses only this ticket's explicitly named local fixture.
if (process.env.ISSUE26_POSTGRES_TEST_URL) {
  const url = new URL(process.env.ISSUE26_POSTGRES_TEST_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/issue26_[a-z0-9_]+_test$/);
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = url.href;
  process.env.POSTGRES_SSL = 'false';
}
const app = require('../app');
const { createScopedToken } = require('../utils/security');
let server;
let origin;
const sensitive = /SENSITIVE_TITLE_26|SENSITIVE_DESCRIPTION_26|SENSITIVE_BODY_26/;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (app.locals.pageRepository.pool) await app.locals.pageRepository.pool.end();
});
async function request(path, { method = 'GET', body, cookie, key } = {}) {
  return fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'X-API-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function create(isProtected = true) {
  const response = await request('/api/v1/share', { method: 'POST', key: process.env.SHARE_API_KEY, body: {
    htmlContent: '<h1>SENSITIVE_BODY_26</h1>', title: 'SENSITIVE_TITLE_26', description: 'SENSITIVE_DESCRIPTION_26',
    codeType: 'html', isProtected, password: isProtected ? 'Pass123' : undefined
  } });
  assert.equal(response.status, 200);
  return (await response.json()).urlId;
}
async function unlock(id) {
  const response = await request(`/view/${id}/password`, { method: 'POST', body: { password: 'Pass123' } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function owner() {
  const response = await fetch(origin + '/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=Owner123'
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';')[0];
}

test('locked Share metadata refuses sensitive source while a versioned unlock restores normal reading', async () => {
  const id = await create();
  const legacy = `page_access_${id}=${createScopedToken('page-access', { id }, 86400000)}`;
  for (const cookie of [undefined, legacy]) {
    const metadata = await request(`/api/pages/${id}`, { cookie });
    assert.equal(metadata.status, 403);
    assert.doesNotMatch(await metadata.text(), sensitive);
    assert.equal(metadata.headers.get('cache-control'), 'private, no-store');
    const view = await request(`/view/${id}`, { cookie });
    const source = await view.text();
    assert.equal(view.status, 200);
    assert.doesNotMatch(source, sensitive);
    assert.match(source, /og:image[^>]+\/icon\/web\/icon-512\.png/);
    assert.match(source, /此内容受密码保护/);
  }
  const cookie = await unlock(id);
  const metadata = await request(`/api/pages/${id}`, { cookie });
  assert.equal(metadata.status, 200);
  const data = await metadata.json();
  assert.equal(data.page.title, 'SENSITIVE_TITLE_26');
  assert.equal(data.page.description, 'SENSITIVE_DESCRIPTION_26');
  assert.equal('htmlContent' in data.page, false);
  assert.equal('isFavorite' in data.page, false);
  const source = await (await request(`/view/${id}`, { cookie })).text();
  for (const marker of ['SENSITIVE_TITLE_26', 'SENSITIVE_DESCRIPTION_26', 'SENSITIVE_BODY_26']) assert.ok(source.includes(marker));
  assert.match(source, /sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"/);
});

test('protection baseline uses existing owner authorization only and returns no Share metadata', async () => {
  const id = await create();
  const visitor = await unlock(id);
  const legacy = `page_access_${id}=${createScopedToken('page-access', { id }, 86400000)}`;
  const dashboard = `dashboard_admin_session=${createScopedToken('dashboard-admin', {}, 86400000)}`;
  for (const options of [{}, { cookie: visitor }, { cookie: legacy }, { cookie: dashboard }, { key: process.env.SHARE_API_KEY }]) {
    const response = await request(`/api/pages/${id}/protect`, options);
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), sensitive);
  }
  const cookie = await owner();
  const baseline = await request(`/api/pages/${id}/protect`, { cookie });
  assert.equal(baseline.status, 200);
  assert.equal(baseline.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await baseline.json(), { success: true, accessRevision: '1' });
  // Owner credentials do not silently unlock the public metadata surface.
  assert.equal((await request(`/api/pages/${id}`, { cookie })).status, 403);
  const home = await (await request('/', { cookie })).text();
  const csrf = home.match(/name="csrf-token" content="([^"]+)"/)[1];
  const change = await fetch(origin + `/api/pages/${id}/protect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ isProtected: true, password: 'Next123', expectedAccessRevision: '1' })
  });
  assert.equal(change.status, 200);
  assert.equal((await change.json()).accessRevision, '2');
  assert.equal((await request(`/api/pages/${id}`, { cookie: visitor })).status, 403);
  assert.doesNotMatch(await (await request(`/view/${id}`, { cookie: visitor })).text(), sensitive);
  assert.deepEqual(await (await request(`/api/pages/${id}/protect`, { cookie })).json(), { success: true, accessRevision: '2' });
});

test('public Share preserves title/description and missing or expired responses contain no sensitive source', async () => {
  const id = await create(false);
  const metadata = await request(`/api/pages/${id}`);
  assert.equal(metadata.status, 200);
  const data = await metadata.json();
  assert.equal(data.page.title, 'SENSITIVE_TITLE_26');
  assert.equal(data.page.description, 'SENSITIVE_DESCRIPTION_26');
  const source = await (await request(`/view/${id}`)).text();
  assert.match(source, /<title>SENSITIVE_TITLE_26 - QuickShare<\/title>/);
  assert.match(source, /og:description" content="SENSITIVE_DESCRIPTION_26"/);
  const cookie = await owner();
  for (const isProtected of [false, true]) {
    const expiredId = `issue26-expired-${isProtected}-${Date.now()}`;
    await app.locals.pageRepository.create({
      id: expiredId, htmlContent: 'SENSITIVE_BODY_26', title: 'SENSITIVE_TITLE_26', description: 'SENSITIVE_DESCRIPTION_26',
      codeType: 'html', createdAt: Date.now() - 2000, expiresAt: Date.now() - 1000, isProtected
    });
    const versioned = `page_access_${expiredId}=${createScopedToken('page-access', { id: expiredId, accessRevision: '1' }, 86400000)}`;
    for (const visitor of [undefined, versioned]) {
      for (const path of [`/view/${expiredId}`, `/api/pages/${expiredId}`]) {
        const response = await request(path, { cookie: visitor });
        assert.equal(response.status, 410);
        const text = await response.text();
        assert.doesNotMatch(text, sensitive);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        if (path.startsWith('/view/')) assert.match(text, /og:image[^>]+\/icon\/web\/icon-512\.png/);
      }
    }
    const password = await request(`/view/${expiredId}/password`, { method: 'POST', body: { password: 'Pass123' } });
    assert.equal(password.status, 410);
    assert.doesNotMatch(await password.text(), sensitive);
    assert.deepEqual(await (await request(`/api/pages/${expiredId}/protect`, { cookie })).json(), { success: true, accessRevision: '1' });
  }
  for (const path of ['/view/issue26-missing', '/api/pages/issue26-missing', '/api/pages/issue26-missing/protect']) {
    const response = await request(path, { cookie });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), sensitive);
  }
});
