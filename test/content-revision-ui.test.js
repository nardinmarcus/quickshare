const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue30-ui-synthetic-session-secret';
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const app = require('../app');
let server;
let origin;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function create() {
  const res = await fetch(`${origin}/api/pages/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ htmlContent: '<h1>UI30</h1>', codeType: 'html' })
  });
  assert.equal(res.status, 200);
  return (await res.json()).urlId;
}

test('detail view separates content and access saves and shows the content revision', async () => {
  const id = await create();
  const html = await (await fetch(`${origin}/admin/pages/${id}`)).text();
  assert.match(html, /id="content-revision-display"/);
  assert.match(html, /id="edit-save-content"/);
  assert.match(html, /id="edit-save-access"/);
  assert.match(html, /id="conflict-panel"/);
  assert.match(html, /id="conflict-diff"/);
  assert.match(html, /id="conflict-diff-status"/);
  assert.match(html, /id="conflict-take-remote"/);
  assert.match(html, /id="conflict-save-mine"/);
  assert.match(html, /id="conflict-meta"/);
});

test('dashboard client sends the strong content If-Match and separate access baseline', async () => {
  const source = await (await fetch(`${origin}/js/admin-detail.js`)).text();
  assert.match(source, /If-Match/, 'content save must send If-Match');
  assert.match(source, /'"content:' \+ data\.id \+ ':' \+ data\.currentRevision \+ '"'/, 'If-Match uses the quoted content tag family');
  assert.match(source, /expectedAccessRevision/, 'access save keeps its baseline');
  assert.match(source, /saveContent|edit-save-content/, 'content save action exists');
  assert.match(source, /saveAccess|edit-save-access/, 'access save action exists');
  assert.match(source, /CONTENT_REVISION_CONFLICT/, 'conflict responses are handled');
  assert.match(source, /SourceDiff|source-diff/, 'conflict wires the diff module');
});

test('untouched or reverted bodies transmit the raw original bytes, never LF-normalized values', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/admin-detail.js', 'utf8');
  const rawServerBody = 'CRLF line one\r\nCR-only line two\r\n';
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      _value: '', textContent: '', hidden: false, disabled: false, checked: false, dataset: {}, events: {}, attrs: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; },
      removeAttribute(n) { delete this.attrs[n]; }, focus() {},
      get value() { return this._value.replace(/\r\n?/g, '\n'); },
      set value(v) { this._value = v; }
    });
    return elements.get(id);
  }
  const original = { id: 'crlf-ui', title: 'Raw title', htmlContent: rawServerBody, isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  element('page-data').textContent = JSON.stringify(original);
  element('content-textarea')._value = rawServerBody;
  const calls = [];
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '' }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: { renderMetaChanges() {}, renderParts() {}, compare: async () => ({ status: 'ok', parts: [] }) } },
    Toast: { error() {}, success() {} },
    fetch: async (url, options) => { calls.push({ headers: options.headers, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ success: true, page: { ...original } }) }; },
    console, Date, performance
  });

  // 1. Untouched body, metadata-only save: the payload carries the ORIGINAL
  // raw bytes, never the textarea's LF-normalized value.
  await element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(calls[0].body.htmlContent, rawServerBody, 'untouched body must transmit the raw original bytes');
  assert.match(calls[0].body.htmlContent, /\r\n/);
  assert.equal(calls[0].headers['If-Match'], '"content:crlf-ui:1"');

  // 2. Reverted body (typed something, then back): still the raw original —
  // the LF-normalized textarea value is never substituted for it.
  element('content-textarea')._value = 'temporary edit';
  element('content-textarea')._value = rawServerBody;
  await element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(calls[1].body.htmlContent, rawServerBody);

  // 3. Actual edit: the edited value IS transmitted. A real textarea input
  // is LF-normalized by the browser, so that is exactly what the user typed.
  element('content-textarea')._value = 'actually edited\r\nby the user';
  await element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(calls[2].body.htmlContent, 'actually edited\nby the user');
});

test('save-mine after a conflict submits the complete reviewed candidate, not a silent remote-body merge', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/admin-detail.js', 'utf8');
  const rawCandidateBody = 'candidate A with CRLF\r\nsecond line';
  const remoteBody = 'remote B replaced the body entirely\n';
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      _value: '', textContent: '', hidden: false, disabled: false, checked: false, dataset: {}, events: {}, attrs: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; },
      removeAttribute(n) { delete this.attrs[n]; }, focus() {},
      get value() { return this._value.replace(/\r\n?/g, '\n'); },
      set value(v) { this._value = v; }
    });
    return elements.get(id);
  }
  const original = { id: 'save-mine', title: 'My title', htmlContent: rawCandidateBody, isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  element('page-data').textContent = JSON.stringify(original);
  element('content-textarea')._value = rawCandidateBody;
  const calls = [];
  const responses = [
    // First save collides with a remote body change → 412 with remote B.
    { ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: { id: 'save-mine', currentRevision: '2', htmlContent: remoteBody, codeType: 'html', title: 'Remote title', description: null, markdownTheme: null } }) },
    // save-mine re-submits with the fresh baseline from the conflict payload.
    { ok: true, status: 200, json: async () => ({ success: true, page: { ...original, currentRevision: '3' } }) }
  ];
  let call = 0;
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '' }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: { renderMetaChanges() {}, renderParts() {}, compare: async () => ({ status: 'ok', parts: [] }) } },
    Toast: { error() {}, success() {} },
    fetch: async (url, options) => { calls.push({ headers: options.headers, body: JSON.parse(options.body) }); return responses[Math.min(call++, responses.length - 1)]; },
    console, Date, performance
  });

  // The local candidate differs from the remote ONLY in the owner's intent:
  // locally the title was edited, the body is the untouched CRLF original.
  element('edit-title')._value = 'My edited title';
  await element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(calls[0].body.htmlContent, rawCandidateBody);
  assert.equal(calls[0].status, undefined);

  // After reviewing the A-vs-B difference the owner chooses save-mine.
  assert.equal(element('conflict-panel').hidden, false, 'conflict panel is visible');
  await element('conflict-save-mine').events.click();
  const mine = calls[1];
  assert.equal(mine.headers['If-Match'], '"content:save-mine:2"', 'save-mine uses the fresh remote baseline from the conflict payload');
  assert.equal(mine.body.title, 'My edited title', 'the owner metadata edit is submitted');
  assert.equal(mine.body.htmlContent, rawCandidateBody, 'the reviewed candidate body (raw bytes) is submitted whole — never the remote body, never a normalized stub');
});

test('official diff distribution is vendored locally with its BSD license', async () => {
  const fs = require('fs');
  const vendoredMin = fs.readFileSync('public/vendor/diff/diff.min.js', 'utf8');
  const official = fs.readFileSync('node_modules/diff/dist/diff.min.js', 'utf8');
  assert.equal(vendoredMin, official, 'public/vendor/diff/diff.min.js must be the unmodified official diff@9 browser build');
  const license = fs.readFileSync('public/vendor/diff/LICENSE', 'utf8');
  assert.match(license, /BSD 3-Clause/);
  assert.match(license, /Kevin Decker/);
  const dist = fs.readFileSync('public/vendor/diff/diff.js', 'utf8');
  assert.equal(dist, fs.readFileSync('node_modules/diff/dist/diff.js', 'utf8'), 'readable dist is vendored unmodified too');
  for (const path of ['/vendor/diff/diff.min.js', '/vendor/diff/LICENSE', '/js/source-diff.js', '/js/source-diff-worker.js']) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} must be served`);
  }
});

