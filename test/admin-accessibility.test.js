const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'admin-access';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard-access';
process.env.SHARE_API_KEY = 'admin-access-api-key';
process.env.SESSION_SECRET = 'admin-access-session';

const app = require('../app');

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

test.before(async () => {
  await app.locals.pageRepository.create({
    id: 'admin-accessibility',
    htmlContent: '<h1>Accessible admin</h1>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Accessible admin',
    description: 'Accessibility test record',
    expiresAt: null,
    markdownTheme: null
  });
  await app.locals.pageRepository.createAuditLog({
    action: 'page.create',
    pageId: 'admin-accessibility',
    details: '{"source":"test"}',
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
    body: 'password=dashboard-access'
  });
  dashboardCookie = login.headers['set-cookie']
    .find((value) => value.startsWith('dashboard_admin_session='))
    .split(';')[0];
});

test.after(() => {
  server.close();
});

async function adminRequest(route) {
  return request(route, { headers: { Cookie: dashboardCookie } });
}

test('admin sections share a Chinese navigation with the current page identified', async () => {
  const routes = [
    ['/admin/stats', 'stats'],
    ['/admin/pages', 'pages'],
    ['/admin/apis', 'apis'],
    ['/admin/audit', 'audit']
  ];

  for (const [route, current] of routes) {
    const response = await adminRequest(route);
    assert.equal(response.status, 200);
    assert.match(response.text, /<nav class="admin-actions admin-nav" aria-label="管理后台">/);
    assert.match(response.text, new RegExp(`data-nav-id="${current}"[^>]+aria-current="page"`));
    assert.match(response.text, />统计</);
    assert.match(response.text, />分享</);
    assert.match(response.text, />API</);
    assert.match(response.text, />审计</);
    assert.match(response.text, />新建</);
  }
});

test('admin tables expose captions, column scopes, sorting state, and bounded scrolling', async () => {
  const pages = await adminRequest('/admin/pages?sort=created_at&order=desc');
  const audit = await adminRequest('/admin/audit');
  const apis = await adminRequest('/admin/apis');

  assert.match(pages.text, /class="admin-table-wrap"[^>]+tabindex="0"[^>]+aria-label="分享列表，可横向滚动"/);
  assert.match(pages.text, /<caption class="sr-only">分享列表<\/caption>/);
  assert.match(pages.text, /<th scope="col" aria-sort="descending">/);
  assert.doesNotMatch(pages.text, /<th\b(?![^>]*scope="col")[^>]*>/);

  assert.match(audit.text, /<caption class="sr-only">审计日志<\/caption>/);
  assert.doesNotMatch(audit.text, /<th\b(?![^>]*scope="col")[^>]*>/);
  assert.match(apis.text, /<caption class="sr-only">API 密钥列表<\/caption>/);
  assert.doesNotMatch(apis.text, /<th\b(?![^>]*scope="col")[^>]*>/);
});

test('statistics include text equivalents for every visual chart', async () => {
  const stats = await adminRequest('/admin/stats');

  assert.match(stats.text, /id="content-types-summary"/);
  assert.match(stats.text, /id="protection-summary"/);
  assert.match(stats.text, /id="top-viewed-summary"/);
  assert.match(stats.text, /id="recent-shares-summary"/);
  assert.match(stats.text, /最近 14 天/);
});

test('detail tabs expose complete relationships and keyboard-ready state', async () => {
  const detail = await adminRequest('/admin/pages/admin-accessibility');

  assert.match(detail.text, /class="admin-content-tabs" role="tablist" aria-label="内容视图"/);
  assert.match(detail.text, /id="tab-raw"[^>]+aria-controls="panel-raw"[^>]+tabindex="0"/);
  assert.match(detail.text, /id="tab-rendered"[^>]+aria-controls="panel-rendered"[^>]+tabindex="-1"/);
  assert.match(detail.text, /id="panel-raw"[^>]+aria-labelledby="tab-raw"/);
  assert.match(detail.text, /id="panel-rendered"[^>]+aria-labelledby="tab-rendered"/);
});

