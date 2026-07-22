const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'markdown-theme-signatures-12-key';
process.env.SESSION_SECRET = 'markdown-theme-signatures-12-secret';

const app = require('../app');
const { renderMarkdown } = require('../utils/contentRenderer');
const { resolveMarkdownTheme } = require('../utils/markdownThemeCatalog');

const PRESETS = Object.freeze([
  {
    id: 'github',
    lightCanvas: '#ffffff',
    darkCanvas: '#0d1117',
    source: fs.readFileSync(path.join(__dirname, '../public/css/markdown-github.css'), 'utf8')
  },
  {
    id: 'apple',
    lightCanvas: '#ffffff',
    darkCanvas: '#000000',
    source: fs.readFileSync(path.join(__dirname, '../public/css/markdown-apple.css'), 'utf8')
  }
]);

const SHARED_THEME_TOKENS = Object.freeze([
  'canvas',
  'text',
  'muted',
  'accent',
  'link',
  'border',
  'quote-surface',
  'table-surface',
  'diagram-surface',
  'code-text',
  'code-surface',
  'focus',
  'heading-on-accent',
  'font-family',
  'diagram-text',
  'diagram-node-surface',
  'diagram-node-border',
  'diagram-line',
  'diagram-label-surface',
  'reading-width'
]);

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