test('diff client enforces budgets and discards stale worker results', async () => {
  const source = await (await fetch(`${origin}/js/source-diff.js`)).text();
  assert.match(source, /new Worker\(/, 'diff runs in a Web Worker');
  assert.match(source, /2000/, 'outer termination deadline of 2000ms is present');
  assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1|localhost)[^'"]*(cdn|unpkg|jsdelivr|npmjs)/, 'no CDN references');
  const worker = await (await fetch(`${origin}/js/source-diff-worker.js`)).text();
  assert.match(worker, /importScripts\(['"]\/vendor\/diff\/diff\.min\.js['"]\)/, 'worker loads the local vendored build');
  assert.match(worker, /timeout:\s*DIFF_TIMEOUT_MS/, 'worker passes its algorithm budget to the official diff');
  assert.match(worker, /DIFF_TIMEOUT_MS = 1000/, 'worker algorithm budget of 1000ms is present');
  assert.match(worker, /diffLines/, 'worker uses the official line diff');
  assert.match(worker, /status:\s*'timeout'/, 'worker reports unfinished comparisons instead of pretending no differences');
  const renderer = await (await fetch(`${origin}/js/source-diff.js`)).text();
  assert.match(renderer, /差异过大|未完成比较/, 'oversized diffs are reported as unfinished');
  assert.match(renderer, /id\s*!==|!==\s*id|token/, 'results from a previous comparison target are discarded');
});

test('conflict panel is styled with the existing admin design language', async () => {
  const css = await (await fetch(`${origin}/css/styles.css`)).text();
  assert.match(css, /\.diff-part|\.diff-chunk|conflict-panel/);
  assert.match(css, /\.diff-added/);
  assert.match(css, /\.diff-removed/);
});
