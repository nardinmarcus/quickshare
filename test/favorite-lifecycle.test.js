const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'favorite-lifecycle-home';
process.env.ADMIN_DASHBOARD_PASSWORD = 'favorite-lifecycle-dashboard';
process.env.SHARE_API_KEY = 'favorite-lifecycle-api-key';
process.env.SESSION_SECRET = 'favorite-lifecycle-session-secret';

const app = require('../app');
const { PostgresPageRepository } = require('../models/postgres-pages');

let server;
let baseUrl;

function request(route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request(new URL(route, baseUrl), {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

async function createViaShareApi(input) {
  const response = await request('/api/v1/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'favorite-lifecycle-api-key'
    },
    body: JSON.stringify(input)
  });

  assert.equal(response.status, 200);
  return JSON.parse(response.text);
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=favorite-lifecycle-dashboard'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function loginHomepage() {
  const response = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=favorite-lifecycle-home'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function getCsrfToken(route, cookie) {
  const response = await request(route, { headers: { Cookie: cookie } });
  const token = response.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];

  assert.equal(response.status, 200);
  assert.ok(token);
  return token;
}

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

test('management export includes every Share with a boolean favorite state and ignores list filters', async () => {
  const favorite = await createViaShareApi({
    htmlContent: '<h1>Favorite export fixture</h1>',
    title: 'Favorite export fixture'
  });
  const unmarked = await createViaShareApi({
    htmlContent: '<h1>Unmarked export fixture</h1>',
    title: 'Unmarked export fixture'
  });
  await app.locals.pageRepository.setFavorite(favorite.urlId, true);
  const dashboardCookie = await loginDashboard();

  const response = await request(
    '/admin/pages/export?favorite=true&search=does-not-match&type=svg&status=protected&page=99',
    { headers: { Cookie: dashboardCookie } }
  );
  const payload = JSON.parse(response.text);
  const exportedFixtures = payload.pages
    .filter(page => page.id === favorite.urlId || page.id === unmarked.urlId)
    .map(page => ({ id: page.id, isFavorite: page.isFavorite }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expected = [
    { id: favorite.urlId, isFavorite: true },
    { id: unmarked.urlId, isFavorite: false }
  ].sort((left, right) => left.id.localeCompare(right.id));

  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'] || '', /quickshare-export\.json/);
  assert.deepEqual(exportedFixtures, expected);
  assert.equal(payload.total, 2);
});

test('public Repository lookup omits administrative favorite metadata', async () => {
  const sharedPage = await createViaShareApi({
    htmlContent: '<h1>Public projection fixture</h1>',
    title: 'Public projection fixture'
  });
  await app.locals.pageRepository.setFavorite(sharedPage.urlId, true);

  const publicPage = await app.locals.pageRepository.getPublicById(sharedPage.urlId, Date.now());

  assert.ok(publicPage);
  assert.equal(publicPage.expired, false);
  assert.equal(Object.hasOwn(publicPage.page, 'is_favorite'), false);
  assert.equal(Object.hasOwn(publicPage.page, 'isFavorite'), false);
});

test('PostgreSQL public lookup applies the same Favorite Share projection boundary', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = {
    async query() {
      return {
        rows: [{
          id: 'postgres-public-projection',
          html_content: '<h1>PostgreSQL public projection</h1>',
          is_favorite: true,
          is_expired: false
        }]
      };
    }
  };

  const publicPage = await repository.getPublicById('postgres-public-projection', Date.now());

  assert.ok(publicPage);
  assert.equal(Object.hasOwn(publicPage.page, 'is_favorite'), false);
  assert.equal(Object.hasOwn(publicPage.page, 'isFavorite'), false);
});

test('homepage and Share API creation always start unmarked and do not accept favorite state', async () => {
  const apiPage = await createViaShareApi({
    htmlContent: '<h1>API creation boundary</h1>',
    title: 'API creation boundary',
    isFavorite: true
  });
  const homepageCookie = await loginHomepage();
  const homepageCsrf = await getCsrfToken('/', homepageCookie);
  const homepageResponse = await request('/api/pages/create', {
    method: 'POST',
    headers: {
      Cookie: homepageCookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'X-CSRF-Token': homepageCsrf
    },
    body: JSON.stringify({
      htmlContent: '<h1>Homepage creation boundary</h1>',
      title: 'Homepage creation boundary',
      isFavorite: true
    })
  });
  const homepagePage = JSON.parse(homepageResponse.text);

  assert.equal(homepageResponse.status, 200);
  assert.equal(Object.hasOwn(apiPage, 'isFavorite'), false);
  assert.equal(Object.hasOwn(homepagePage, 'isFavorite'), false);
  assert.equal((await app.locals.pageRepository.getById(apiPage.urlId)).is_favorite, false);
  assert.equal((await app.locals.pageRepository.getById(homepagePage.urlId)).is_favorite, false);
});

test('cloning a Favorite Share resets the clone while preserving its source', async () => {
  const source = await createViaShareApi({
    htmlContent: '<h1>Clone lifecycle source</h1>',
    title: 'Clone lifecycle source'
  });
  await app.locals.pageRepository.setFavorite(source.urlId, true);
  const dashboardCookie = await loginDashboard();
  const csrfToken = await getCsrfToken(`/admin/pages/${source.urlId}`, dashboardCookie);

  const response = await request(`/admin/pages/${source.urlId}/clone`, {
    method: 'POST',
    headers: {
      Cookie: dashboardCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `_csrf=${encodeURIComponent(csrfToken)}`
  });

  assert.equal(response.status, 302);
  assert.ok(response.headers.location);
  const cloneId = decodeURIComponent(response.headers.location.split('/').at(-1));
  assert.equal((await app.locals.pageRepository.getById(source.urlId)).is_favorite, true);
  assert.equal((await app.locals.pageRepository.getById(cloneId)).is_favorite, false);
});

test('editing and expiring a Favorite Share preserves state and keeps admin favorite operations available', async () => {
  const sharedPage = await createViaShareApi({
    htmlContent: '<h1>Editable lifecycle fixture</h1>',
    title: 'Editable lifecycle fixture'
  });
  await app.locals.pageRepository.setFavorite(sharedPage.urlId, true);
  const dashboardCookie = await loginDashboard();
  const csrfToken = await getCsrfToken(`/admin/pages/${sharedPage.urlId}`, dashboardCookie);
  const expiresAt = Date.now() - 60_000;

  const updateResponse = await request(`/admin/pages/${sharedPage.urlId}`, {
    method: 'PUT',
    headers: {
      Cookie: dashboardCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({
      title: 'Edited lifecycle fixture',
      htmlContent: '<h1>Edited lifecycle content</h1>',
      expiresAt,
      isProtected: true,
      password: 'Safe9!'
    })
  });
  const storedAfterUpdate = await app.locals.pageRepository.getById(sharedPage.urlId);
  const publicView = await request(`/view/${sharedPage.urlId}`);
  const publicMetadata = await request(`/api/pages/${sharedPage.urlId}`);
  const publicPassword = await request(`/view/${sharedPage.urlId}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Safe9!' })
  });
  const adminDetail = await request(`/admin/pages/${sharedPage.urlId}`, {
    headers: { Cookie: dashboardCookie }
  });
  const unmarkResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: dashboardCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ isFavorite: false })
  });
  const remarkResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: dashboardCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ isFavorite: true })
  });
  const adminProjection = await app.locals.pageRepository.listAdminPages({
    search: sharedPage.urlId,
    limit: 10,
    offset: 0
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(storedAfterUpdate.is_favorite, true);
  assert.equal(storedAfterUpdate.expires_at, expiresAt);
  assert.equal(storedAfterUpdate.is_protected, 1);
  assert.equal(publicView.status, 410);
  assert.equal(publicMetadata.status, 410);
  assert.equal(publicPassword.status, 410);
  assert.equal(adminDetail.status, 200);
  assert.match(adminDetail.text, /"isFavorite":true/);
  assert.equal(unmarkResponse.status, 200);
  assert.equal(JSON.parse(unmarkResponse.text).isFavorite, false);
  assert.equal(remarkResponse.status, 200);
  assert.equal(JSON.parse(remarkResponse.text).isFavorite, true);
  assert.equal(adminProjection.length, 1);
  assert.equal(adminProjection[0].is_favorite, true);
  assert.equal(adminProjection[0].expires_at, expiresAt);
});

test('deleting a Favorite Share removes the entity and its favorite state from management data', async () => {
  const sharedPage = await createViaShareApi({
    htmlContent: '<h1>Delete lifecycle fixture</h1>',
    title: 'Delete lifecycle fixture'
  });
  await app.locals.pageRepository.setFavorite(sharedPage.urlId, true);
  const dashboardCookie = await loginDashboard();
  const csrfToken = await getCsrfToken(`/admin/pages/${sharedPage.urlId}`, dashboardCookie);

  const deleteResponse = await request(`/admin/pages/${sharedPage.urlId}`, {
    method: 'DELETE',
    headers: {
      Cookie: dashboardCookie,
      'X-CSRF-Token': csrfToken
    }
  });
  const missingFavorite = await app.locals.pageRepository.setFavorite(sharedPage.urlId, true);
  const exportResponse = await request('/admin/pages/export', {
    headers: { Cookie: dashboardCookie }
  });
  const exportPayload = JSON.parse(exportResponse.text);

  assert.equal(deleteResponse.status, 200);
  assert.equal(await app.locals.pageRepository.getById(sharedPage.urlId), null);
  assert.deepEqual(missingFavorite, {
    found: false,
    changed: false,
    isFavorite: false,
    previousValue: null
  });
  assert.equal(exportPayload.pages.some(page => page.id === sharedPage.urlId), false);
});

test('public routes, recent data, view events, and statistics never expose Favorite Share state', async () => {
  const sharedPage = await createViaShareApi({
    htmlContent: '<h1>Public boundary content</h1>',
    title: 'Public boundary content',
    isProtected: true,
    password: 'Open9!',
    isFavorite: true
  });
  await app.locals.pageRepository.setFavorite(sharedPage.urlId, true);
  const homepageCookie = await loginHomepage();
  const dashboardCookie = await loginDashboard();
  const storedBeforeView = await app.locals.pageRepository.getById(sharedPage.urlId);
  const viewCountBefore = storedBeforeView.view_count;

  const passwordGate = await request(`/view/${sharedPage.urlId}`);
  const metadataResponse = await request(`/api/pages/${sharedPage.urlId}`);
  const recentResponse = await request('/api/pages/list/recent?limit=50', {
    headers: { Cookie: homepageCookie }
  });
  const passwordResponse = await request(`/view/${sharedPage.urlId}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Open9!' })
  });
  const accessCookie = passwordResponse.headers['set-cookie']
    ?.find(value => value.startsWith(`page_access_${sharedPage.urlId}=`))
    ?.split(';')[0];
  const publicView = await request(`/view/${sharedPage.urlId}`, {
    headers: { Cookie: accessCookie }
  });
  const viewEvent = await request(`/view/${sharedPage.urlId}/view-event`, {
    method: 'POST',
    headers: {
      Cookie: accessCookie,
      Origin: baseUrl
    }
  });
  const statsResponse = await request('/admin/stats', {
    headers: { Cookie: dashboardCookie }
  });
  const storedAfterView = await app.locals.pageRepository.getById(sharedPage.urlId);
  const metadata = JSON.parse(metadataResponse.text);
  const recent = JSON.parse(recentResponse.text).pages.find(page => page.id === sharedPage.urlId);
  const password = JSON.parse(passwordResponse.text);
  const favoriteFieldPattern = /isFavorite|is_favorite|data-favorite-toggle|admin-favorite/;

  assert.equal(Object.hasOwn(sharedPage, 'isFavorite'), false);
  assert.equal(new URL(sharedPage.url).pathname, `/view/${sharedPage.urlId}`);
  assert.equal(passwordGate.status, 200);
  assert.doesNotMatch(passwordGate.text, favoriteFieldPattern);
  assert.equal(metadataResponse.status, 200);
  assert.equal(Object.hasOwn(metadata.page, 'isFavorite'), false);
  assert.equal(Object.hasOwn(metadata.page, 'is_favorite'), false);
  assert.ok(recent);
  assert.equal(Object.hasOwn(recent, 'isFavorite'), false);
  assert.equal(Object.hasOwn(recent, 'is_favorite'), false);
  assert.deepEqual(password, {
    valid: true,
    redirectUrl: `/view/${sharedPage.urlId}`
  });
  assert.ok(accessCookie);
  assert.equal(publicView.status, 200);
  assert.match(publicView.text, /Public boundary content/);
  assert.doesNotMatch(publicView.text, favoriteFieldPattern);
  assert.equal(viewEvent.status, 204);
  assert.equal(viewEvent.text, '');
  assert.equal(storedAfterView.view_count, viewCountBefore + 1);
  assert.equal(statsResponse.status, 200);
  assert.doesNotMatch(statsResponse.text, /isFavorite|is_favorite/);
  assert.equal((await app.locals.pageRepository.getById(sharedPage.urlId)).is_favorite, true);
});

test('management export does not truncate collections above the former 10,000 Share limit', async () => {
  const repository = app.locals.pageRepository;
  const baselineCount = await repository.countPages();
  const firstId = 'export-over-limit-00000';
  const lastId = 'export-over-limit-10000';
  const createdAt = Date.now();

  for (let index = 0; index <= 10_000; index += 1) {
    await repository.create({
      id: `export-over-limit-${String(index).padStart(5, '0')}`,
      htmlContent: '<p>Export boundary</p>',
      createdAt: createdAt + index,
      title: `Export boundary ${index}`
    });
  }

  const dashboardCookie = await loginDashboard();
  const response = await request('/admin/pages/export?favorite=true&search=does-not-match', {
    headers: { Cookie: dashboardCookie }
  });
  const payload = JSON.parse(response.text);

  assert.equal(response.status, 200);
  assert.equal(payload.total, baselineCount + 10_001);
  assert.equal(payload.pages.some(page => page.id === firstId), true);
  assert.equal(payload.pages.some(page => page.id === lastId), true);
});
