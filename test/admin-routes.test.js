const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin123';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard-secret';
process.env.SHARE_API_KEY = 'admin-route-key';
process.env.SESSION_SECRET = 'admin-route-secret';
process.env.TZ = 'UTC';

const app = require('../app');

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

async function createSharedPage(body) {
  const response = await request('/api/v1/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'admin-route-key'
    },
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 200);
  return JSON.parse(response.text);
}

async function login() {
  const response = await request('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'password=admin123'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function loginDashboard(password = 'dashboard-secret') {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `password=${encodeURIComponent(password)}`
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('maintenance preserves both logins and reads while authentication and CSRF reject before the gate', async () => {
  const repository = app.locals.pageRepository;
  await repository.setPublishingWritesPaused(true);
  try {
    const dashboard = await loginDashboard();
    const home = await login();
    const admin = await request('/admin/stats', { headers: { Cookie: dashboard } });
    assert.equal(admin.status, 200);
    const csrf = admin.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    // The real browser loads the homepage before any submit; that GET
    // establishes the signed publish session used by the creation attempt.
    const homepageForSession = await request('/', { headers: { Cookie: home } });
    assert.equal(homepageForSession.status, 200);
    const publishSession = homepageForSession.headers['set-cookie']?.find(value => value.startsWith('publish_session='));
    assert.ok(publishSession, 'the homepage establishes the publish session');
    const publishSessionCookie = publishSession.split(';')[0];
    assert.equal((await request('/', { headers: { Cookie: home } })).status, 200);
    assert.equal((await request('/admin/apis', { headers: { Cookie: dashboard } })).status, 200);
    for (const [cookie, token, expected] of [[undefined, undefined, 401], [home, csrf, 401], [dashboard, undefined, 403], [dashboard, csrf, 503]]) {
      const response = await request('/admin/settings/homepage-access', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify({ passwordRequired: false })
      });
      assert.equal(response.status, expected);
      if (expected === 503) assert.equal(JSON.parse(response.text).maintenance, true);
    }
    assert.equal(await repository.getHomepagePasswordRequired(), true);
    const homepage = await request('/', { headers: { Cookie: home } });
    const homeCsrf = homepage.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const count = await repository.countPages();
    for (const [token, expected] of [[undefined, 403], [homeCsrf, 503]]) {
      const response = await request('/api/pages/create', {
        method: 'POST', headers: { Cookie: `${home}; ${publishSessionCookie}`, 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify({ htmlContent: '<h1>Must remain unsaved</h1>' })
      });
      assert.equal(response.status, expected);
    }
    assert.equal(await repository.countPages(), count);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }
});

test('admin pages require login', async () => {
  const response = await request('/admin/pages');

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login');
});

test('admin stats require login', async () => {
  const response = await request('/admin/stats');

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login');
});

test('admin entry redirects anonymous users to dashboard login', async () => {
  const response = await request('/admin');

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login');
});

test('regular login does not grant dashboard access', async () => {
  const cookie = await login();
  const response = await request('/admin/pages', {
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin/login');
});

test('favorite mutations require a Dashboard session at the JSON boundary', async () => {
  const sharedPage = await createSharedPage({ htmlContent: '<h1>Favorite auth</h1>' });
  const regularCookie = await login();
  const body = JSON.stringify({ isFavorite: true });
  const anonymousResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const regularSessionResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: regularCookie,
      'Content-Type': 'application/json'
    },
    body
  });

  assert.equal(anonymousResponse.status, 401);
  assert.equal(regularSessionResponse.status, 401);
  assert.deepEqual(JSON.parse(anonymousResponse.text), {
    success: false,
    error: 'Unauthorized'
  });
});

test('favorite mutations require Dashboard CSRF and a strict boolean payload', async () => {
  const sharedPage = await createSharedPage({ htmlContent: '<h1>Favorite validation</h1>' });
  const cookie = await loginDashboard();
  const detailResponse = await request(`/admin/pages/${sharedPage.urlId}`, {
    headers: { Cookie: cookie }
  });
  const csrfToken = detailResponse.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];

  assert.ok(csrfToken);

  const missingCsrfResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ isFavorite: true })
  });
  const invalidPayloadResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ isFavorite: 'true' })
  });
  const malformedJsonResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: '{'
  });

  assert.equal(missingCsrfResponse.status, 403);
  assert.equal(invalidPayloadResponse.status, 400);
  assert.equal(malformedJsonResponse.status, 400);
  assert.equal((await app.locals.pageRepository.getById(sharedPage.urlId)).is_favorite, false);
});

test('favorite mutations persist final state and audit only real transitions', async () => {
  const sharedPage = await createSharedPage({ htmlContent: '<h1>Favorite transition route</h1>' });
  const cookie = await loginDashboard();
  const detailResponse = await request(`/admin/pages/${sharedPage.urlId}`, {
    headers: { Cookie: cookie }
  });
  const csrfToken = detailResponse.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken
  };

  const favoriteResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ isFavorite: true })
  });
  const repeatedResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ isFavorite: true })
  });
  const unfavoriteResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ isFavorite: false })
  });

  assert.deepEqual(JSON.parse(favoriteResponse.text), {
    success: true,
    changed: true,
    isFavorite: true
  });
  assert.deepEqual(JSON.parse(repeatedResponse.text), {
    success: true,
    changed: false,
    isFavorite: true
  });
  assert.deepEqual(JSON.parse(unfavoriteResponse.text), {
    success: true,
    changed: true,
    isFavorite: false
  });
  assert.equal((await app.locals.pageRepository.getById(sharedPage.urlId)).is_favorite, false);

  const logs = (await app.locals.pageRepository.listAuditLogs({ limit: 200 }))
    .filter(log => log.action === 'page.favorite.update' && log.pageId === sharedPage.urlId);
  const auditResponse = await request('/admin/audit', { headers: { Cookie: cookie } });
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(log => JSON.parse(log.details)).reverse(), [
    { from: false, to: true },
    { from: true, to: false }
  ]);
  assert.match(auditResponse.text, />Favorite Share 状态更新</);
  assert.doesNotMatch(auditResponse.text, />page\.favorite\.update</);
});

