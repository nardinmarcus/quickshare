const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin123';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard-secret';
process.env.SHARE_API_KEY = 'backup-export-key';
process.env.SESSION_SECRET = 'backup-export-secret';
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
      'X-API-Key': 'backup-export-key'
    },
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 200);
  return JSON.parse(response.text);
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

test('management export keeps the documented metadata-only inventory wire format', async () => {
  const protectedPage = await createSharedPage({
    htmlContent: '<h1>Inventory fixture protected</h1><!--inventory-body-only-qs27-->',
    title: 'Inventory fixture protected',
    codeType: 'html',
    isProtected: true,
    password: 'inv4Pass!'
  });
  const themedPage = await createSharedPage({
    htmlContent: '# Inventory markdown fixture',
    title: 'Inventory markdown fixture',
    codeType: 'markdown',
    markdownTheme: 'github'
  });
  await app.locals.pageRepository.setFavorite(themedPage.urlId, true);
  const dashboardCookie = await loginDashboard();

  const response = await request('/admin/pages/export', { headers: { Cookie: dashboardCookie } });
  const payload = JSON.parse(response.text);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'] || '', /quickshare-export\.json/);
  assert.deepEqual(Object.keys(payload).sort(), ['exportedAt', 'pages', 'total']);

  const exportedById = new Map(payload.pages.map(page => [page.id, page]));
  const protectedEntry = exportedById.get(protectedPage.urlId);
  const themedEntry = exportedById.get(themedPage.urlId);

  assert.deepEqual(
    Object.keys(protectedEntry).sort(),
    ['codeType', 'createdAt', 'description', 'expiresAt', 'id', 'isFavorite', 'isProtected', 'title']
  );
  assert.equal(protectedEntry.isProtected, true);
  assert.equal(protectedEntry.isFavorite, false);
  assert.equal(themedEntry.isFavorite, true);

  // The inventory must never carry Share content or credential material.
  assert.equal(response.text.includes('htmlContent'), false);
  assert.equal(response.text.includes('html_content'), false);
  assert.equal(response.text.includes('inventory-body-only-qs27'), false);
  assert.equal(response.text.includes('password'), false);
  assert.match(response.headers['content-type'] || '', /^application\/json/);
});

test('admin pages view labels the export as a metadata inventory that cannot restore', async () => {
  await createSharedPage({
    htmlContent: '<h1>Inventory label fixture</h1>',
    title: 'Inventory label fixture'
  });
  const dashboardCookie = await loginDashboard();

  const response = await request('/admin/pages', { headers: { Cookie: dashboardCookie } });

  assert.equal(response.status, 200);
  assert.match(response.text, /导出清单/);
  assert.match(response.text, /仅元数据/);
  assert.match(response.text, /不含正文/);
  assert.match(response.text, /不可独立恢复/);
  assert.equal(response.text.includes('导出数据'), false);
});
