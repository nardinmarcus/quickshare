const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'markdown-theme-issue13-key';
process.env.SESSION_SECRET = 'markdown-theme-issue13-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const { resolveMarkdownTheme } = require('../utils/markdownThemeCatalog');

const THEME_IDS = ['notion', 'claude'];
const REQUIRED_TOKENS = [
  'canvas',
  'text',
  'muted',
  'accent',
  'link',
  'border',
  'quote-surface',
  'table-surface',
  'diagram-surface',
  'diagram-text',
  'diagram-node-surface',
  'diagram-node-border',
  'diagram-line',
  'diagram-label-surface',
  'code-text',
  'code-surface',
  'focus',
  'heading-on-accent',
  'font-family'
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

function jsonRequest(route, value, headers = {}, method = 'POST') {
  return request(route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value)
  });
}

function readSignature(id) {
  return fs.readFileSync(
    path.join(__dirname, `../public/css/markdown-${id}.css`),
    'utf8'
  );
}

function declarationBlock(css, appearance) {
  const source = appearance === 'light'
    ? css
    : css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]+)\}\s*$/i)?.[1] || '';
  return source.match(/:root\s*\{([^}]*)\}/i)?.[1] || '';
}

function tokensFor(css, appearance) {
  const tokens = new Map();
  for (const match of declarationBlock(css, appearance).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(match[1].toLowerCase(), match[2].trim());
  }
  return tokens;
}

function rgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected a six-digit color, received ${hex}`);
  return [0, 2, 4].map(offset => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const channels = rgb(hex).map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(tokens, foreground, background, minimum) {
  const ratio = contrast(tokens.get(foreground), tokens.get(background));
  assert.ok(
    ratio >= minimum,
    `${foreground} on ${background} is ${ratio.toFixed(2)}:1; expected at least ${minimum}:1`
  );
}

test('Issue #13 signatures expose complete light and dark shared-token contracts', () => {
  for (const id of THEME_IDS) {
    const css = readSignature(id);

    for (const appearance of ['light', 'dark']) {
      const tokens = tokensFor(css, appearance);
      for (const token of REQUIRED_TOKENS) {
        assert.ok(tokens.has(`theme-${token}`), `${id} ${appearance} is missing --theme-${token}`);
      }

      for (const [foreground, background, minimum] of [
        ['theme-text', 'theme-canvas', 4.5],
        ['theme-muted', 'theme-canvas', 4.5],
        ['theme-link', 'theme-canvas', 4.5],
        ['theme-muted', 'theme-quote-surface', 4.5],
        ['theme-text', 'theme-table-surface', 4.5],
        ['theme-code-text', 'theme-code-surface', 4.5],
        ['theme-diagram-text', 'theme-diagram-surface', 4.5],
        ['theme-focus', 'theme-canvas', 3]
      ]) {
        assertContrast(tokens, foreground, background, minimum);
      }
    }
  }
});

test('Notion and Claude Catalog canvas metadata matches both signature appearances', async () => {
  for (const id of THEME_IDS) {
    const css = readSignature(id);
    const theme = resolveMarkdownTheme(id);
    const lightCanvas = tokensFor(css, 'light').get('theme-canvas');
    const darkCanvas = tokensFor(css, 'dark').get('theme-canvas');
    const html = await renderMarkdown(`# ${id} appearance`, id);

    assert.equal(theme.appearances.light.canvas, lightCanvas);
    assert.equal(theme.appearances.light.themeColor, lightCanvas);
    assert.equal(theme.appearances.dark.canvas, darkCanvas);
    assert.equal(theme.appearances.dark.themeColor, darkCanvas);
    assert.match(html, new RegExp(`--theme-canvas: ${lightCanvas}`));
    assert.match(html, new RegExp(`--theme-canvas: ${darkCanvas}`));
  }
});