test('favorite mutation and audit errors roll back the Share transaction', async () => {
  const sharedPage = await createSharedPage({ htmlContent: '<h1>Favorite failure boundaries</h1>' });
  const cookie = await loginDashboard();
  const detailResponse = await request(`/admin/pages/${sharedPage.urlId}`, {
    headers: { Cookie: cookie }
  });
  const csrfToken = detailResponse.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken
  };
  const repository = app.locals.pageRepository;
  const originalCreateAuditLog = repository.createAuditLog;
  const originalSetFavorite = repository.setFavorite;
  const originalConsoleError = console.error;
  const loggedErrors = [];

  try {
    console.error = (...args) => loggedErrors.push(args);
    repository.createAuditLog = async () => {
      const error = new Error('postgres://user:secret@example.test/quickshare');
      error.name = 'postgres://audit-name:secret@example.test/quickshare';
      error.code = 'DATABASE_PASSWORD_SECRET';
      throw error;
    };

    const auditFailureResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isFavorite: true })
    });

    assert.equal(auditFailureResponse.status, 500);
    assert.equal(JSON.parse(auditFailureResponse.text).success, false);
    assert.equal((await repository.getById(sharedPage.urlId)).is_favorite, false);
    assert.deepEqual(loggedErrors, [['Update favorite failed:']]);

    repository.createAuditLog = originalCreateAuditLog;
    const missingResponse = await request('/admin/pages/missing-favorite-route/favorite', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isFavorite: true })
    });
    assert.equal(missingResponse.status, 404);
    assert.equal(JSON.parse(missingResponse.text).error, 'Share not found');

    repository.setFavorite = async () => {
      throw new Error('persistence unavailable');
    };
    const persistenceFailureResponse = await request(`/admin/pages/${sharedPage.urlId}/favorite`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isFavorite: false })
    });

    assert.equal(persistenceFailureResponse.status, 500);
    assert.equal((await repository.getById(sharedPage.urlId)).is_favorite, false);
  } finally {
    repository.createAuditLog = originalCreateAuditLog;
    repository.setFavorite = originalSetFavorite;
    console.error = originalConsoleError;
  }
});

test('dashboard login rejects the regular creation password', async () => {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'password=admin123'
  });

  assert.equal(response.status, 401);
  assert.doesNotMatch(response.text, /dashboard_admin_session/);
  assert.match(response.text, /id="login-error"[^>]+role="alert"/);
  assert.match(response.text, /id="password-input"[^>]+aria-invalid="true"[^>]+aria-describedby="login-error"/);
});

test('dashboard login and entry default to stats', async () => {
  const cookie = await loginDashboard();
  const entryResponse = await request('/admin', {
    headers: { Cookie: cookie }
  });
  const loginResponse = await request('/admin/login', {
    headers: { Cookie: cookie }
  });

  assert.equal(entryResponse.status, 302);
  assert.equal(entryResponse.headers.location, '/admin/stats');
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.location, '/admin/stats');
});

test('admin pages list and detail expose content without password hashes', async () => {
  const publicPage = await createSharedPage({
    htmlContent: '<h1>Visible Admin Content</h1>',
    codeType: 'html',
    title: 'Visible Title',
    description: 'Visible Description'
  });
  const protectedPage = await createSharedPage({
    htmlContent: '# Protected Admin Content',
    codeType: 'markdown',
    title: 'Protected Title',
    isProtected: true
  });
  const cookie = await loginDashboard();

  const listResponse = await request('/admin/pages', {
    headers: { Cookie: cookie }
  });

  assert.equal(listResponse.status, 200);
  assert.match(listResponse.text, /分享管理/);
  assert.match(listResponse.text, /Visible Title/);
  assert.match(listResponse.text, /Protected Title/);
  assert.match(listResponse.text, new RegExp(`/admin/pages/${publicPage.urlId}`));
  assert.match(listResponse.text, new RegExp(protectedPage.password));
  assert.doesNotMatch(listResponse.text, /secret-v1\$/);
  assert.doesNotMatch(listResponse.text, /scrypt\$/);

  const detailResponse = await request(`/admin/pages/${protectedPage.urlId}`, {
    headers: { Cookie: cookie }
  });

  assert.equal(detailResponse.status, 200);
  assert.match(detailResponse.text, /Protected Admin Content/);
  assert.match(detailResponse.text, /Protected/);
  assert.match(detailResponse.text, new RegExp(protectedPage.password));
  assert.doesNotMatch(detailResponse.text, /password_hash/);
  assert.doesNotMatch(detailResponse.text, /secret-v1\$/);
  assert.doesNotMatch(detailResponse.text, /scrypt\$/);
});

