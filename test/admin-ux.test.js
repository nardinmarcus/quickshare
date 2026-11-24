const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin-ux-frontend-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'admin-ux-dashboard-password';
process.env.SHARE_API_KEY = 'admin-ux-api-key';
process.env.SESSION_SECRET = 'admin-ux-secret';

const app = require('../app');
const { hashSecret, encryptSecret } = require('../utils/security');

let server;
let baseUrl;
let dashboardCookie;

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
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

function authed(route) {
  return request(route, { headers: { Cookie: dashboardCookie } });
}

test.before(async () => {
  await app.locals.pageRepository.create({
    id: 'admin-ux-page',
    htmlContent: '<h1>Admin UX</h1>',
    createdAt: Date.now(),
    passwordHash: await hashSecret('ux-pass-1'),
    encryptedPassword: encryptSecret('ux-pass-1'),
    isProtected: true,
    codeType: 'html',
    title: 'Admin UX page',
    description: 'Admin UX fixture',
    expiresAt: null,
    markdownTheme: null
  });
  await app.locals.pageRepository.createApiKey({
    id: 'admin-ux-key',
    name: 'Admin UX key',
    keyHash: await hashSecret('admin-ux-key-secret-0123456789'),
    keyPrefix: 'qs.adminux…',
    createdAt: Date.now()
  });
  await app.locals.pageRepository.createAuditLog({
    action: 'page.create',
    pageId: 'admin-ux-page',
    details: '{"source":"test"}',
    ip: '127.0.0.1'
  });
  await app.locals.pageRepository.createAuditLog({
    action: 'custom.unknown',
    pageId: 'admin-ux-page',
    details: '{}',
    ip: '127.0.0.1'
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const login = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(process.env.ADMIN_DASHBOARD_PASSWORD)
  });
  dashboardCookie = login.headers['set-cookie']
    .find((value) => value.startsWith('dashboard_admin_session='))
    .split(';')[0];
});

test.after(() => {
  server.close();
});

test('admin list filters apply themselves: debounced search and completed date range', async () => {
  const script = await authed('/js/admin.js');

  assert.equal(script.status, 200);
  assert.match(script.text, /function applySearch\(\)/);
  assert.match(script.text, /searchDebounce = setTimeout\(applySearch, 600\)/);
  assert.match(script.text, /function applyDateFilter\(\)/);
  assert.match(script.text, /dateFromInput\.value && dateToInput\.value\) applyDateFilter\(\)/);
});

test('api scopes auto-save in place and grant rules fold into details', async () => {
  const apis = await authed('/admin/apis');
  const script = await authed('/js/admin-apis.js');

  assert.equal(apis.status, 200);
  assert.doesNotMatch(apis.text, /api-key-scopes-btn/);
  assert.doesNotMatch(apis.text, /保存范围/);
  assert.match(apis.text, /class="api-scope-status"[^>]*>改动会自动保存</);
  assert.match(apis.text, /<details class="api-grant-details">/);
  assert.match(apis.text, /范围决定能做什么，授权决定能碰哪个/);
  assert.match(script.text, /function queueScopeSave\(row\)/);
  assert.match(script.text, /保存中…/);
  assert.doesNotMatch(script.text, /api-key-scopes-btn/);
});

test('detail page copies link and password in one action and folds history guidance', async () => {
  const detail = await authed('/admin/pages/admin-ux-page');
  const script = await authed('/js/admin-detail.js');

  assert.equal(detail.status, 200);
  assert.match(detail.text, /id="copy-public-link-btn"/);
  assert.match(detail.text, /复制链接和密码/);
  assert.match(detail.text, /查看、比较或恢复某个旧版本；恢复只改内容，不动密码与有效期。/);
  assert.match(detail.text, /<details class="admin-history-details">/);
  assert.match(script.text, /copyPublicLinkBtn\.addEventListener/);
  assert.match(script.text, /链接: \$\{url\}\\n密码: \$\{password\}/);
});

test('audit log labels actions in Chinese and keeps the raw code in the title', async () => {
  const audit = await authed('/admin/audit');

  assert.equal(audit.status, 200);
  assert.match(audit.text, /title="page\.create">创建分享</);
  // Unknown actions fall back to the raw code instead of disappearing.
  assert.match(audit.text, /title="custom\.unknown">custom\.unknown</);
});

test('admin motion reuses the publish-flow tokens and reveal', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');

  assert.match(css, /\.admin-modal:not\(\[hidden\]\) \.admin-modal-content,[\s\S]*?animation: publishReveal var\(--motion-normal\) var\(--motion-easing\)/);
  assert.match(css, /@keyframes adminBarGrowX/);
  assert.match(css, /\.admin-day-fill\s*\{[^}]*animation: adminBarGrowY var\(--motion-normal\)/s);
  assert.match(css, /\.api-scope-status\s*\{/);
});
