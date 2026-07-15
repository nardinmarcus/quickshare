const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'publishing-ux-secret';

const app = require('../app');

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

test.after(() => {
  server.close();
});

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const body = options.body || '';
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
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

function jsonRequest(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('homepage exposes preview, explicit publish states, and a complete handoff result', async () => {
  const homepage = await request('/');
  const previewPosition = homepage.text.indexOf('id="prepublish-preview-button"');
  const publishPosition = homepage.text.indexOf('id="generate-button"');

  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /<label[^>]+for="html-input"/);
  assert.ok(previewPosition >= 0);
  assert.ok(previewPosition < publishPosition);
  assert.match(homepage.text, /id="publish-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(homepage.text, /id="publish-error"[^>]+role="alert"/);
  assert.match(homepage.text, /id="generate-button"[^>]+aria-busy="false"/);
  assert.match(homepage.text, /id="publish-preview"/);
  assert.match(homepage.text, /id="publish-preview-frame"[^>]+sandbox="allow-scripts"/);
  assert.match(homepage.text, /id="result-eyebrow"/);
  assert.match(homepage.text, /id="result-access"/);
  assert.match(homepage.text, /id="result-type"/);
  assert.match(homepage.text, /id="result-expiry"/);
  assert.match(homepage.text, /打开分享页/);
  assert.match(homepage.text, /复制链接/);
  assert.match(homepage.text, /id="continue-button"[^>]*>[^<]*<i[^>]*><\/i>继续创建/s);
  assert.match(homepage.text, /id="manual-copy-output"[^>]+readonly[^>]+hidden/);
});

test('browser script uses one clipboard path and manages preview and busy state', async () => {
  const script = await request('/js/main.js');
  const fallbackCalls = script.text.match(/document\.execCommand\(['"]copy['"]\)/g) || [];

  assert.equal(script.status, 200);
  assert.match(script.text, /fetch\(['"]\/api\/pages\/preview['"]/);
  assert.match(script.text, /navigator\.clipboard\.writeText/);
  assert.equal(fallbackCalls.length, 1);
  assert.match(script.text, /setAttribute\(['"]aria-busy['"]/);
  assert.match(script.text, /new AbortController\(\)/);
  assert.match(script.text, /signal: previewAbortController\.signal/);
  assert.match(script.text, /function markDraftDirty\(\)/);
  assert.match(script.text, /上次发布结果/);
  assert.match(script.text, /function resetPasswordVisibility\(\)/);
  assert.match(script.text, /continueButton\.addEventListener/);
});

test('preview renders through the existing sandbox without storing a page', async () => {
  const before = await app.locals.pageRepository.listRecent(1000);
  const payload = '<!doctype html><h1>Preview</h1></iframe><script>window.top.compromised = true</script>';
  const response = await jsonRequest('/api/pages/preview', {
    htmlContent: payload,
    codeType: 'html'
  });
  const after = await app.locals.pageRepository.listRecent(1000);

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.codeType, 'html');
  assert.match(response.body.document, /sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"/);
  assert.match(response.body.document, /&lt;\/iframe&gt;&lt;script&gt;/);
  assert.doesNotMatch(response.body.document, /<\/iframe><script>window\.top\.compromised/);
  assert.equal(after.length, before.length);
});

test('preview supports markdown and rejects empty content', async () => {
  const markdown = await jsonRequest('/api/pages/preview', {
    htmlContent: '# Preview heading',
    codeType: 'markdown',
    markdownTheme: 'github'
  });
  const empty = await jsonRequest('/api/pages/preview', {
    htmlContent: '   ',
    codeType: 'html'
  });

  assert.equal(markdown.status, 200);
  assert.equal(markdown.body.codeType, 'markdown');
  assert.match(markdown.body.document, /Preview heading/);
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, '请提供内容');
});