test('Favorite Shares combine with all filters and keep totals, pagination, and links aligned', async () => {
  const repository = app.locals.pageRepository;
  const matchingCreatedAt = Date.parse('2026-07-10T12:00:00Z');

  for (let index = 1; index <= 51; index += 1) {
    const id = `issue7-filter-match-${String(index).padStart(2, '0')}`;
    await repository.create({
      id,
      htmlContent: '# Favorite list match',
      createdAt: matchingCreatedAt + index,
      isProtected: true,
      codeType: 'markdown',
      title: `Issue7 Bulk ${String(index).padStart(2, '0')}`
    });
    await repository.setFavorite(id, true);
  }

  const misses = [
    ['issue7-filter-unmarked', 'markdown', true, matchingCreatedAt, false],
    ['issue7-filter-html', 'html', true, matchingCreatedAt, true],
    ['issue7-filter-public', 'markdown', false, matchingCreatedAt, true],
    ['issue7-filter-old', 'markdown', true, Date.parse('2026-06-30T12:00:00Z'), true]
  ];
  for (const [id, codeType, isProtected, createdAt, favorite] of misses) {
    await repository.create({
      id,
      htmlContent: '# Favorite list miss',
      createdAt,
      isProtected,
      codeType,
      title: `Issue7 Bulk ${id}`
    });
    if (favorite) await repository.setFavorite(id, true);
  }

  const cookie = await loginDashboard();
  const query = new URLSearchParams({
    favorite: 'true',
    search: 'Issue7 Bulk',
    type: 'markdown',
    status: 'protected',
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    sort: 'created_at',
    order: 'asc'
  });
  const firstPage = await request(`/admin/pages?${query}`, { headers: { Cookie: cookie } });
  const secondPage = await request(`/admin/pages?${query}&page=2`, { headers: { Cookie: cookie } });
  const nextHref = firstPage.text
    .match(/<a[^>]+href="([^"]+)"[^>]*>下一页<\/a>/)?.[1]
    .replaceAll('&amp;', '&');
  const previousHref = secondPage.text
    .match(/<a[^>]+href="([^"]+)"[^>]*>上一页<\/a>/)?.[1]
    .replaceAll('&amp;', '&');
  const sortHref = firstPage.text
    .match(/<a class="admin-sortable[^"]*" href="([^"]+)"[^>]*>\s*创建时间/)?.[1]
    .replaceAll('&amp;', '&');
  const searchClearHref = firstPage.text
    .match(/<form class="admin-search-form"[\s\S]*?<a class="cyber-btn cyber-btn-secondary" href="([^"]+)">清除<\/a>[\s\S]*?<\/form>/)?.[1]
    .replaceAll('&amp;', '&');
  const dateClearHref = firstPage.text
    .match(/<div class="admin-date-range">[\s\S]*?<a class="cyber-btn cyber-btn-secondary" href="([^"]+)">清除<\/a>/)?.[1]
    .replaceAll('&amp;', '&');
  const typeHtmlHref = firstPage.text
    .match(/<span class="admin-filter-label">类型<\/span>[\s\S]*?<a class="admin-filter-btn[^"]*" href="([^"]+)">html<\/a>/)?.[1]
    .replaceAll('&amp;', '&');
  const statusPublicHref = firstPage.text
    .match(/<span class="admin-filter-label">状态<\/span>[\s\S]*?<a class="admin-filter-btn[^"]*" href="([^"]+)">公开<\/a>/)?.[1]
    .replaceAll('&amp;', '&');
  const allSharesHref = firstPage.text
    .match(/<span class="admin-filter-label">收藏<\/span>[\s\S]*?<a class="admin-filter-btn[^"]*" href="([^"]+)">全部 Shares<\/a>/)?.[1]
    .replaceAll('&amp;', '&');

  assert.equal(firstPage.status, 200);
  assert.equal(secondPage.status, 200);
  assert.match(firstPage.text, /共 51 个分享/);
  assert.match(firstPage.text, /第 1 \/ 2 页/);
  assert.match(secondPage.text, /第 2 \/ 2 页/);
  assert.match(secondPage.text, /Issue7 Bulk 51/);
  assert.doesNotMatch(secondPage.text, /issue7-filter-unmarked/);
  assert.match(firstPage.text, /data-favorite-toggle[^>]+data-is-favorite="true"[^>]+aria-pressed="true"/);
  assert.match(firstPage.text, /class="fas fa-star admin-favorite-icon"/);
  const listHrefs = Array.from(firstPage.text.matchAll(/href="(\/admin\/pages\?[^\"]+)"/g));
  for (const match of listHrefs) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), baseUrl);
    for (const value of url.searchParams.values()) assert.notEqual(value, '');
  }

  for (const [href, expectedPage] of [[nextHref, '2'], [previousHref, null]]) {
    assert.ok(href);
    const url = new URL(href, baseUrl);
    assert.equal(url.searchParams.get('favorite'), 'true');
    assert.equal(url.searchParams.get('search'), 'Issue7 Bulk');
    assert.equal(url.searchParams.get('type'), 'markdown');
    assert.equal(url.searchParams.get('status'), 'protected');
    assert.equal(url.searchParams.get('dateFrom'), '2026-07-01');
    assert.equal(url.searchParams.get('dateTo'), '2026-07-31');
    assert.equal(url.searchParams.get('sort'), 'created_at');
    assert.equal(url.searchParams.get('order'), 'asc');
    assert.equal(url.searchParams.get('page'), expectedPage);
  }

  const sortUrl = new URL(sortHref, baseUrl);
  assert.equal(sortUrl.searchParams.get('favorite'), 'true');
  assert.equal(sortUrl.searchParams.get('dateFrom'), '2026-07-01');
  assert.equal(sortUrl.searchParams.get('dateTo'), '2026-07-31');
  assert.equal(sortUrl.searchParams.get('sort'), 'created_at');
  assert.equal(sortUrl.searchParams.get('order'), 'desc');
  assert.equal(sortUrl.searchParams.has('page'), false);

  const searchClearUrl = new URL(searchClearHref, baseUrl);
  assert.equal(searchClearUrl.searchParams.has('search'), false);
  assert.equal(searchClearUrl.searchParams.get('favorite'), 'true');
  assert.equal(searchClearUrl.searchParams.get('dateFrom'), '2026-07-01');
  assert.equal(searchClearUrl.searchParams.get('dateTo'), '2026-07-31');

  const dateClearUrl = new URL(dateClearHref, baseUrl);
  assert.equal(dateClearUrl.searchParams.has('dateFrom'), false);
  assert.equal(dateClearUrl.searchParams.has('dateTo'), false);
  assert.equal(dateClearUrl.searchParams.get('search'), 'Issue7 Bulk');
  assert.equal(dateClearUrl.searchParams.get('favorite'), 'true');

  const typeHtmlUrl = new URL(typeHtmlHref, baseUrl);
  assert.equal(typeHtmlUrl.searchParams.get('type'), 'html');
  assert.equal(typeHtmlUrl.searchParams.get('status'), 'protected');
  assert.equal(typeHtmlUrl.searchParams.get('favorite'), 'true');
  assert.equal(typeHtmlUrl.searchParams.get('dateFrom'), '2026-07-01');

  const statusPublicUrl = new URL(statusPublicHref, baseUrl);
  assert.equal(statusPublicUrl.searchParams.get('type'), 'markdown');
  assert.equal(statusPublicUrl.searchParams.get('status'), 'public');
  assert.equal(statusPublicUrl.searchParams.get('favorite'), 'true');
  assert.equal(statusPublicUrl.searchParams.get('dateTo'), '2026-07-31');

  const allSharesUrl = new URL(allSharesHref, baseUrl);
  assert.equal(allSharesUrl.searchParams.has('favorite'), false);
  assert.equal(allSharesUrl.searchParams.get('search'), 'Issue7 Bulk');
  assert.equal(allSharesUrl.searchParams.get('type'), 'markdown');
  assert.equal(allSharesUrl.searchParams.get('status'), 'protected');
  assert.equal(allSharesUrl.searchParams.get('dateFrom'), '2026-07-01');
  assert.equal(allSharesUrl.searchParams.get('dateTo'), '2026-07-31');
});

