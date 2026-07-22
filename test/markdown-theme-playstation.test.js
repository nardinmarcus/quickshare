const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'playstation-theme-key';
process.env.SESSION_SECRET = 'playstation-theme-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const {
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme,
  resolveMarkdownThemeId
} = require('../utils/markdownThemeCatalog');

const PLAYSTATION_CSS_PATH = path.join(__dirname, '../public/css/markdown-playstation.css');

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

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance(hex) {
  const channels = hexToRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function parseTokens(source) {
  return Object.fromEntries(
    Array.from(source.matchAll(/--theme-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi), match => [match[1], match[2]])
  );
}

test('PlayStation is the final entry in the formal Catalog order with trusted local metadata', () => {
  const theme = resolveMarkdownTheme('playstation');
  const options = getMarkdownThemeOptions();

  assert.equal(resolveMarkdownThemeId('playstation'), 'playstation');
  assert.deepEqual(options.at(-1), {
    id: 'playstation',
    label: 'PlayStation 蓝境',
    signatureHref: '/css/markdown-playstation.css'
  });
  assert.equal(MARKDOWN_THEME_CATALOG.at(-1), theme);
  assert.equal(theme.signatureHref, '/css/markdown-playstation.css');
  assert.deepEqual(Object.keys(theme.appearances), ['light', 'dark']);
  assert.notEqual(theme.appearances.light.canvas, theme.appearances.dark.canvas);
  assert.equal(theme.appearances.light.canvas, '#f1f7ff');
  assert.equal(theme.appearances.dark.canvas, '#071629');
});

test('PlayStation renderer uses the shared baseline, one trusted signature, and no optional runtime for plain Markdown', async () => {
  const html = await renderMarkdown('# PlayStation boundary\n\n[Focusable link](#details)', 'playstation');
  const baselinePosition = html.indexOf('/css/markdown-theme-baseline.css');
  const signaturePosition = html.indexOf('/css/markdown-playstation.css');

  assert.ok(baselinePosition >= 0);
  assert.ok(signaturePosition > baselinePosition);
  assert.match(html, /<html[^>]+data-markdown-theme="playstation"/);
  assert.match(html, /<meta name="theme-color" content="#f1f7ff" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#071629" media="\(prefers-color-scheme: dark\)">/);
  assert.doesNotMatch(html, /mermaid\.min\.js|highlight\.min\.js|fonts\.googleapis\.com/);
});

test('PlayStation round-trips through preview, browser/API creation, metadata, admin editing, and public rendering', async () => {
  const preview = await jsonRequest('/api/pages/preview', 'POST', {
    htmlContent: '# Preview PlayStation',
    codeType: 'markdown',
    markdownTheme: 'playstation'
  });
  assert.equal(preview.status, 200);
  assert.match(preview.body.document, /data-markdown-theme=&quot;playstation&quot;/);
  assert.match(preview.body.document, /markdown-playstation\.css/);

  const browserCreated = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '# Browser PlayStation',
    codeType: 'markdown',
    markdownTheme: 'playstation',
    title: 'PlayStation browser Share'
  });
  assert.equal(browserCreated.status, 200);
  assert.equal(browserCreated.body.markdownTheme, 'playstation');

  const metadata = await request(`/api/pages/${browserCreated.body.urlId}`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.page.markdownTheme, 'playstation');

  const apiCreated = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '# API PlayStation',
    codeType: 'markdown',
    markdownTheme: 'playstation'
  }, { 'X-API-Key': 'playstation-theme-key' });
  assert.equal(apiCreated.status, 200);
  assert.equal(apiCreated.body.markdownTheme, 'playstation');

  const stored = await app.locals.pageRepository.getById(apiCreated.body.urlId);
  stored.is_favorite = true;
  stored.view_count = 23;
  const originalContent = stored.html_content;
  const originalTitle = stored.title;

  const admin = await request(`/admin/pages/${apiCreated.body.urlId}`);
  assert.equal(admin.status, 200);
  assert.match(
    admin.text,
    /<option\b(?=[^>]*value="playstation")(?=[^>]*selected)[^>]*>\s*PlayStation 蓝境<\/option>/
  );

  const update = await jsonRequest(`/admin/pages/${apiCreated.body.urlId}`, 'PUT', {
    markdownTheme: 'playstation'
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.page.markdownTheme, 'playstation');

  const updated = await app.locals.pageRepository.getById(apiCreated.body.urlId);
  assert.equal(updated.markdown_theme, 'playstation');
  assert.equal(updated.html_content, originalContent);
  assert.equal(updated.title, originalTitle);
  assert.equal(updated.is_favorite, true);
  assert.equal(updated.view_count, 23);

  const publicView = await request(`/view/${apiCreated.body.urlId}`);
  assert.equal(publicView.status, 200);
  assert.match(publicView.text, /data-markdown-theme=&quot;playstation&quot;/);
  assert.match(publicView.text, /markdown-playstation\.css/);
});

test('PlayStation signature is local, static, geometric blue depth rather than Bugatti metallic restraint', () => {
  const css = fs.readFileSync(PLAYSTATION_CSS_PATH, 'utf8');

  assert.match(css, /\.markdown-body h1\s*\{[^}]*background:\s*linear-gradient\([^;]+\)[^}]*color:\s*var\(--theme-heading-on-accent\)/is);
  assert.equal((css.match(/clip-path:\s*polygon\(/gi) || []).length, 1);
  assert.match(css, /\.markdown-body h1::after\s*\{/);
  assert.doesNotMatch(css, /@import|@font-face|url\(|animation|transition|@keyframes|filter\s*:|text-shadow|box-shadow/i);
  assert.doesNotMatch(css, /logo|artwork|game|particle|neon|bloom|metallic|carbon|ice|vehicle|badge|texture|shine/i);
});

test('PlayStation light and dark roles meet contrast requirements including the bright dark heading gradient', () => {
  const css = fs.readFileSync(PLAYSTATION_CSS_PATH, 'utf8');
  const darkMatch = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/i);

  assert.ok(darkMatch, 'dark appearance tokens must be present');

  const light = parseTokens(css.slice(0, darkMatch.index));
  const dark = parseTokens(darkMatch[1]);
  const textPairs = [
    ['text', 'canvas'],
    ['muted', 'canvas'],
    ['link', 'canvas'],
    ['quote-text', 'quote-surface'],
    ['code-text', 'code-surface'],
    ['table-heading', 'table-heading-surface'],
    ['diagram-text', 'diagram-node-surface']
  ];

  for (const [appearance, tokens] of [['light', light], ['dark', dark]]) {
    for (const [foreground, background] of textPairs) {
      assert.ok(
        contrastRatio(tokens[foreground], tokens[background]) >= 4.5,
        `${appearance} ${foreground} must meet 4.5:1 against ${background}`
      );
    }
    assert.ok(
      contrastRatio(tokens.focus, tokens.canvas) >= 3,
      `${appearance} focus must meet 3:1 against canvas`
    );
    for (const endpoint of ['heading-gradient-start', 'heading-gradient-end']) {
      assert.ok(
        contrastRatio(tokens['heading-on-accent'], tokens[endpoint]) >= 4.5,
        `${appearance} heading foreground must meet 4.5:1 against ${endpoint}`
      );
    }
  }

  assert.ok(relativeLuminance(dark['heading-gradient-start']) > relativeLuminance(light['heading-gradient-start']));
  assert.ok(relativeLuminance(dark['heading-on-accent']) < relativeLuminance(light['heading-on-accent']));
});
