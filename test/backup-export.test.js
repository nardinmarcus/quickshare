const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'backup-export-login-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'backup-export-dashboard-password';
process.env.SHARE_API_KEY = 'backup-export-api-key';
process.env.SESSION_SECRET = 'backup-export-session-secret-0123456789';

const app = require('../app');

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

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${process.env.ADMIN_DASHBOARD_PASSWORD}`
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
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

test('management export is explicitly labeled as a manifest that cannot restore content', async () => {
  const created = await request('/api/v1/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'backup-export-api-key'
    },
    body: JSON.stringify({
      htmlContent: '<p>Manifest labeling fixture body</p>',
      title: 'Manifest labeling fixture'
    })
  });
  assert.equal(created.status, 200);
  const createdPayload = JSON.parse(created.text);

  const dashboardCookie = await loginDashboard();
  const response = await request('/admin/pages/export', {
    headers: { Cookie: dashboardCookie }
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'] || '', /quickshare-export\.json/);

  const payload = JSON.parse(response.text);

  // New labeling (T03): the export must identify itself as a manifest that
  // carries no body content and cannot be used to restore on its own.
  assert.equal(payload.kind, 'manifest');
  assert.equal(payload.includesContent, false);
  assert.equal(payload.restorable, false);
  assert.match(payload.notice, /清单/);
  assert.match(payload.notice, /不包含正文/);
  assert.match(payload.notice, /不能独立用于恢复/);

  // Format compatibility: the pre-existing fields are unchanged.
  assert.equal(typeof payload.exportedAt, 'number');
  assert.equal(payload.total, payload.pages.length);
  const exported = payload.pages.find(page => page.id === createdPayload.urlId);
  assert.ok(exported);
  assert.equal(exported.title, 'Manifest labeling fixture');
  assert.deepEqual(
    Object.keys(exported).sort(),
    ['codeType', 'createdAt', 'description', 'expiresAt', 'id', 'isFavorite', 'isProtected', 'title']
  );
  assert.ok(!('htmlContent' in exported));
  assert.ok(!response.text.includes('Manifest labeling fixture body'));
});

test('management export still requires dashboard authentication', async () => {
  const response = await request('/admin/pages/export');
  assert.notEqual(response.status, 200);
  assert.ok(!response.text.includes('"kind":"manifest"'));
});