test('admin list offers only all and Favorite Shares and distinguishes a filtered empty result', async () => {
  const repository = app.locals.pageRepository;
  await repository.create({
    id: 'issue7-canonical-favorite',
    htmlContent: '<h1>Canonical favorite</h1>',
    createdAt: Date.now(),
    title: 'Issue7 Canonical Favorite'
  });
  await repository.create({
    id: 'issue7-canonical-unmarked',
    htmlContent: '<h1>Canonical unmarked</h1>',
    createdAt: Date.now() + 1,
    title: 'Issue7 Canonical Unmarked'
  });
  await repository.setFavorite('issue7-canonical-favorite', true);

  const cookie = await loginDashboard();
  const ignoredFalse = await request('/admin/pages?favorite=false&search=Issue7%20Canonical', {
    headers: { Cookie: cookie }
  });
  const emptyFavorite = await request('/admin/pages?favorite=true&search=Issue7%20No%20Match', {
    headers: { Cookie: cookie }
  });

  assert.match(ignoredFalse.text, />全部 Shares<\/a>/);
  assert.match(ignoredFalse.text, />Favorite Shares<\/a>/);
  assert.doesNotMatch(ignoredFalse.text, /未收藏 Shares|favorite=false/);
  assert.match(ignoredFalse.text, /Issue7 Canonical Favorite/);
  assert.match(ignoredFalse.text, /Issue7 Canonical Unmarked/);
  assert.match(
    ignoredFalse.text,
    /<button\b(?=[^>]*data-page-id="issue7-canonical-favorite")(?=[^>]*aria-pressed="true")[^>]*>/
  );
  assert.match(
    ignoredFalse.text,
    /<button\b(?=[^>]*data-page-id="issue7-canonical-unmarked")(?=[^>]*aria-pressed="false")[^>]*>/
  );

  assert.match(emptyFavorite.text, /没有符合条件的分享/);
  assert.match(emptyFavorite.text, /清除全部筛选条件/);
  assert.doesNotMatch(emptyFavorite.text, /还没有分享/);
});

test('confirmed removal from Favorite Shares recalculates rows, total, empty state, and page', async () => {
  const repository = app.locals.pageRepository;
  await repository.create({
    id: 'issue7-recompute-removal',
    htmlContent: '<h1>Recompute favorite result</h1>',
    createdAt: Date.now(),
    title: 'Issue7 Recompute Removal'
  });
  await repository.setFavorite('issue7-recompute-removal', true);

  const cookie = await loginDashboard();
  const initial = await request('/admin/pages?favorite=true&search=Issue7%20Recompute&page=7', {
    headers: { Cookie: cookie }
  });
  const csrfToken = initial.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const refreshUrl = initial.text
    .match(/<button\b[^>]*data-page-id="issue7-recompute-removal"[^>]*data-refresh-url="([^"]+)"[^>]*>/)?.[1]
    .replaceAll('&amp;', '&');

  assert.ok(csrfToken);
  assert.ok(refreshUrl);
  assert.equal(new URL(refreshUrl, baseUrl).searchParams.has('page'), false);

  const mutation = await request('/admin/pages/issue7-recompute-removal/favorite', {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ isFavorite: false })
  });
  const refreshed = await request(refreshUrl, { headers: { Cookie: cookie } });

  assert.equal(mutation.status, 200);
  assert.equal(JSON.parse(mutation.text).isFavorite, false);
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.text, /共 0 个分享/);
  assert.match(refreshed.text, /没有符合条件的分享/);
  assert.doesNotMatch(refreshed.text, /data-page-id="issue7-recompute-removal"/);
  assert.doesNotMatch(refreshed.text, /第 [2-9] \/ /);
});

