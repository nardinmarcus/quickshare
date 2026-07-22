const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'tesla-bugatti-theme-key';
process.env.SESSION_SECRET = 'tesla-bugatti-theme-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const {
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme
} = require('../utils/markdownThemeCatalog');

const THEMES = [
  {
    id: 'tesla',
    label: 'Tesla 黑白',
    light: '#ffffff',
    dark: '#050505'
  },
  {
    id: 'bugatti',
    label: 'Bugatti 蓝曜',
    light: '#f4f8fc',
    dark: '#0b0e12'
  }
];

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

async function seedMarkdownShare(id) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: '# Engineering Notes\n\n[Focused link](https://example.com)\n\n| Metric | Value |\n| --- | --- |\n| Width | bounded |',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'markdown',
    title: id,
    description: 'Tesla and Bugatti theme acceptance',
    expiresAt: null,
    markdownTheme: 'bytedance'
  });
}

function readSignature(id) {
  return fs.readFileSync(path.join(__dirname, `../public/css/markdown-${id}.css`), 'utf8');
}

test('Tesla and Bugatti occupy their formal relative Catalog order with trusted adaptive metadata', () => {
  const canonicalOrder = [
    'bytedance', 'github', 'apple', 'notion', 'claude', 'raycast',
    'google', 'tesla', 'airbnb', 'bugatti', 'linear', 'playstation'
  ];
  const ids = MARKDOWN_THEME_CATALOG.map(({ id }) => id);

  assert.deepEqual(ids, canonicalOrder.filter(id => ids.includes(id)));

  for (const expected of THEMES) {
    const entry = resolveMarkdownTheme(expected.id);
    assert.equal(entry.id, expected.id);
    assert.equal(entry.label, expected.label);
    assert.equal(entry.signatureHref, `/css/markdown-${expected.id}.css`);
    assert.equal(entry.appearances.light.canvas, expected.light);
    assert.equal(entry.appearances.dark.canvas, expected.dark);
    assert.equal(getMarkdownThemeOptions().some(option => option.id === expected.id), true);
  }
});

test('Tesla and Bugatti render only their trusted local signatures after the shared baseline', async () => {
  for (const { id, light, dark } of THEMES) {
    const html = await renderMarkdown('# Signature\n\nPlain local content.', id);
    const baselinePosition = html.indexOf('/css/markdown-theme-baseline.css');
    const signaturePosition = html.indexOf(`/css/markdown-${id}.css`);

    assert.ok(baselinePosition >= 0);
    assert.ok(signaturePosition > baselinePosition);
    assert.match(html, new RegExp(`data-markdown-theme="${id}"`));
    assert.match(html, new RegExp(`--theme-canvas: ${light}`));
    assert.match(html, new RegExp(`--theme-canvas: ${dark}`));
    assert.doesNotMatch(html, /fonts\.googleapis\.com|https?:\/\/[^"']+\.(?:css|woff2?|png|jpe?g|webp|svg)/i);
  }
});

test('Tesla signature keeps hard monochrome hierarchy and a smaller compact Sampler heading', () => {
  const css = readSignature('tesla');
  const longForm = css.match(/\.markdown-body h1\s*\{[^}]*font-size:\s*clamp\([^,]+,[^,]+,\s*([0-9.]+)rem\)/s);
  const sampler = css.match(/\.theme-sampler \.markdown-body h1\s*\{[^}]*font-size:\s*clamp\([^,]+,[^,]+,\s*([0-9.]+)rem\)/s);

  assert.match(css, /--theme-canvas:\s*#ffffff/i);
  assert.match(css, /--theme-text:\s*#050505/i);
  assert.match(css, /\.markdown-body h1\s*\{[^}]*text-transform:\s*uppercase/s);
  assert.match(css, /\.markdown-body h1\s*\{[^}]*border-(?:top|block-start):\s*1px solid/s);
  assert.match(css, /\.markdown-body h1\s*\{[^}]*border-(?:bottom|block-end):\s*1px solid/s);
  assert.ok(longForm, 'Tesla long-form h1 must declare a clamp scale');
  assert.ok(sampler, 'Tesla Theme Sampler h1 must declare its compact clamp scale');
  assert.ok(Number(sampler[1]) < Number(longForm[1]), 'Sampler maximum must be smaller than long-form maximum');
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/);
});

test('Bugatti signature uses ice/carbon polarity, vivid blue focus, metallic rules, and one restrained facet', () => {
  const css = readSignature('bugatti');

  assert.match(css, /--theme-canvas:\s*#f4f8fc/i);
  assert.match(css, /--theme-carbon:\s*#0b0e12/i);
  assert.match(css, /--theme-focus:\s*#0057ff/i);
  assert.match(css, /--theme-metal:/i);
  assert.match(css, /border[^;]*1px solid var\(--theme-metal\)/i);
  assert.equal((css.match(/clip-path:\s*polygon\(/gi) || []).length, 1);
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/);
});

test('both signatures use system fonts and contain no remote, animated, textured, or shine effects', () => {
  for (const { id } of THEMES) {
    const css = readSignature(id);

    assert.match(css, /font-family:[^;]*(?:ui-sans-serif|-apple-system|BlinkMacSystemFont|Segoe UI)/i);
    assert.doesNotMatch(css, /@import|@font-face|url\s*\(|https?:|@keyframes|animation\s*:|filter\s*:|background-image\s*:|box-shadow\s*:/i);
  }
});

test('preview, browser/API creation, metadata, admin update, and public rendering round-trip both IDs', async () => {
  for (const { id } of THEMES) {
    const preview = await jsonRequest('/api/pages/preview', 'POST', {
      htmlContent: '# Preview',
      codeType: 'markdown',
      markdownTheme: id
    });
    assert.equal(preview.status, 200);
    assert.match(preview.body.document, new RegExp(`markdown-${id}\\.css`));

    const created = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: `# Browser ${id}`,
      codeType: 'markdown',
      markdownTheme: id
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.markdownTheme, id);

    const metadata = await request(`/api/pages/${created.body.urlId}`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.page.markdownTheme, id);

    const publicView = await request(`/view/${created.body.urlId}`);
    assert.equal(publicView.status, 200);
    assert.match(publicView.text, new RegExp(`markdown-${id}\\.css`));
    assert.doesNotMatch(publicView.text, /fonts\.googleapis\.com/);

    const apiCreated = await jsonRequest('/api/v1/share', 'POST', {
      htmlContent: `# API ${id}`,
      codeType: 'markdown',
      markdownTheme: id
    }, { 'X-API-Key': 'tesla-bugatti-theme-key' });
    assert.equal(apiCreated.status, 200);
    assert.equal(apiCreated.body.markdownTheme, id);

    const adminId = `issue-17-admin-${id}`;
    await seedMarkdownShare(adminId);
    const adminUpdate = await jsonRequest(`/admin/pages/${adminId}`, 'PUT', { markdownTheme: id });
    const stored = await app.locals.pageRepository.getById(adminId);
    assert.equal(adminUpdate.status, 200);
    assert.equal(adminUpdate.body.page.markdownTheme, id);
    assert.equal(stored.markdown_theme, id);
  }
});
