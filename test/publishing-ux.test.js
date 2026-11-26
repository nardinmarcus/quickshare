const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('http');
const path = require('node:path');

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
  const uploadPosition = homepage.text.indexOf('id="upload-file-trigger"');
  const editorPosition = homepage.text.indexOf('id="html-input"');
  const previewPosition = homepage.text.indexOf('id="prepublish-preview-button"');
  const publishPosition = homepage.text.indexOf('id="generate-button"');
  const actionRowPosition = homepage.text.indexOf('class="button-row"');
  const actionRowMarkup = homepage.text.slice(actionRowPosition, homepage.text.indexOf('id="publish-status"'));

  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /<label[^>]+for="html-input"/);
  assert.ok(uploadPosition >= 0);
  assert.ok(uploadPosition < editorPosition);
  assert.doesNotMatch(actionRowMarkup, /for="html-file"/);
  assert.ok(previewPosition >= 0);
  assert.ok(previewPosition < publishPosition);
  assert.match(homepage.text, /id="publish-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(homepage.text, /id="publish-error"[^>]+role="alert"/);
  assert.match(homepage.text, /id="generate-button"[^>]+aria-busy="false"/);
  assert.match(homepage.text, /id="publish-preview"/);
  assert.match(homepage.text, /id="publish-preview-frame"[^>]+sandbox="allow-scripts"/);
  assert.match(homepage.text, /id="open-publish-preview"[^>]+target="_blank"[^>]+rel="noopener noreferrer"[^>]+hidden/);
  assert.match(homepage.text, /新标签打开/);
  assert.match(homepage.text, /id="result-eyebrow"/);
  assert.match(homepage.text, /id="result-access"/);
  assert.match(homepage.text, /id="result-type"/);
  assert.match(homepage.text, /id="result-expiry"/);
  assert.match(homepage.text, /打开分享页/);
  assert.match(homepage.text, /复制链接/);
  assert.match(homepage.text, /id="continue-button"[^>]*>[^<]*<i[^>]*><\/i>继续创建/s);
  assert.match(homepage.text, /id="manual-copy-output"[^>]+readonly[^>]+hidden/);
});

test('homepage folds publish settings into a summary and keeps one result copy action', async () => {
  const homepage = await request('/');
  const script = await request('/js/main.js');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');

  // Settings start collapsed behind a toggle whose summary states the
  // effective defaults, so the idle flow is paste + publish only.
  assert.match(homepage.text, /id="publish-settings-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="publish-settings-body"/);
  assert.match(homepage.text, /id="publish-settings-summary"[^>]*>持有链接可访问 · 长期有效 · 自动提取标题</);
  assert.match(homepage.text, /id="publish-settings-body"[^>]+hidden/);
  assert.match(script.text, /function updatePublishSettingsSummary\(\)/);
  assert.match(script.text, /function setPublishSettingsExpanded\(expanded\)/);

  // A custom password needs no separate confirm step, and the result
  // offers a single copy action instead of overlapping copy buttons.
  assert.doesNotMatch(homepage.text, /id="confirm-custom-password"/);
  assert.match(homepage.text, /填好直接点「发布并生成链接」即可/);
  assert.doesNotMatch(homepage.text, /id="copy-password-link"/);
  assert.match(script.text, /copyButtonPasswordMarkup/);
  assert.match(script.text, /function flashCopied\(button\)/);

  // The unconfirmed-publish choice is written in user language.
  assert.match(homepage.text, /上次发布没确认成功/);
  assert.doesNotMatch(homepage.text, /另一个发布会话/);

  // Publish-flow motion runs on one token set with one reveal keyframe.
  assert.match(css, /--motion-normal:\s*200ms/);
  assert.match(css, /--motion-easing:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
  assert.match(css, /@keyframes publishReveal/);
});

test('homepage layout uses desktop width to keep the idle publishing flow compact', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');

  assert.match(css, /--home-content-width:\s*1120px/);
  assert.match(css, /\[data-page="home-page"\] \.main-container\s*\{[^}]*max-width:\s*var\(--home-content-width\)/s);
  assert.match(css, /@media \(min-width:\s*960px\)[\s\S]*?\[data-page="home-page"\] \.publish-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.05fr\) minmax\(0, 1\.7fr\) minmax\(0, 1\.15fr\)/s);
  assert.match(css, /\[data-page="home-page"\] \.publish-field:nth-child\(2\)\s*\{[^}]*grid-column:\s*auto/s);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\[data-page="home-page"\] \.card\s*\{[^}]*padding-inline:\s*1rem/s);
  assert.match(css, /\.main-container\s*\{[^}]*max-width:\s*720px/s);
  assert.match(css, /\[data-page="home-page"\] \.upload-file-trigger\s*\{[^}]*min-height:\s*44px[^}]*background:\s*rgba\(var\(--primary-rgb\),\s*0\.07\)[^}]*color:\s*var\(--text-primary\)/s);
  // 垂直平衡：页眉与页脚的自动边距平分多余高度，短内容居中、长内容自然顶起
  assert.match(css, /\[data-page="home-page"\] \.app-header\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(css, /\[data-page="home-page"\] \.app-footer\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(css, /\[data-page="home-page"\] \.main-container\s*\{[^}]*min-height:\s*100dvh/s);
  assert.doesNotMatch(css, /\[data-page="home-page"\] \.upload-file-trigger\s*\{[^}]*background:\s*var\(--primary\)/s);
  assert.match(css, /\[data-page="home-page"\] \.button-row\s*\{[^}]*justify-content:\s*flex-end/s);
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
  assert.match(script.text, /function setOpenPreviewDocument\(safeDocument\)/);
  assert.match(script.text, /URL\.createObjectURL\(new Blob\(\[safeDocument\], \{ type: 'text\/html' \}\)\)/);
  assert.match(script.text, /URL\.revokeObjectURL\(previewObjectUrl\)/);
  assert.match(script.text, /setOpenPreviewDocument\(data\.document\)/);
  assert.match(script.text, /function markDraftDirty\(\)/);
  assert.match(script.text, /上次发布结果/);
  assert.match(script.text, /function resetPasswordVisibility\(\)/);
  assert.match(script.text, /continueButton\.addEventListener/);
});

test('preview renders through the existing sandbox without storing a page', async () => {
  const before = await app.locals.pageRepository.countPages();
  const payload = '<!doctype html><h1>Preview</h1></iframe><script>window.top.compromised = true</script>';
  const response = await jsonRequest('/api/pages/preview', {
    htmlContent: payload,
    codeType: 'html'
  });
  const after = await app.locals.pageRepository.countPages();

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.codeType, 'html');
  assert.match(response.body.document, /sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"/);
  assert.match(response.body.document, /&lt;\/iframe&gt;&lt;script&gt;/);
  assert.doesNotMatch(response.body.document, /<\/iframe><script>window\.top\.compromised/);
  assert.equal(after, before);
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