test('delete modal and tabs implement one accessible keyboard controller', () => {
  const adminScript = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');
  const detailScript = fs.readFileSync(path.join(__dirname, '../public/js/admin-detail.js'), 'utf8');

  assert.match(adminScript, /function openDeleteModal\(/);
  assert.match(adminScript, /lastFocusedElement/);
  assert.match(adminScript, /focusableElements/);
  assert.match(adminScript, /event\.key === 'Tab'/);
  assert.match(adminScript, /lastFocusedElement\.focus\(\)/);
  assert.doesNotMatch(adminScript, /cloneNode/);
  assert.match(detailScript, /ArrowRight/);
  assert.match(detailScript, /ArrowLeft/);
  assert.match(detailScript, /event\.key === 'Home'/);
  assert.match(detailScript, /event\.key === 'End'/);
});

test('busy deletion cannot be dismissed and exposes progress', () => {
  const pages = fs.readFileSync(path.join(__dirname, '../views/admin-pages.ejs'), 'utf8');
  const adminScript = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');

  assert.match(pages, /id="delete-modal-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(adminScript, /function closeDeleteModal\(\) \{[\s\S]*?aria-busy'\) === 'true'[\s\S]*?return;/);
  assert.match(adminScript, /cancelBtn\.disabled = true/);
  assert.match(adminScript, /modalStatus\.textContent = '正在删除，请稍候…'/);
});

test('detail editor discards hidden invalid passwords and invalidates stale previews', () => {
  const detailScript = fs.readFileSync(path.join(__dirname, '../public/js/admin-detail.js'), 'utf8');

  assert.match(detailScript, /if \(!protectedCheckbox\.checked\) \{[\s\S]*?passwordInput\.value = ''/);
  assert.match(detailScript, /protectedCheckbox\.checked && customPassword && !customPasswordPattern\.test\(customPassword\)/);
  assert.match(detailScript, /if \(protectedCheckbox\.checked && customPassword\) payload\.password = customPassword/);
  assert.match(detailScript, /function resetRenderedPreview\(\)/);
  assert.match(detailScript, /resetRenderedPreview\(\);/);
});

test('global feedback, focus, targets, and responsive admin CSS are accessible', async () => {
  const pages = await adminRequest('/admin/pages');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');

  assert.match(pages.text, /id="error-toast"[^>]+role="alert"[^>]+aria-atomic="true"/);
  assert.match(pages.text, /id="success-toast"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /\.admin-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.admin-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.admin-table-wrap::?-webkit-scrollbar[\s\S]*?height:\s*8px/);
  assert.match(css, /\.admin-delete-btn[\s\S]*?min-height:\s*44px/);
});

test('the HTML syntax highlighter loads the valid highlight.js language module', () => {
  const footer = fs.readFileSync(path.join(__dirname, '../views/partials/footer.ejs'), 'utf8');

  assert.doesNotMatch(footer, /languages\/html\.min\.js/);
  assert.match(footer, /languages\/xml\.min\.js/);
});

test('syntax highlighting degrades safely when the CDN is unavailable', () => {
  const syntaxScript = fs.readFileSync(path.join(__dirname, '../public/js/syntax-highlight.js'), 'utf8');
  const contentRenderer = fs.readFileSync(path.join(__dirname, '../utils/contentRenderer.js'), 'utf8');

  assert.match(syntaxScript, /if \(typeof window\.hljs === 'undefined'\) return;/);
  assert.equal((contentRenderer.match(/if \(window\.hljs\) \{/g) || []).length, 2);
});

test('password entry and mutation flows expose labels, live updates, and busy state', () => {
  const login = fs.readFileSync(path.join(__dirname, '../views/login.ejs'), 'utf8');
  const homepage = fs.readFileSync(path.join(__dirname, '../views/index.ejs'), 'utf8');
  const password = fs.readFileSync(path.join(__dirname, '../views/password.ejs'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '../views/admin-page-detail.ejs'), 'utf8');
  const detailScript = fs.readFileSync(path.join(__dirname, '../public/js/admin-detail.js'), 'utf8');

  assert.match(login, /<label[^>]+for="password-input"/);
  assert.match(homepage, /id="password-mode-summary"[^>]+aria-live="polite"/);
  assert.match(homepage, /id="custom-password-hint"[^>]+aria-live="polite"/);
  assert.match(password, /<form[^\n]*id="passwordForm"[^\n]*aria-busy="false"/);
  assert.match(password, /setAttribute\('aria-busy'/);
  assert.match(detail, /id="edit-form"[^>]+aria-busy="false"/);
  assert.match(detail, /id="protection-hint"[^>]+aria-live="polite"/);
  assert.match(detailScript, /editForm\.setAttribute\('aria-busy'/);
});