test('admin stats render aggregate charts', async () => {
  await createSharedPage({
    htmlContent: '<h1>Stats HTML</h1>',
    codeType: 'html',
    title: 'Stats HTML'
  });
  await createSharedPage({
    htmlContent: '# Stats Markdown',
    codeType: 'markdown',
    title: 'Stats Markdown',
    isProtected: true
  });
  const cookie = await loginDashboard();
  const response = await request('/admin/stats', {
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 200);
  assert.match(response.text, /数据统计/);
  assert.match(response.text, /分享总数/);
  assert.match(response.text, /内容类型/);
  assert.match(response.text, /markdown/);
  assert.doesNotMatch(response.text, /password_hash/);
});

test('admin Share list and detail render Beijing time under a UTC process', async () => {
  const repository = app.locals.pageRepository;
  await repository.create({
    id: 'beijing-time-display',
    htmlContent: '<h1>Beijing display</h1>',
    title: 'Beijing display',
    createdAt: Date.parse('2026-07-22T10:53:32.000Z'),
    expiresAt: Date.parse('2026-07-23T10:30:32.123Z')
  });
  const cookie = await loginDashboard();
  const list = await request('/admin/pages?search=Beijing%20display', {
    headers: { Cookie: cookie }
  });
  const detail = await request('/admin/pages/beijing-time-display', {
    headers: { Cookie: cookie }
  });

  assert.match(
    list.text,
    /datetime="2026-07-22T10:53:32\.000Z">2026\/7\/22 18:53:32<\/time>/
  );
  assert.match(
    detail.text,
    /datetime="2026-07-23T10:30:32\.123Z">2026\/7\/23 18:30:32<\/time>/
  );
  assert.match(detail.text, /value="2026-07-23T18:30:32\.123"/);
});

test('admin page detail returns 404 for missing pages', async () => {
  const cookie = await loginDashboard();
  const response = await request('/admin/pages/missing-page', {
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 404);
});

test('admin page detail safely serializes user-controlled content', async () => {
  const maliciousContent = '</script><script>window.__quickshareXss = true</script>&>\u2028\u2029';
  const sharedPage = await createSharedPage({
    htmlContent: maliciousContent,
    codeType: 'html',
    title: 'Serialization test'
  });
  const cookie = await loginDashboard();
  const response = await request(`/admin/pages/${sharedPage.urlId}`, {
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 200);
  assert.match(response.text, /<script type="application\/json" id="page-data">/);
  assert.doesNotMatch(response.text, /<\/script><script>window\.__quickshareXss/);
  assert.match(response.text, /\\u003c\/script\\u003e\\u003cscript\\u003ewindow\.__quickshareXss/);
  assert.match(response.text, /\\u0026\\u003e\\u2028\\u2029/);
});

test('admin detail renders the persisted Favorite Share state', async () => {
  const unmarkedPage = await createSharedPage({
    htmlContent: '<h1>Unmarked detail favorite</h1>',
    title: 'Unmarked Share'
  });
  const favoritePage = await createSharedPage({
    htmlContent: '<h1>Marked detail favorite</h1>',
    title: 'Marked Share'
  });
  await app.locals.pageRepository.setFavorite(favoritePage.urlId, true);
  const cookie = await loginDashboard();
  const unmarkedResponse = await request(`/admin/pages/${unmarkedPage.urlId}`, {
    headers: { Cookie: cookie }
  });
  const favoriteResponse = await request(`/admin/pages/${favoritePage.urlId}`, {
    headers: { Cookie: cookie }
  });

  assert.match(
    unmarkedResponse.text,
    /data-favorite-toggle[^>]+aria-pressed="false"[^>]+aria-label="收藏分享 Unmarked Share"/
  );
  assert.match(unmarkedResponse.text, /class="far fa-star admin-favorite-icon"/);
  assert.match(unmarkedResponse.text, /class="admin-favorite-label">收藏</);
  assert.match(unmarkedResponse.text, /"isFavorite":false/);

  assert.match(
    favoriteResponse.text,
    /data-favorite-toggle[^>]+aria-pressed="true"[^>]+aria-label="取消收藏 Marked Share"/
  );
  assert.match(favoriteResponse.text, /class="fas fa-star admin-favorite-icon"/);
  assert.match(favoriteResponse.text, /class="admin-favorite-label">取消收藏</);
  assert.match(favoriteResponse.text, /"isFavorite":true/);
  assert.match(favoriteResponse.text, /src="\/js\/admin-favorite\.js"/);
});

test('dashboard page mutations reject requests without a CSRF token', async () => {
  const updatePage = await createSharedPage({ htmlContent: '<h1>Update CSRF</h1>' });
  const deletePage = await createSharedPage({ htmlContent: '<h1>Delete CSRF</h1>' });
  const batchPage = await createSharedPage({ htmlContent: '<h1>Batch CSRF</h1>' });
  const clonePage = await createSharedPage({ htmlContent: '<h1>Clone CSRF</h1>' });
  const cookie = await loginDashboard();

  const updateResponse = await request(`/admin/pages/${updatePage.urlId}`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title: 'Should not update' })
  });
  const deleteResponse = await request(`/admin/pages/${deletePage.urlId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });
  const batchResponse = await request('/admin/pages/batch', {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ids: [batchPage.urlId] })
  });
  const cloneResponse = await request(`/admin/pages/${clonePage.urlId}/clone`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });

  assert.deepEqual(
    {
      update: updateResponse.status,
      delete: deleteResponse.status,
      batchDelete: batchResponse.status,
      clone: cloneResponse.status
    },
    {
      update: 403,
      delete: 403,
      batchDelete: 403,
      clone: 403
    }
  );
});

test('dashboard page mutations accept the rendered CSRF token', async () => {
  const updatePage = await createSharedPage({ htmlContent: '<h1>Valid update</h1>' });
  const deletePage = await createSharedPage({ htmlContent: '<h1>Valid delete</h1>' });
  const batchPage = await createSharedPage({ htmlContent: '<h1>Valid batch</h1>' });
  const clonePage = await createSharedPage({ htmlContent: '<h1>Valid clone</h1>' });
  const cookie = await loginDashboard();
  const listResponse = await request('/admin/pages', {
    headers: { Cookie: cookie }
  });
  const detailResponse = await request(`/admin/pages/${updatePage.urlId}`, {
    headers: { Cookie: cookie }
  });
  const listCsrfMatch = listResponse.text.match(/name="csrf-token" content="([^"]+)"/);
  const detailCsrfMatch = detailResponse.text.match(/name="csrf-token" content="([^"]+)"/);

  assert.ok(listCsrfMatch);
  assert.ok(detailCsrfMatch);
  assert.match(listResponse.text, /name="_csrf"/);
  assert.match(detailResponse.text, /name="_csrf"/);

  const csrfToken = detailCsrfMatch[1];
  const currentRevision = detailResponse.text.match(/"currentRevision":"(\d+)"/);
  assert.ok(currentRevision, 'detail embeds the content baseline');
  const updateResponse = await request(`/admin/pages/${updatePage.urlId}`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      'If-Match': `\"content:${updatePage.urlId}:${currentRevision[1]}\"`
    },
    body: JSON.stringify({ title: 'Updated with CSRF' })
  });
  const deleteResponse = await request(`/admin/pages/${deletePage.urlId}`, {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrfToken
    }
  });
  const batchResponse = await request('/admin/pages/batch', {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ ids: [batchPage.urlId] })
  });
  const cloneBody = `_csrf=${encodeURIComponent(csrfToken)}`;
  const cloneResponse = await request(`/admin/pages/${clonePage.urlId}/clone`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: cloneBody
  });

  assert.deepEqual(
    {
      update: updateResponse.status,
      delete: deleteResponse.status,
      batchDelete: batchResponse.status,
      clone: cloneResponse.status
    },
    {
      update: 200,
      delete: 200,
      batchDelete: 200,
      clone: 302
    }
  );
});


