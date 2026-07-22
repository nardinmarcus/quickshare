const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'markdown-theme-http-key';
process.env.SESSION_SECRET = 'markdown-theme-http-secret';

const app = require('../app');
const { getMarkdownThemeOptions } = require('../utils/markdownThemeCatalog');

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

test.after(() => server.close());

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

function jsonRequest(route, method, value, headers = {}) {
  return request(route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value)
  });
}

async function seedMarkdownShare({
  id,
  markdownTheme,
  title = id,
  description = 'theme boundary',
  codeType = 'markdown',
  htmlContent = '# Theme boundary\n\n| Column | Value |\n| --- | --- |\n| Width | bounded |',
  passwordHash = null,
  encryptedPassword = null,
  isProtected = false,
  expiresAt = null,
  isFavorite = false,
  viewCount = 0
}) {
  await app.locals.pageRepository.create({
    id,
    htmlContent,
    createdAt: Date.now(),
    passwordHash,
    encryptedPassword,
    isProtected,
    codeType,
    title,
    description,
    expiresAt,
    markdownTheme
  });

  const stored = await app.locals.pageRepository.getById(id);
  stored.is_favorite = isFavorite;
  stored.view_count = viewCount;
}

test('homepage and admin edit render the same Catalog projection', async () => {
  await seedMarkdownShare({ id: 'catalog-admin', markdownTheme: 'github' });
  const [homepage, admin] = await Promise.all([
    request('/'),
    request('/admin/pages/catalog-admin')
  ]);

  assert.equal(homepage.status, 200);
  assert.equal(admin.status, 200);

  for (const { id, label } of getMarkdownThemeOptions()) {
    assert.match(homepage.text, new RegExp(`<option value="${id}"[^>]*>${label}</option>`));
    assert.match(admin.text, new RegExp(`<option value="${id}"[^>]*>${label}</option>`));
  }
  assert.match(admin.text, /<option value="github" selected>GitHub 经典<\/option>/);
});

test('preview and browser creation normalize unknown themes through ByteDance', async () => {
  const preview = await jsonRequest('/api/pages/preview', 'POST', {
    htmlContent: '# Preview fallback',
    codeType: 'markdown',
    markdownTheme: '../unsafe.css'
  });
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '# Create fallback',
    codeType: 'markdown',
    markdownTheme: 'removed-theme'
  });

  assert.equal(preview.status, 200);
  assert.match(preview.body.document, /markdown-theme-baseline\.css/);
  assert.match(preview.body.document, /markdown-bytedance\.css/);
  assert.doesNotMatch(preview.body.document, /unsafe\.css/);
  assert.equal(created.status, 200);
  assert.equal(created.body.markdownTheme, 'bytedance');

  const stored = await app.locals.pageRepository.getById(created.body.urlId);
  assert.equal(stored.markdown_theme, 'bytedance');
});

test('Share API normalizes an unknown Markdown theme through the same Catalog', async () => {
  const response = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '# Share API fallback',
    codeType: 'markdown',
    markdownTheme: 'stale-browser-theme'
  }, { 'X-API-Key': 'markdown-theme-http-key' });

  assert.equal(response.status, 200);
  assert.equal(response.body.markdownTheme, 'bytedance');

  const stored = await app.locals.pageRepository.getById(response.body.urlId);
  assert.equal(stored.markdown_theme, 'bytedance');
});

test('public reads render invalid stored values through ByteDance without rewriting them', async () => {
  await seedMarkdownShare({ id: 'legacy-invalid-theme', markdownTheme: 'legacy-invalid' });

  const response = await request('/view/legacy-invalid-theme');
  const stored = await app.locals.pageRepository.getById('legacy-invalid-theme');

  assert.equal(response.status, 200);
  assert.match(response.text, /markdown-theme-baseline\.css/);
  assert.match(response.text, /markdown-bytedance\.css/);
  assert.equal(stored.markdown_theme, 'legacy-invalid');
});