test('Issue #13 signatures use only local styling and system font families', () => {
  for (const id of THEME_IDS) {
    const css = readSignature(id);

    assert.doesNotMatch(css, /@import|@font-face|url\s*\(|https?:\/\//i);
    assert.doesNotMatch(css, /JetBrains|Inter|Styrene|Copernicus|Tiempos/i);
    assert.doesNotMatch(css, /@keyframes|\banimation\s*:|filter\s*:\s*blur/i);

    for (const appearance of ['light', 'dark']) {
      assert.match(
        tokensFor(css, appearance).get('theme-font-family') || '',
        /ui-sans-serif|system-ui|-apple-system/i
      );
    }
  }
});

test('Notion keeps note surfaces, body-color links, red inline code, and explicit task states', async () => {
  const css = readSignature('notion');
  const baseline = fs.readFileSync(
    path.join(__dirname, '../public/css/markdown-theme-baseline.css'),
    'utf8'
  );
  const renderedTasks = await renderMarkdown('- [ ] Open task\n- [x] Completed task', 'notion');

  for (const appearance of ['light', 'dark']) {
    const tokens = tokensFor(css, appearance);
    assert.equal(tokens.get('theme-link'), tokens.get('theme-text'));
    assert.ok(tokens.has('notion-inline-code'));
    assert.ok(tokens.has('notion-inline-code-surface'));

    const [red, green, blue] = rgb(tokens.get('notion-inline-code'));
    assert.ok(red > green && red > blue, `Notion ${appearance} inline code must remain red`);
    assertContrast(tokens, 'notion-inline-code', 'notion-inline-code-surface', 4.5);
  }

  assert.match(renderedTasks, /<li><input disabled="" type="checkbox"> Open task<\/li>/);
  assert.match(renderedTasks, /<li><input checked="" disabled="" type="checkbox"> Completed task<\/li>/);
  assert.match(baseline, /li:has\(> input\[type=["']checkbox["']\]\)/);
  assert.match(css, /li:has\(> input\[type=["']checkbox["']\]:checked\)/);
  assert.match(css, /input\[type=["']checkbox["']\]:checked/);
  assert.match(css, /input\[type=["']checkbox["']\]:not\(:checked\)/);
  assert.match(css, /border-radius:\s*(?:[0-5](?:\.\d+)?(?:px|rem|em))/i);
});

test('Claude keeps warm paper, system-serif headings, and terracotta accents', () => {
  const css = readSignature('claude');

  for (const appearance of ['light', 'dark']) {
    const tokens = tokensFor(css, appearance);
    const headingFont = tokens.get('claude-heading-font') || '';
    const [red, green, blue] = rgb(tokens.get('theme-accent'));

    assert.match(headingFont, /ui-serif|Georgia|Cambria|Times/i);
    assert.ok(red > green && green > blue, `Claude ${appearance} accent must remain terracotta`);
    assert.equal(tokens.get('theme-link'), tokens.get('theme-accent'));
  }

  assert.match(css, /font-family:\s*var\(--claude-heading-font\)/i);
  assert.match(css, /blockquote[^}]*border-left:[^;}]*var\(--theme-accent\)/is);
});

test('Notion and Claude render through the baseline and retain conditional optional assets', async () => {
  const fence = '`'.repeat(3);

  for (const id of THEME_IDS) {
    const plain = await renderMarkdown('# Local theme\n\nA [link](https://example.com).', id);
    const codeOnly = await renderMarkdown(
      `${fence}js\nconst answer = 42;\n${fence}`,
      id
    );
    const mermaidOnly = await renderMarkdown(
      `${fence}mermaid\ngraph TD\nA-->B\n${fence}`,
      id
    );

    assert.ok(
      plain.indexOf('/css/markdown-theme-baseline.css') < plain.indexOf(`/css/markdown-${id}.css`)
    );
    assert.match(plain, new RegExp(`data-markdown-theme="${id}"`));
    assert.doesNotMatch(plain, /fonts\.googleapis\.com|highlight\.min\.js|mermaid\.min\.js/);

    assert.match(codeOnly, /highlight\.min\.js/);
    assert.doesNotMatch(codeOnly, /mermaid\.min\.js/);
    assert.doesNotMatch(mermaidOnly, /highlight\.min\.js/);
    assert.match(mermaidOnly, /mermaid\.min\.js/);
    assert.equal((codeOnly.match(new RegExp(`markdown-${id}\\.css`, 'g')) || []).length, 1);
    assert.equal((mermaidOnly.match(new RegExp(`markdown-${id}\\.css`, 'g')) || []).length, 1);
  }
});

test('Notion and Claude round-trip through preview, browser create, metadata, admin, and public view', async () => {
  const homepage = await request('/');
  assert.equal(homepage.status, 200);

  for (const id of THEME_IDS) {
    assert.match(homepage.text, new RegExp(`<option\\b(?=[^>]*value="${id}")[^>]*>`));

    const preview = await jsonRequest('/api/pages/preview', {
      htmlContent: `# ${id} preview`,
      codeType: 'markdown',
      markdownTheme: id
    });
    assert.equal(preview.status, 200);
    assert.match(preview.body.document, new RegExp(`markdown-${id}\\.css`));

    const created = await jsonRequest('/api/pages/create', {
      htmlContent: `# ${id} browser create`,
      codeType: 'markdown',
      markdownTheme: id,
      title: `${id} title`,
      description: `${id} description`
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.markdownTheme, id);

    const [stored, metadata, admin, publicView] = await Promise.all([
      app.locals.pageRepository.getById(created.body.urlId),
      request(`/api/pages/${created.body.urlId}`),
      request(`/admin/pages/${created.body.urlId}`),
      request(`/view/${created.body.urlId}`)
    ]);

    assert.equal(stored.markdown_theme, id);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.page.markdownTheme, id);
    assert.equal(admin.status, 200);
    assert.match(admin.text, new RegExp(`<option\\b(?=[^>]*value="${id}")(?=[^>]*selected)[^>]*>`));
    assert.equal(publicView.status, 200);
    assert.match(publicView.text, new RegExp(`markdown-${id}\\.css`));
  }
});

test('Notion and Claude round-trip through the Share API without changing response shape', async () => {
  const expectedResponseKeys = [
    'codeType',
    'description',
    'expiresAt',
    'isProtected',
    'markdownTheme',
    'password',
    'success',
    'title',
    'url',
    'urlId'
  ];

  for (const id of THEME_IDS) {
    const response = await jsonRequest('/api/v1/share', {
      htmlContent: `# ${id} Share API`,
      codeType: 'markdown',
      markdownTheme: id
    }, { 'X-API-Key': 'markdown-theme-issue13-key' });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.markdownTheme, id);
    assert.equal(typeof response.body.urlId, 'string');
    assert.deepEqual(Object.keys(response.body).sort(), expectedResponseKeys);

    const stored = await app.locals.pageRepository.getById(response.body.urlId);
    assert.equal(stored.markdown_theme, id);
  }
});

test('a Notion-to-Claude admin theme update preserves unrelated Share state', async () => {
  const id = 'issue13-theme-only-isolation';
  const expiresAt = Date.now() + 86_400_000;
  await app.locals.pageRepository.create({
    id,
    htmlContent: '# Preserved content',
    createdAt: Date.now(),
    passwordHash: 'preserved-password-hash',
    encryptedPassword: 'preserved-encrypted-password',
    isProtected: true,
    codeType: 'markdown',
    title: 'Preserved title',
    description: 'Preserved description',
    expiresAt,
    markdownTheme: 'notion'
  });
  const seeded = await app.locals.pageRepository.getById(id);
  seeded.is_favorite = true;
  seeded.view_count = 23;

  const response = await jsonRequest(
    `/admin/pages/${id}`,
    { markdownTheme: 'claude' },
    {},
    'PUT'
  );
  const stored = await app.locals.pageRepository.getById(id);

  assert.equal(response.status, 200);
  assert.equal(response.body.page.markdownTheme, 'claude');
  assert.equal(stored.markdown_theme, 'claude');
  assert.equal(stored.html_content, '# Preserved content');
  assert.equal(stored.title, 'Preserved title');
  assert.equal(stored.description, 'Preserved description');
  assert.equal(stored.password_hash, 'preserved-password-hash');
  assert.equal(stored.encrypted_password, 'preserved-encrypted-password');
  assert.equal(stored.is_protected, 1);
  assert.equal(stored.expires_at, expiresAt);
  assert.equal(stored.is_favorite, true);
  assert.equal(stored.view_count, 23);
});