test('rotation requires dashboard identity and CSRF; paused writes do not disable Key discovery', async () => {
  const cookie = await loginDashboard();
  const page = await request('/admin/apis', { headers: { Cookie: cookie } });
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const created = JSON.parse((await request('/admin/apis/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'CSRF fixture' }) })).text).apiKey;
  const path = `/admin/apis/keys/${created.id}/rotate`;
  assert.equal((await request(path, { method: 'POST' })).status, 302);
  assert.equal((await request(path, { method: 'POST', headers: { Cookie: await login() } })).status, 302);
  assert.equal((await request(path, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'invalid' } })).status, 403);
  assert.equal((await request('/admin/apis/keys/nonexistent/rotate', { method: 'POST', headers })).status, 404);
  for (const discovery of ['/api/v1/me', '/api/v1/capabilities']) {
    assert.equal((await request(discovery, { headers: { Cookie: cookie } })).status, 401);
  }
  await app.locals.pageRepository.setPublishingWritesPaused(true);
  try {
    const paused = await request(path, { method: 'POST', headers });
    assert.equal(paused.status, 503);
    assert.equal(JSON.parse(paused.text).code, 'PUBLISHING_MAINTENANCE');
    assert.doesNotMatch(paused.text, /qs\./);
    for (const discovery of ['/api/v1/me', '/api/v1/capabilities']) {
      assert.equal((await request(discovery, { headers: { 'X-API-Key': created.secret } })).status, 200);
    }
  } finally { await app.locals.pageRepository.setPublishingWritesPaused(false); }
  const rotated = await request(path, { method: 'POST', headers });
  assert.equal(rotated.status, 200);
  assert.equal(JSON.parse(rotated.text).apiKey.credential_version, '2');
});

test('API management creates, documents, and deletes managed keys', async () => {
  const cookie = await loginDashboard();
  const pageResponse = await request('/admin/apis', {
    headers: { Cookie: cookie }
  });

  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.text, /API 管理/);
  assert.match(pageResponse.text, /POST<\/span>\s*<code>\/api\/v1\/share<\/code>/);
  assert.doesNotMatch(pageResponse.text, /key_hash/);

  const csrfMatch = pageResponse.text.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(csrfMatch);

  const createResponse = await request('/admin/apis/keys', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfMatch[1]
    },
    body: JSON.stringify({ name: 'API management test' })
  });

  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.text).apiKey;
  assert.match(created.secret, /^qs\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(created.key_hash, undefined);

  const apiResponse = await request('/api/v1/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': created.secret
    },
    body: JSON.stringify({ htmlContent: '<h1>Managed route key</h1>' })
  });

  assert.equal(apiResponse.status, 200);

  const listResponse = await request('/admin/apis', {
    headers: { Cookie: cookie }
  });
  assert.match(listResponse.text, /API management test/);
  assert.doesNotMatch(listResponse.text, new RegExp(created.secret));
  assert.doesNotMatch(listResponse.text, /key_hash/);

  const deleteResponse = await request('/admin/apis/keys/' + encodeURIComponent(created.id), {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrfMatch[1]
    }
  });

  assert.equal(deleteResponse.status, 200);

  const revokedResponse = await request('/api/v1/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': created.secret
    },
    body: JSON.stringify({ htmlContent: '<h1>Should not be created</h1>' })
  });

  assert.equal(revokedResponse.status, 401);
});