test('Issue #12 signatures provide paired token sets without taking back baseline containment', () => {
  for (const preset of PRESETS) {
    assert.match(preset.source, /@media \(prefers-color-scheme:\s*dark\)/);

    for (const token of SHARED_THEME_TOKENS) {
      assert.match(preset.source, new RegExp(`--theme-${token}:`), `${preset.id} supplies ${token}`);
    }

    assert.doesNotMatch(preset.source, /@import|https?:\/\/|url\s*\(|SF Pro|@keyframes|animation\s*:|filter\s*:\s*blur/i);
    assert.doesNotMatch(preset.source, /\b(?:max-width|overflow|word-wrap|word-break)\s*:/i);
    assert.doesNotMatch(preset.source, /text-decoration\s*:\s*none/i, `${preset.id} keeps the baseline link cue`);
  }
});

test('GitHub retains compact README rules without gradients or decorative depth', () => {
  const github = PRESETS.find(({ id }) => id === 'github').source;

  assert.match(github, /--theme-reading-width:\s*900px/);
  assert.match(github, /font-size:\s*16px/);
  assert.match(github, /line-height:\s*1\.6/);
  assert.match(github, /border-bottom:\s*1px solid var\(--theme-border\)/);
  assert.match(github, /color:\s*var\(--theme-link\)/);
  assert.match(github, /border-radius:\s*(?:3|6)px/);
  assert.doesNotMatch(github, /gradient|box-shadow|text-shadow/i);
});

test('Apple retains a narrow relaxed rhythm with plain headings and soft surfaces', () => {
  const apple = PRESETS.find(({ id }) => id === 'apple').source;

  assert.match(apple, /--theme-reading-width:\s*800px/);
  assert.match(apple, /font-size:\s*17px/);
  assert.match(apple, /line-height:\s*1\.7/);
  assert.match(apple, /font-weight:\s*600/);
  assert.match(apple, /border-radius:\s*16px/);
  assert.match(apple, /border-radius:\s*12px/);
  assert.doesNotMatch(apple, /gradient|text-transform|text-shadow/i);
});

test('Catalog and renderer expose coherent adaptive metadata for both migrated signatures', async () => {
  for (const preset of PRESETS) {
    const catalogEntry = resolveMarkdownTheme(preset.id);
    const document = await renderMarkdown('# Adaptive signature\n\nPlain body.', preset.id);
    const baselinePosition = document.indexOf('/css/markdown-theme-baseline.css');
    const signaturePosition = document.indexOf(`/css/markdown-${preset.id}.css`);

    assert.equal(catalogEntry.appearances.light.canvas, preset.lightCanvas);
    assert.equal(catalogEntry.appearances.dark.canvas, preset.darkCanvas);
    assert.notEqual(catalogEntry.appearances.light.canvas, catalogEntry.appearances.dark.canvas);
    assert.ok(baselinePosition >= 0);
    assert.ok(signaturePosition > baselinePosition);
    assert.match(document, new RegExp(`data-markdown-theme="${preset.id}"`));
    assert.match(document, new RegExp(`content="${preset.lightCanvas}" media="\\(prefers-color-scheme: light\\)"`));
    assert.match(document, new RegExp(`content="${preset.darkCanvas}" media="\\(prefers-color-scheme: dark\\)"`));
    assert.equal((document.match(/markdown-theme-baseline\.css/g) || []).length, 1);
    assert.equal((document.match(new RegExp(`markdown-${preset.id}\\.css`, 'g')) || []).length, 1);
    assert.doesNotMatch(document, /fonts\.googleapis\.com/);
  }
});

test('GitHub and Apple round-trip unchanged through preview, browser/API writes, metadata, admin edit, and public rendering', async () => {
  for (const [index, preset] of PRESETS.entries()) {
    const preview = await jsonRequest('/api/pages/preview', 'POST', {
      htmlContent: `# ${preset.id} preview`,
      codeType: 'markdown',
      markdownTheme: preset.id
    });
    assert.equal(preview.status, 200);
    assert.match(preview.body.document, new RegExp(`data-markdown-theme=(?:"|&quot;)${preset.id}(?:"|&quot;)`));

    const browserCreate = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: `# ${preset.id} browser create`,
      codeType: 'markdown',
      title: `${preset.id} title`,
      description: `${preset.id} description`,
      markdownTheme: preset.id
    });
    assert.equal(browserCreate.status, 200);
    assert.equal(browserCreate.body.markdownTheme, preset.id);

    const browserStored = await app.locals.pageRepository.getById(browserCreate.body.urlId);
    const metadata = await request(`/api/pages/${browserCreate.body.urlId}`);
    const publicView = await request(`/view/${browserCreate.body.urlId}`);
    assert.equal(browserStored.markdown_theme, preset.id);
    assert.equal(metadata.body.page.markdownTheme, preset.id);
    assert.match(publicView.text, new RegExp(`data-markdown-theme=(?:"|&quot;)${preset.id}(?:"|&quot;)`));
    assert.match(publicView.text, new RegExp(`/css/markdown-${preset.id}\\.css`));

    const apiCreate = await jsonRequest('/api/v1/share', 'POST', {
      htmlContent: `# ${preset.id} API create`,
      codeType: 'markdown',
      markdownTheme: preset.id
    }, { 'X-API-Key': 'markdown-theme-signatures-12-key' });
    assert.equal(apiCreate.status, 200);
    assert.equal(apiCreate.body.markdownTheme, preset.id);
    assert.equal((await app.locals.pageRepository.getById(apiCreate.body.urlId)).markdown_theme, preset.id);

    const otherPreset = PRESETS[(index + 1) % PRESETS.length];
    const adminSource = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: `# Preserve ${preset.id}`,
      codeType: 'markdown',
      title: `Preserve ${preset.id} title`,
      description: `Preserve ${preset.id} description`,
      markdownTheme: otherPreset.id
    });
    const adminUpdate = await jsonRequest(`/admin/pages/${adminSource.body.urlId}`, 'PUT', {
      markdownTheme: preset.id
    });
    const adminStored = await app.locals.pageRepository.getById(adminSource.body.urlId);
    assert.equal(adminUpdate.status, 200);
    assert.equal(adminUpdate.body.page.markdownTheme, preset.id);
    assert.equal(adminStored.markdown_theme, preset.id);
    assert.equal(adminStored.html_content, `# Preserve ${preset.id}`);
    assert.equal(adminStored.title, `Preserve ${preset.id} title`);
    assert.equal(adminStored.description, `Preserve ${preset.id} description`);
  }
});
