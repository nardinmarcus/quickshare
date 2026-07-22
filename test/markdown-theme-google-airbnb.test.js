const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue-16-theme-key';
process.env.SESSION_SECRET = 'issue-16-theme-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const {
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme
} = require('../utils/markdownThemeCatalog');

const ISSUE_16_THEMES = [
  {
    id: 'google',
    label: 'Google Material',
    light: '#f8fafd',
    dark: '#111318'
  },
  {
    id: 'airbnb',
    label: 'Airbnb 暖居',
    light: '#fff8f2',
    dark: '#211a18'
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

function signaturePath(id) {
  return path.join(__dirname, `../public/css/markdown-${id}.css`);
}

function parseHexTokens(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)]
      .map(([, name, value]) => [name, value.toLowerCase()])
  );
}

function appearanceTokens(css) {
  const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => parseHexTokens(match[1]));

  assert.equal(roots.length, 2, 'signature must define one light and one dark token set');
  return { light: roots[0], dark: roots[1] };
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(value => parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map(value => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('Issue #16 entries occupy their formal relative Catalog order with trusted appearances', () => {
  const ids = MARKDOWN_THEME_CATALOG.map(({ id }) => id);
  const options = getMarkdownThemeOptions();
  const formalOrder = [
    'bytedance', 'github', 'apple', 'notion', 'claude', 'raycast',
    'google', 'tesla', 'airbnb', 'bugatti', 'linear', 'playstation'
  ];

  assert.deepEqual(
    ids.filter(id => formalOrder.includes(id)),
    formalOrder.filter(id => ids.includes(id))
  );

  for (const expected of ISSUE_16_THEMES) {
    const theme = resolveMarkdownTheme(expected.id);

    assert.equal(theme.id, expected.id);
    assert.equal(theme.label, expected.label);
    assert.equal(theme.signatureHref, `/css/markdown-${expected.id}.css`);
    assert.deepEqual(theme.appearances, {
      light: { canvas: expected.light, themeColor: expected.light },
      dark: { canvas: expected.dark, themeColor: expected.dark }
    });
    assert.deepEqual(options.find(({ id }) => id === expected.id), {
      id: expected.id,
      label: expected.label
    });
  }
});

test('renderer resolves both signatures, adaptive metadata, and no optional runtime for plain Markdown', async () => {
  for (const expected of ISSUE_16_THEMES) {
    const html = await renderMarkdown('# Signature\n\nPlain theme proof.', expected.id);

    assert.match(html, new RegExp(`data-markdown-theme="${expected.id}"`));
    assert.ok(html.indexOf('/css/markdown-theme-baseline.css') < html.indexOf(`/css/markdown-${expected.id}.css`));
    assert.match(html, new RegExp(`<meta name="theme-color" content="${expected.light}" media="\\(prefers-color-scheme: light\\)">`));
    assert.match(html, new RegExp(`<meta name="theme-color" content="${expected.dark}" media="\\(prefers-color-scheme: dark\\)">`));
    assert.doesNotMatch(html, /mermaid\.min\.js|highlight\.min\.js|fonts\.googleapis\.com/);
  }
});

test('both signatures stay local, static, system-font, adaptive, and baseline-compatible', () => {
  const baseline = fs.readFileSync(
    path.join(__dirname, '../public/css/markdown-theme-baseline.css'),
    'utf8'
  );

  assert.match(baseline, /:focus-visible[^}]*outline:\s*3px solid var\(--theme-focus\)/s);
  assert.match(baseline, /:where\(pre, table, \.mermaid[^}]*overflow:\s*auto/s);

  for (const { id } of ISSUE_16_THEMES) {
    const css = fs.readFileSync(signaturePath(id), 'utf8');

    assert.match(css, /font-family:[^;]*(?:system-ui|-apple-system|BlinkMacSystemFont)/i);
    assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/);
    assert.doesNotMatch(css, /@import|url\s*\(|https?:|@font-face|animation\s*:|@keyframes|filter:\s*blur/i);
    assert.doesNotMatch(css, /logo|badge|search-bar|hero-image/i);
  }
});

test('Google signature uses tonal surfaces, asymmetric corners, controlled blue, and one secondary marker', () => {
  const css = fs.readFileSync(signaturePath('google'), 'utf8');

  assert.match(css, /--theme-accent:\s*#0b57d0/i);
  assert.match(css, /--theme-tonal-surface:\s*#[0-9a-f]{6}/i);
  assert.match(css, /--theme-secondary:\s*#[0-9a-f]{6}/i);
  assert.match(css, /border-radius:\s*28px 8px 28px 8px/i);
  assert.match(css, /\.markdown-body h2::after\s*\{[^}]*background:\s*var\(--theme-secondary\)/is);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|#34a853|#fbbc0[45]|#ea4335/i);
});

test('Airbnb signature uses warm terracotta, friendly surfaces, one metadata pill, and shallow depth', () => {
  const css = fs.readFileSync(signaturePath('airbnb'), 'utf8');

  assert.match(css, /--theme-accent:\s*#963f30/i);
  assert.match(css, /border-radius:\s*18px/i);
  assert.match(css, /\.markdown-body h6\s*\{[^}]*display:\s*inline-flex[^}]*border-radius:\s*999px/is);
  assert.match(css, /--theme-surface-shadow:\s*0 4px 14px rgba\(/i);
  assert.match(css, /box-shadow:\s*var\(--theme-surface-shadow\)/i);
  assert.doesNotMatch(css, /#ff385c|#e00b41|rausch|search-bar|search-card/i);
});

test('both light and dark palettes meet contrast contracts for every representative role', () => {
  const textPairs = [
    ['theme-text', 'theme-canvas'],
    ['theme-muted', 'theme-canvas'],
    ['theme-link', 'theme-canvas'],
    ['theme-quote-text', 'theme-quote-surface'],
    ['theme-code-text', 'theme-code-surface'],
    ['theme-table-heading', 'theme-table-heading-surface'],
    ['theme-diagram-text', 'theme-diagram-node-surface']
  ];

  for (const { id } of ISSUE_16_THEMES) {
    const tokensByAppearance = appearanceTokens(fs.readFileSync(signaturePath(id), 'utf8'));

    for (const [appearance, tokens] of Object.entries(tokensByAppearance)) {
      for (const [foregroundName, backgroundName] of textPairs) {
        const ratio = contrastRatio(tokens[foregroundName], tokens[backgroundName]);
        assert.ok(
          ratio >= 4.5,
          `${id} ${appearance} ${foregroundName}/${backgroundName} contrast ${ratio.toFixed(2)} is below 4.5`
        );
      }

      const focusRatio = contrastRatio(tokens['theme-focus'], tokens['theme-canvas']);
      assert.ok(focusRatio >= 3, `${id} ${appearance} focus contrast ${focusRatio.toFixed(2)} is below 3`);
    }
  }
});

test('creator, API, metadata, admin, and public flows round-trip both stable IDs', async () => {
  const homepage = await request('/');

  assert.equal(homepage.status, 200);

  for (const { id, label } of ISSUE_16_THEMES) {
    const preservedExpiry = Date.now() + 86_400_000;
    const preservedPassword = id === 'google' ? 'Goo9!?' : 'Air9!?';
    assert.match(homepage.text, new RegExp(`<option value="${id}"[^>]*>${label}</option>`));

    const preview = await jsonRequest('/api/pages/preview', 'POST', {
      htmlContent: `# ${label} preview`,
      codeType: 'markdown',
      markdownTheme: id
    });
    assert.equal(preview.status, 200);
    assert.match(preview.body.document, new RegExp(`/css/markdown-${id}\\.css`));

    const created = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: `# ${label} creator`,
      codeType: 'markdown',
      markdownTheme: id,
      description: `${label} preserved description`,
      expiresAt: preservedExpiry,
      isProtected: true,
      password: preservedPassword
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.markdownTheme, id);

    const metadata = await request(`/api/pages/${created.body.urlId}`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.page.markdownTheme, id);

    const unlock = await jsonRequest(`/view/${created.body.urlId}/password`, 'POST', {
      password: preservedPassword
    });
    assert.equal(unlock.status, 200);
    const accessCookie = unlock.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
    const publicView = await request(`/view/${created.body.urlId}`, {
      headers: { Cookie: accessCookie }
    });
    assert.equal(publicView.status, 200);
    assert.match(publicView.text, new RegExp(`data-markdown-theme=&quot;${id}&quot;`));
    assert.match(publicView.text, new RegExp(`/css/markdown-${id}\\.css`));

    const apiCreated = await jsonRequest('/api/v1/share', 'POST', {
      htmlContent: `# ${label} API`,
      codeType: 'markdown',
      markdownTheme: id
    }, { 'X-API-Key': 'issue-16-theme-key' });
    assert.equal(apiCreated.status, 200);
    assert.equal(apiCreated.body.markdownTheme, id);

    await app.locals.pageRepository.setFavorite(created.body.urlId, true);
    await app.locals.pageRepository.recordViewEvent(created.body.urlId, Date.now(), true);
    const beforeUpdate = await app.locals.pageRepository.getById(created.body.urlId);
    const preservedPasswordHash = beforeUpdate.password_hash;
    const preservedEncryptedPassword = beforeUpdate.encrypted_password;
    const preservedViewCount = beforeUpdate.view_count;

    const updated = await jsonRequest(`/admin/pages/${created.body.urlId}`, 'PUT', {
      markdownTheme: id === 'google' ? 'airbnb' : 'google'
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.page.markdownTheme, id === 'google' ? 'airbnb' : 'google');

    const stored = await app.locals.pageRepository.getById(created.body.urlId);
    assert.equal(stored.html_content, `# ${label} creator`);
    assert.equal(stored.title, `${label} creator`);
    assert.equal(stored.description, `${label} preserved description`);
    assert.equal(stored.password_hash, preservedPasswordHash);
    assert.equal(stored.encrypted_password, preservedEncryptedPassword);
    assert.equal(stored.is_protected, 1);
    assert.equal(stored.expires_at, preservedExpiry);
    assert.equal(stored.is_favorite, true);
    assert.equal(stored.view_count, preservedViewCount);
  }
});