// ---- #33 dashboard content-save idempotency (owner dashboard, CSRF + cookie) ----

async function dashboardSaveContext() {
  const cookie = await loginDashboard();
  const created = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-route-key' },
    body: JSON.stringify({ htmlContent: '<h1>Idem save base</h1>', codeType: 'html', title: 'Idem save' })
  });
  assert.equal(created.status, 200);
  const id = JSON.parse(created.text).urlId;
  const detail = await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } });
  const csrf = detail.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  return { cookie, csrf, id };
}

function saveContentCall({ id, cookie, csrf, ifMatch, requestId, body }) {
  return request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}),
      ...(requestId ? { 'Idempotency-Key': requestId } : {})
    },
    body: JSON.stringify(body)
  });
}

test('a content save with an unknown outcome replays its original result despite the stale If-Match', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();
  const requestId = 'save-replay-012345678901';

  const first = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Idem save edited</h1>', title: 'Saved once' }
  });
  assert.equal(first.status, 200, first.text);
  const firstBody = JSON.parse(first.text);
  assert.equal(firstBody.page.currentRevision, '2');
  assert.equal(firstBody.changed, true, 'new content reports changed before the Memory row can mutate the read baseline');

  // The lost-response retry: original id, original payload, ORIGINAL tag that
  // is stale now. It must confirm the committed save (never a 412 first-fail)
  // and never mint a second revision.
  const replay = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Idem save edited</h1>', title: 'Saved once' }
  });
  assert.equal(replay.status, 200);
  const replayBody = JSON.parse(replay.text);
  assert.equal(replayBody.replayed, true, 'the retry is marked as a confirmed replay');
  assert.equal(replayBody.changed, true, 'the receipt preserves the real committed changed flag');
  assert.equal(replayBody.page.currentRevision, '2', 'the ORIGINAL committed result is confirmed');
  assert.equal(replayBody.page.title, 'Saved once');
  assert.equal(replayBody.page.htmlContent, '<h1>Idem save edited</h1>');

  const live = await app.locals.pageRepository.getById(id);
  assert.equal(String(live.current_revision), '2', 'exactly one content revision exists for both attempts');
  assert.equal(String(live.access_revision), '1', 'the replay performs no access-policy work');
});

test('the same request id with different save input is a 409 conflict', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();
  const requestId = 'save-conflict-0123456789';

  const first = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Version one</h1>' }
  });
  assert.equal(first.status, 200);

  const conflict = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:2"`,
    requestId,
    body: { htmlContent: '<h1>Version two</h1>' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.text).code, 'REQUEST_ID_CONFLICT');

  const live = await app.locals.pageRepository.getById(id);
  assert.equal(String(live.current_revision), '2', 'the conflicting replay commits nothing');
  assert.equal(live.html_content, '<h1>Version one</h1>');
});

test('a same-content no-op save with an id records success and replays changed:false', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();
  const requestId = 'save-noop-0123456789012';

  // The exact same body bytes as the current projection: no new revision.
  const first = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Idem save base</h1>', title: 'Idem save' }
  });
  assert.equal(first.status, 200, first.text);
  const payload = JSON.parse(first.text);
  assert.equal(payload.page.currentRevision, '1', 'same content never mints a revision');
  assert.equal(payload.changed, false, 'fresh no-op response reports unchanged');

  const replay = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Idem save base</h1>', title: 'Idem save' }
  });
  assert.equal(replay.status, 200);
  const replayBody = JSON.parse(replay.text);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.page.currentRevision, '1');
  assert.equal(replayBody.changed, false);
});

test('save digest includes optional immutable codeType and refuses empty idempotent writes', async () => {
  const context = await dashboardSaveContext();
  const options = { ...context, ifMatch: `"content:${context.id}:1"`, requestId: 'save-type-presence-33' };
  const first = await saveContentCall({ ...options, body: { title: 'typed', codeType: 'html' } });
  assert.equal(first.status, 200);
  const changedType = await saveContentCall({ ...options, body: { title: 'typed', codeType: 'svg' } });
  assert.equal(changedType.status, 409, 'changed type must not replay a successful different input');
  const empty = await saveContentCall({ ...options, requestId: 'save-empty-request-33', body: {} });
  assert.equal(empty.status, 400, 'a supplied id must never be silently ignored');
});

test('a replayed save does not leak the password once the access policy changed', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();
  const requestId = 'save-policy-012345678901';

  const protect = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    body: { isProtected: true, expectedAccessRevision: '1' }
  });
  assert.equal(protect.status, 200);
  const protectedBody = JSON.parse(protect.text);
  assert.ok(protectedBody.page.password, 'the original protect response shows the generated password');
  const accessAfterProtect = protectedBody.page.accessRevision;

  // A later content save under the NEW access revision, recorded with an id.
  const contentSave = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Protected edit</h1>' }
  });
  assert.equal(contentSave.status, 200);

  // The owner then turns protection off: the access policy moved on.
  const unprotect = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:2"`,
    body: { isProtected: false, expectedAccessRevision: accessAfterProtect }
  });
  assert.equal(unprotect.status, 200);

  const replay = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId,
    body: { htmlContent: '<h1>Protected edit</h1>' }
  });
  assert.equal(replay.status, 200);
  const replayBody = JSON.parse(replay.text);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.page.isProtected, true, 'isProtected reports the ORIGINAL committed result');
  assert.ok(!replayBody.page.password, 'the generated password never replays after the policy changed');
});

