const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'markdown-theme-ticket-15-key';
process.env.SESSION_SECRET = 'markdown-theme-ticket-15-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const {
  MARKDOWN_THEME_CATALOG,
  resolveMarkdownTheme
} = require('../utils/markdownThemeCatalog');

const TICKET_THEMES = [
  ['raycast', 'Raycast 专注'],
  ['linear', 'Linear 精密']
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

const SEMANTIC_TOKENS = [
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
  'heading-on-accent'
];

function readSignature(id) {
  return fs.readFileSync(
    path.join(__dirname, `../public/css/markdown-${id}.css`),
    'utf8'
  );
}

function rootDeclarations(css) {
  const match = css.match(/^\s*:root\s*\{([^}]*)\}/s);
  assert.ok(match, 'signature must start with a light :root token set');
  return match[1];
}

function darkDeclarations(css) {
  const match = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{([^}]*)\}/);
  assert.ok(match, 'signature must define a dark :root token set');
  return match[1];
}

function tokenValue(declarations, token) {
  const match = declarations.match(new RegExp(`--theme-${token}:\\s*([^;]+);`));
  assert.ok(match, `missing --theme-${token}`);
  return match[1].trim();
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function relativeLuminance(hex) {
  return hexToRgb(hex)
    .map(channel => channel / 255)
    .map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function saturation(hex) {
  const [red, green, blue] = hexToRgb(hex).map(channel => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
}

test('Issue #15 registers Raycast and Linear in their relative formal Catalog order', () => {
  const ticketEntries = MARKDOWN_THEME_CATALOG
    .filter(({ id }) => TICKET_THEMES.some(([ticketId]) => ticketId === id))
    .map(({ id, label }) => [id, label]);

  assert.deepEqual(ticketEntries, TICKET_THEMES);
  assert.equal(resolveMarkdownTheme('raycast').signatureHref, '/css/markdown-raycast.css');
  assert.equal(resolveMarkdownTheme('linear').signatureHref, '/css/markdown-linear.css');
});

test('Issue #15 signatures provide complete light and dark semantic token sets with accessible role contrast', () => {
  const contrastPairs = [
    ['text', 'canvas', 4.5],
    ['muted', 'canvas', 4.5],
    ['link', 'canvas', 4.5],
    ['muted', 'quote-surface', 4.5],
    ['text', 'table-surface', 4.5],
    ['diagram-text', 'diagram-surface', 4.5],
    ['diagram-text', 'diagram-node-surface', 4.5],
    ['code-text', 'code-surface', 4.5],
    ['focus', 'canvas', 3]
  ];

  for (const [id] of TICKET_THEMES) {
    const css = readSignature(id);

    for (const declarations of [rootDeclarations(css), darkDeclarations(css)]) {
      for (const token of SEMANTIC_TOKENS) {
        assert.match(tokenValue(declarations, token), /^#[0-9a-f]{6}$/i);
      }

      for (const [foreground, background, minimum] of contrastPairs) {
        assert.ok(
          contrast(tokenValue(declarations, foreground), tokenValue(declarations, background)) >= minimum,
          `${id} ${foreground}/${background} contrast must be at least ${minimum}:1`
        );
      }
    }
  }
});

test('Issue #15 signatures use only local static system-font CSS', () => {
  for (const [id] of TICKET_THEMES) {
    const css = readSignature(id);

    assert.match(css, /--theme-font-family:\s*ui-sans-serif,/);
    assert.doesNotMatch(css, /@import|@font-face|url\s*\(|https?:|fonts\.|\.woff2?|\.ttf|\.otf/i);
    assert.doesNotMatch(css, /@keyframes|animation\s*:|transition\s*:|filter\s*:|backdrop-filter|text-shadow/i);
  }
});

test('Issue #15 keeps Raycast deeper and more plum-tonal while Linear stays flatter and denser', () => {
  const raycast = readSignature('raycast');
  const linear = readSignature('linear');
  const raycastLight = rootDeclarations(raycast);
  const linearLight = rootDeclarations(linear);

  assert.equal(tokenValue(raycastLight, 'surface-radius'), '12px');
  assert.equal(tokenValue(linearLight, 'surface-radius'), '7px');
  assert.equal(tokenValue(raycastLight, 'body-size'), '16px');
  assert.equal(tokenValue(linearLight, 'body-size'), '15px');
  assert.match(tokenValue(raycastLight, 'surface-shadow'), /^inset /);
  assert.equal(tokenValue(linearLight, 'surface-shadow'), 'none');
  assert.ok(
    saturation(tokenValue(raycastLight, 'accent')) > saturation(tokenValue(linearLight, 'accent')),
    'Raycast accent must be more saturated than Linear accent'
  );
  assert.ok(
    Math.abs(relativeLuminance(tokenValue(raycastLight, 'tool-surface')) - relativeLuminance(tokenValue(raycastLight, 'canvas')))
      > Math.abs(relativeLuminance(tokenValue(linearLight, 'tool-surface')) - relativeLuminance(tokenValue(linearLight, 'canvas'))),
    'Raycast tool surface must have more tonal depth than Linear tool surface'
  );
  assert.match(raycast, /box-shadow:\s*var\(--theme-surface-shadow\)/);
  assert.doesNotMatch(linear, /box-shadow\s*:/);
});

test('Issue #15 signatures keep diagram geometry above the renderer runtime defaults', () => {
  for (const [id, radius] of [['raycast', '12px'], ['linear', '7px']]) {
    const css = readSignature(id);

    assert.match(
      css,
      /\.markdown-body\s+\.mermaid,[\s\S]*?\.markdown-body\s+\.embedded-mermaid-container\s*\{[^}]*border-radius:\s*var\(--theme-surface-radius\)/
    );
    assert.equal(tokenValue(rootDeclarations(css), 'surface-radius'), radius);
  }
});

test('Issue #15 renderer uses exactly one trusted signature and keeps optional runtimes conditional', async () => {
  for (const [id] of TICKET_THEMES) {
    const otherId = id === 'raycast' ? 'linear' : 'raycast';
    const plain = await renderMarkdown('# Focused report\n\nPlain Markdown.', id);
    const code = await renderMarkdown('```js\nconst precise = true;\n```', id);
    const diagram = await renderMarkdown('```mermaid\ngraph LR\nFocus --> Ship\n```', id);

    assert.match(plain, new RegExp(`data-markdown-theme="${id}"`));
    assert.equal((plain.match(/markdown-theme-baseline\.css/g) || []).length, 1);
    assert.equal((plain.match(new RegExp(`markdown-${id}\\.css`, 'g')) || []).length, 1);
    assert.doesNotMatch(plain, new RegExp(`markdown-${otherId}\\.css`));
    assert.doesNotMatch(plain, /mermaid\.min\.js|highlight\.min\.js/);
    assert.match(code, /highlight\.min\.js/);
    assert.doesNotMatch(code, /mermaid\.min\.js/);
    assert.match(diagram, /mermaid\.min\.js/);
    assert.doesNotMatch(diagram, /highlight\.min\.js/);
  }
});

test('Issue #15 carries both IDs through preview, browser/API persistence, metadata, admin, and public rendering', async () => {
  const homepage = await request('/');

  assert.equal(homepage.status, 200);

  for (const [id, label] of TICKET_THEMES) {
    assert.match(homepage.text, new RegExp(`<option\\b(?=[^>]*value="${id}")[^>]*>\\s*${label}</option>`));

    const preview = await jsonRequest('/api/pages/preview', 'POST', {
      htmlContent: `# ${label} preview`,
      codeType: 'markdown',
      markdownTheme: id
    });
    assert.equal(preview.status, 200);
    assert.match(preview.body.document, new RegExp(`data-markdown-theme=&quot;${id}&quot;`));
    assert.match(preview.body.document, new RegExp(`markdown-${id}\\.css`));

    const browserCreate = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: `# ${label} browser`,
      codeType: 'markdown',
      title: `${label} browser title`,
      description: `${label} browser description`,
      markdownTheme: id
    });
    assert.equal(browserCreate.status, 200);
    assert.equal(browserCreate.body.markdownTheme, id);

    const apiCreate = await jsonRequest('/api/v1/share', 'POST', {
      htmlContent: `# ${label} API`,
      codeType: 'markdown',
      markdownTheme: id
    }, { 'X-API-Key': 'markdown-theme-ticket-15-key' });
    assert.equal(apiCreate.status, 200);
    assert.equal(apiCreate.body.markdownTheme, id);

    const metadata = await request(`/api/pages/${browserCreate.body.urlId}`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.page.markdownTheme, id);

    const admin = await request(`/admin/pages/${browserCreate.body.urlId}`);
    assert.equal(admin.status, 200);
    assert.match(admin.text, new RegExp(`<option\\b(?=[^>]*value="${id}")(?=[^>]*selected)[^>]*>\\s*${label}</option>`));

    const update = await jsonRequest(`/admin/pages/${browserCreate.body.urlId}`, 'PUT', {
      markdownTheme: id
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.page.markdownTheme, id);

    const stored = await app.locals.pageRepository.getById(browserCreate.body.urlId);
    assert.equal(stored.markdown_theme, id);
    assert.equal(stored.title, `${label} browser title`);
    assert.equal(stored.description, `${label} browser description`);

    const publicView = await request(`/view/${apiCreate.body.urlId}`);
    assert.equal(publicView.status, 200);
    assert.match(publicView.text, new RegExp(`data-markdown-theme=&quot;${id}&quot;`));
    assert.match(publicView.text, new RegExp(`markdown-${id}\\.css`));
  }
});

test('Issue #15 theme-only edits preserve every unrelated Share field for both target IDs', async () => {
  for (const [targetId] of TICKET_THEMES) {
    const sourceId = targetId === 'raycast' ? 'linear' : 'raycast';
    const shareId = `ticket-15-preserve-${targetId}`;
    const expiresAt = Date.now() + 86_400_000;

    await app.locals.pageRepository.create({
      id: shareId,
      htmlContent: `# Preserve ${targetId}`,
      createdAt: Date.now(),
      passwordHash: `${targetId}-password-hash`,
      encryptedPassword: `${targetId}-encrypted-password`,
      isProtected: true,
      codeType: 'markdown',
      title: `${targetId} preserved title`,
      description: `${targetId} preserved description`,
      expiresAt,
      markdownTheme: sourceId
    });
    const before = await app.locals.pageRepository.getById(shareId);
    before.is_favorite = true;
    before.view_count = 15;

    const response = await jsonRequest(`/admin/pages/${shareId}`, 'PUT', {
      markdownTheme: targetId
    });
    const stored = await app.locals.pageRepository.getById(shareId);

    assert.equal(response.status, 200);
    assert.equal(stored.markdown_theme, targetId);
    assert.equal(stored.html_content, `# Preserve ${targetId}`);
    assert.equal(stored.title, `${targetId} preserved title`);
    assert.equal(stored.description, `${targetId} preserved description`);
    assert.equal(stored.password_hash, `${targetId}-password-hash`);
    assert.equal(stored.encrypted_password, `${targetId}-encrypted-password`);
    assert.equal(stored.is_protected, 1);
    assert.equal(stored.expires_at, expiresAt);
    assert.equal(stored.is_favorite, true);
    assert.equal(stored.view_count, 15);
  }
});
