const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin123';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard-secret';
process.env.SHARE_API_KEY = 'admin-route-key';
process.env.SESSION_SECRET = 'admin-route-secret';

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
  const updateResponse = await request(`/admin/pages/${updatePage.urlId}`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
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