test('theme-only admin updates normalize the ID and preserve unrelated Share fields', async () => {
  const preservedExpiry = Date.now() + 86_400_000;
  await seedMarkdownShare({
    id: 'theme-only-update',
    markdownTheme: 'github',
    title: 'Preserved title',
    description: 'Preserved description',
    passwordHash: 'preserved-password-hash',
    encryptedPassword: 'preserved-encrypted-password',
    isProtected: true,
    expiresAt: preservedExpiry,
    isFavorite: true,
    viewCount: 17
  });

  const response = await jsonRequest('/admin/pages/theme-only-update', 'PUT', {
    markdownTheme: '../../unsafe.css'
  });
  const stored = await app.locals.pageRepository.getById('theme-only-update');

  assert.equal(response.status, 200);
  assert.equal(response.body.page.markdownTheme, 'bytedance');
  assert.equal(stored.markdown_theme, 'bytedance');
  assert.equal(stored.title, 'Preserved title');
  assert.equal(stored.description, 'Preserved description');
  assert.equal(stored.html_content.startsWith('# Theme boundary'), true);
  assert.equal(stored.password_hash, 'preserved-password-hash');
  assert.equal(stored.encrypted_password, 'preserved-encrypted-password');
  assert.equal(stored.is_protected, 1);
  assert.equal(stored.expires_at, preservedExpiry);
  assert.equal(stored.is_favorite, true);
  assert.equal(stored.view_count, 17);
});

test('admin theme writes normalize an empty value to ByteDance', async () => {
  await seedMarkdownShare({
    id: 'empty-theme-update',
    markdownTheme: 'github'
  });

  const response = await jsonRequest('/admin/pages/empty-theme-update', 'PUT', {
    markdownTheme: ''
  });
  const stored = await app.locals.pageRepository.getById('empty-theme-update');

  assert.equal(response.status, 200);
  assert.equal(response.body.page.markdownTheme, 'bytedance');
  assert.equal(stored.markdown_theme, 'bytedance');
});

test('admin theme input does not add Markdown state to a non-Markdown Share', async () => {
  await seedMarkdownShare({
    id: 'html-theme-boundary',
    markdownTheme: null,
    codeType: 'html',
    htmlContent: '<h1>HTML boundary</h1>'
  });

  const response = await jsonRequest('/admin/pages/html-theme-boundary', 'PUT', {
    markdownTheme: 'github'
  });
  const stored = await app.locals.pageRepository.getById('html-theme-boundary');

  assert.equal(response.status, 200);
  assert.equal(stored.code_type, 'html');
  assert.equal(stored.markdown_theme, null);
  assert.equal(stored.html_content, '<h1>HTML boundary</h1>');
});

test('cloning normalizes every legacy Markdown theme and keeps non-Markdown theme state null', async () => {
  for (const [suffix, markdownTheme] of [
    ['null', null],
    ['random', 'random'],
    ['invalid', 'legacy-invalid']
  ]) {
    const sourceId = `clone-${suffix}-theme`;
    await seedMarkdownShare({ id: sourceId, markdownTheme });

    const response = await request(`/admin/pages/${sourceId}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '_csrf='
    });
    assert.equal(response.status, 302);

    const cloneId = response.headers.location.split('/').pop();
    const clone = await app.locals.pageRepository.getById(cloneId);

    assert.equal(clone.code_type, 'markdown');
    assert.equal(clone.markdown_theme, 'bytedance');
  }

  await seedMarkdownShare({
    id: 'clone-html-theme',
    markdownTheme: 'legacy-invalid',
    codeType: 'html',
    htmlContent: '<p>HTML clone</p>'
  });
  const response = await request('/admin/pages/clone-html-theme/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '_csrf='
  });
  assert.equal(response.status, 302);

  const cloneId = response.headers.location.split('/').pop();
  const clone = await app.locals.pageRepository.getById(cloneId);

  assert.equal(clone.code_type, 'html');
  assert.equal(clone.markdown_theme, null);
});