test('an Idempotency-Key on policy-only or combined saves is rejected instead of silently ignored', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();

  const policyOnly = await saveContentCall({
    id, cookie, csrf,
    requestId: 'save-policy-only-0123456',
    body: { isProtected: false, expiresAt: null, expectedAccessRevision: '1' }
  });
  assert.equal(policyOnly.status, 400, 'policy-only saves never claim content-operation dedupe');
  assert.equal(JSON.parse(policyOnly.text).code, 'UNSUPPORTED_REQUEST_ID_SCOPE');

  const combined = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId: 'save-combined-012345678',
    body: { htmlContent: '<h1>Combined</h1>', expiresAt: null, expectedAccessRevision: '1' }
  });
  assert.equal(combined.status, 400, 'a combined save must not partially replay');
  assert.equal(JSON.parse(combined.text).code, 'UNSUPPORTED_REQUEST_ID_SCOPE');

  // Legacy combined saves without an id keep working unchanged.
  const legacyCombined = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    body: { htmlContent: '<h1>Combined legacy</h1>', expiresAt: null, expectedAccessRevision: '1' }
  });
  assert.equal(legacyCombined.status, 200);
});

test('malformed and unsupported save fields return 400 for both fresh IDs and committed replays', async () => {
  const context = await dashboardSaveContext();
  const options = { ...context, ifMatch: `"content:${context.id}:1"`, requestId: 'static-replay-validation-33' };
  assert.equal((await saveContentCall({ ...options, body: { title: 'saved' } })).status, 200);
  const invalidFields = [
    { revokeAccess: 'true' }, { revokeAccess: null }, { revokeAccess: false },
    { password: [] }, { password: 'valid-pass' }, { password: null },
    { expectedAccessRevision: {} }, { expectedAccessRevision: '1' },
    { isProtected: 'false' }, { isProtected: false }, { expiresAt: {} }, { expiresAt: null },
    { htmlContent: [] }, { htmlContent: null }, { title: [] }, { description: {} },
    { markdownTheme: [] }, { codeType: 'unsupported' }, { codeType: {} },
    { published: false }, { favorite: true }
  ];
  for (const [index, fields] of invalidFields.entries()) {
    const body = { title: 'saved', ...fields };
    const fresh = await saveContentCall({ ...options, requestId: `static-fresh-validation-${index}`, body });
    const replay = await saveContentCall({ ...options, body });
    assert.equal(fresh.status, 400, `fresh ${JSON.stringify(fields)}: ${fresh.text}`);
    assert.equal(replay.status, 400, `replay ${JSON.stringify(fields)}: ${replay.text}`);
    assert.deepEqual(JSON.parse(replay.text), JSON.parse(fresh.text), 'validation is independent of operation existence');
  }
  const validReplay = await saveContentCall({ ...options, body: { title: 'saved' } });
  assert.equal(validReplay.status, 200, validReplay.text);
  assert.equal(JSON.parse(validReplay.text).replayed, true, 'valid stale-baseline replay still succeeds');
  assert.equal(String((await app.locals.pageRepository.getById(context.id)).current_revision), '2');
});

test('malformed coercion payload returns controlled 400 in a real HTTP child and leaves it serving', { timeout: 15000 }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const path = require('node:path');
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'VERCEL_ENV', 'NODE_OPTIONS']) delete env[key];
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', '-e', `
    const app = require('./app');
    const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    const [{ port }] = await Promise.race([
      once(child, 'message'),
      exited.then(([code]) => { throw new Error(`HTTP child exited before readiness: ${code}`); })
    ]);
    const base = `http://127.0.0.1:${port}`;
    const call = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(3000) });
    const login = await call('/admin/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=dashboard-secret'
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('dashboard_admin_session=')).split(';')[0];
    const created = await call('/api/v1/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-route-key' },
      body: JSON.stringify({ htmlContent: '<h1>Child base</h1>', codeType: 'html' })
    });
    assert.equal(created.status, 200);
    const id = (await created.json()).urlId;
    const detail = await call(`/admin/pages/${id}`, { headers: { Cookie: cookie } });
    const csrf = (await detail.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'If-Match': `"content:${id}:1"`, 'Idempotency-Key': 'child-static-validation-33' };
    for (const field of ['title', 'description', 'htmlContent', 'markdownTheme', 'codeType', 'expiresAt']) {
      let response;
      try {
        response = await call(`/admin/pages/${id}`, {
          method: 'PUT', headers, body: JSON.stringify({ [field]: { toString: null } })
        });
      } catch (error) {
        // A crashed Express 4 child is a regression, not an unhandled rejection
        // intercepted and hidden by the parent's node:test harness.
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 100))]);
        assert.fail(`expected controlled HTTP 400; child exit=${child.exitCode}; ${error.message}; ${stderr}`);
      }
      assert.equal(response.status, 400, `${field}: ${await response.text()}`);
      assert.equal(child.exitCode, null, 'service remains alive');
      assert.equal((await call(`/admin/pages/${id}`, { headers: { Cookie: cookie } })).status, 200);
    }
    const good = await call(`/admin/pages/${id}`, { method: 'PUT', headers, body: JSON.stringify({ title: 'saved after invalid requests', htmlContent: '  raw\r\nbody  ' }) });
    assert.equal(good.status, 200);
    const result = await good.json();
    assert.equal(result.page.currentRevision, '2');
    assert.equal(result.page.htmlContent, '  raw\r\nbody  ', 'validation never normalizes source text');
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});

test('malformed request ids are rejected with 400 before any save work', async () => {
  const { cookie, csrf, id } = await dashboardSaveContext();
  const response = await saveContentCall({
    id, cookie, csrf,
    ifMatch: `"content:${id}:1"`,
    requestId: 'short',
    body: { htmlContent: '<h1>Never saved</h1>' }
  });
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.text).code, 'INVALID_REQUEST_ID');
  const live = await app.locals.pageRepository.getById(id);
  assert.equal(String(live.current_revision), '1');
});
