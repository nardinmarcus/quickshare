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

// ---- #31 rework R2/R3/R4: conflict lifecycle consumer regressions. These
// drive the REAL admin-detail.js through its UI events with a token-aware
// SourceDiff double, so async chunked rendering can be exercised as the
// browser would (queued chunks may fire after the panel moved on). ----

function buildConflictHarness() {
  const elements = new Map();
  const nodeText = node => {
    if (typeof node.textContent === 'string' && node.textContent) return node.textContent;
    return (node.children || []).map(nodeText).join('');
  };
  function element(id) {
    if (!elements.has(id)) {
      const node = {
        id, _value: '', hidden: false, disabled: false, checked: false, dataset: {}, events: {}, attrs: {}, children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, fn) { this.events[name] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name]; },
        removeAttribute(name) { delete this.attrs[name]; },
        appendChild(child) { this.children.push(child); },
        focus() {},
        get value() { return this._value.replace(/\r\n?/g, '\n'); },
        set value(input) { this._value = input; }
      };
      Object.defineProperty(node, 'textContent', {
        get() { return this._ownText !== undefined ? this._ownText : (this.children || []).map(nodeText).join(''); },
        set(input) { this._ownText = input; this.children = []; }
      });
      Object.defineProperty(node, 'innerHTML', {
        get() { return nodeText(node); },
        set(input) { node.textContent = input; }
      });
      elements.set(id, node);
    }
    return elements.get(id);
  }
  // Token-aware SourceDiff double modeling the REAL contract: renderParts
  // renders its first chunk synchronously and queues the remainder; queued
  // chunks are dropped once cancelRender(container) has been called.
  const queuedRenders = [];
  const tokens = new Map();
  const compareCalls = [];
  const pendingCompares = [];
  const SourceDiff = {
    compare(oldText, newText) {
      compareCalls.push([oldText, newText]);
      let resolveFn;
      let rejectFn;
      const handle = (value) => resolveFn(value);
      handle.reject = (error) => rejectFn(error);
      pendingCompares.push(handle);
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
    renderParts(container, parts) {
      const token = tokens.get(container) || 0;
      container.textContent = '';
      const render = { container, parts, token, flushed: false };
      queuedRenders.push(render);
      return { totalRows: parts.length, truncated: false };
    },
    cancelRender(container) {
      tokens.set(container, (tokens.get(container) || 0) + 1);
    },
    renderMetaChanges() {},
    flushQueues() {
      for (const render of queuedRenders) {
        if ((tokens.get(render.container) || 0) !== render.token) { render.flushed = 'cancelled'; continue; }
        render.flushed = 'refilled';
        render.parts.forEach(part => {
          render.container.children.push({ textContent: 'REFILL:' + part.value });
        });
      }
    }
  };
  return { elements, element, SourceDiff, compareCalls, pendingCompares, queuedRenders };
}

function runAdminDetail(harness, globals) {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/admin-detail.js', 'utf8');
  vm.runInNewContext(source, globals);
}

test('stale queued diff chunks never refill the conflict panel after it moved on', async () => {
  const harness = buildConflictHarness();
  const rawServerBody = 'candidate A with CRLF\r\nsecond line';
  const original = { id: 'stale-render', title: 'T', htmlContent: rawServerBody, isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  harness.element('page-data').textContent = JSON.stringify(original);
  harness.element('content-textarea')._value = rawServerBody;

  const remoteA = { id: 'stale-render', currentRevision: '2', htmlContent: 'remote A body\n', codeType: 'html', title: 'T', description: null, markdownTheme: null };
  const remoteB = { id: 'stale-render', currentRevision: '3', htmlContent: 'remote B body\n', codeType: 'html', title: 'T', description: null, markdownTheme: null };
  const responses = [
    { ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: remoteA }) },
    { ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: remoteB }) }
  ];
  let call = 0;
  runAdminDetail(harness, {
    document: { getElementById: harness.element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '', className: '', children: [], appendChild() {}, setAttribute() {} }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: harness.SourceDiff },
    Toast: { error() {}, success() {} },
    fetch: async () => responses[Math.min(call++, responses.length - 1)],
    console, Date, performance
  });

  // Flow A: conflict → comparison starts → resolve with parts → its chunked
  // render is now QUEUED (not yet flushed to the DOM).
  const firstFlow = harness.element('edit-form').events.submit({ preventDefault() {} });
  await firstFlow;
  assert.equal(harness.compareCalls.length, 1);
  harness.pendingCompares[0]({ status: 'ok', parts: [{ value: 'stale chunk', added: false, removed: false }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.queuedRenders.length, 1, 'flow A queued a chunked render');

  // Owner discards the conflict (take-remote → hideConflictPanel).
  await harness.element('conflict-take-remote').events.click();
  assert.equal(harness.element('conflict-panel').hidden, true, 'panel hidden after take-remote');

  // Flow B: a fresh conflict whose comparison finishes as UNFINISHED.
  harness.element('content-textarea')._value = 'new draft for B';
  const secondFlow = harness.element('edit-form').events.submit({ preventDefault() {} });
  await secondFlow;
  harness.pendingCompares[1]({ status: 'timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.element('conflict-diff-status').textContent, /未完成比较/);

  // The stale queued render from flow A fires late (rAF finally runs it).
  harness.SourceDiff.flushQueues();
  const conflictDiff = harness.element('conflict-diff');
  assert.ok(!JSON.stringify(conflictDiff.children).includes('REFILL'), 'a stale queued render must never refill the moved-on panel');
  assert.match(harness.element('conflict-diff-status').textContent, /未完成比较/, 'the unfinished status is preserved');
});

test('the compared candidate equals the submitted candidate for untouched CRLF bodies', async () => {
  const harness = buildConflictHarness();
  const rawServerBody = 'CRLF line one\r\nline two\rmixed CR line three\n';
  const remoteRaw = 'remote replaced\r\nwith CRLF body\r\n';
  const original = { id: 'crlf-candidate', title: 'Old title', htmlContent: rawServerBody, isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  harness.element('page-data').textContent = JSON.stringify(original);
  harness.element('content-textarea')._value = rawServerBody;

  let call = 0;
  const respond = () => ({ ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: { id: 'crlf-candidate', currentRevision: '2', htmlContent: remoteRaw, codeType: 'html', title: 'Remote title', description: null, markdownTheme: null } }) });
  runAdminDetail(harness, {
    document: { getElementById: harness.element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '', className: '', children: [], appendChild() {}, setAttribute() {} }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: harness.SourceDiff },
    Toast: { error() {}, success() {} },
    fetch: async () => respond(call++),
    console, Date, performance
  });

  // Metadata-only edit (title), body untouched → the conflict comparison must
  // use the RAW original bytes as the local side, not the LF-normalized
  // textarea value that would show phantom end-of-line differences.
  harness.element('edit-title')._value = 'New title only';
  await harness.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(harness.compareCalls.length, 1);
  assert.deepEqual(harness.compareCalls[0], [remoteRaw, rawServerBody],
    'compare input must be the exact bytes a save would submit (raw original), never the LF-normalized textarea value');
  assert.match(harness.compareCalls[0][1], /\r\n|\r(?! )/, 'local compare side keeps CRLF/CR');
});

test('both complete raw sources are shown with accurate identity while the conflict is open', async () => {
  const harness = buildConflictHarness();
  const rawServerBody = 'local candidate CRLF\r\nsecond line';
  const remoteRaw = 'remote body\r\nwith CRLF';
  const original = { id: 'raw-both', title: 'T', htmlContent: rawServerBody, isProtected: false, accessRevision: '1', currentRevision: '7', expiresAt: null, markdownTheme: '' };
  harness.element('page-data').textContent = JSON.stringify(original);
  harness.element('content-textarea')._value = rawServerBody;

  let call = 0;
  runAdminDetail(harness, {
    document: { getElementById: harness.element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '', className: '', children: [], appendChild() {}, setAttribute() {} }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: harness.SourceDiff },
    Toast: { error() {}, success() {} },
    fetch: async () => ({ ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: { id: 'raw-both', currentRevision: '9', htmlContent: remoteRaw, codeType: 'html', title: 'Remote title', description: null, markdownTheme: null } }) }),
    console, Date, performance
  });

  await harness.element('edit-form').events.submit({ preventDefault() {} });
  const remoteView = harness.element('conflict-raw-remote');
  const localView = harness.element('conflict-raw-local');
  assert.ok(remoteView, 'a remote raw view exists');
  assert.ok(localView, 'a local candidate raw view exists');
  assert.equal(remoteView._value, remoteRaw, 'the frozen remote snapshot is shown in full');
  assert.equal(localView._value, rawServerBody, 'the local side shows the exact candidate bytes (raw, untouched)');
  const remoteTitle = harness.element('conflict-raw-remote-title').textContent;
  const localTitle = harness.element('conflict-raw-local-title').textContent;
  assert.match(remoteTitle, /9/, 'remote raw is labelled with the remote revision');
  assert.match(localTitle, /7/, 'local raw is labelled with the baseline revision the draft is based on');
  // Raw views remain populated on the unfinished path too.
  harness.pendingCompares[0]({ status: 'timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(remoteView._value, remoteRaw);
  assert.equal(localView._value, rawServerBody);
  assert.match(harness.element('conflict-diff-status').textContent, /未完成比较/);
  assert.doesNotMatch(harness.element('conflict-diff-status').textContent, /公开页面/, 'the unfinished status no longer points to public render pages');
});

// ---- #31 rework R2-failure-path: SourceDiff.compare CAN reject
// (worker-error). The conflict panel must reach a terminal, clearly
// unfinished state with raw sources reachable — never a stuck "正在比较…"
// and never a spurious error toast from the save flow. ----

test('a rejected comparison reaches a terminal unfinished state with raw sources reachable', async () => {
  const harness = buildConflictHarness();
  const rawServerBody = 'candidate body\r\nwith CRLF';
  const original = { id: 'reject-current', title: 'T', htmlContent: rawServerBody, isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  harness.element('page-data').textContent = JSON.stringify(original);
  harness.element('content-textarea')._value = rawServerBody;
  const toasts = [];
  runAdminDetail(harness, {
    document: { getElementById: harness.element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '', className: '', children: [], appendChild() {}, setAttribute() {} }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: harness.SourceDiff },
    Toast: { error(message) { toasts.push(message); }, success() {} },
    fetch: async () => ({ ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: { id: 'reject-current', currentRevision: '2', htmlContent: 'remote\r\nbody', codeType: 'html', title: 'T', description: null, markdownTheme: null } }) }),
    console, Date, performance
  });

  await harness.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(harness.compareCalls.length, 1);
  // The CURRENT target's comparison fails at the worker level.
  harness.pendingCompares[0].reject(new Error('worker-error'));
  await new Promise(resolve => setImmediate(resolve));

  const status = harness.element('conflict-diff-status').textContent;
  assert.match(status, /未完成/, 'the panel reaches a terminal UNFINISHED state');
  assert.doesNotMatch(status, /正在比较/, 'the panel is not stuck at the in-flight wording');
  assert.doesNotMatch(status, /差异过大/, 'a comparator failure is not mislabelled as an oversized diff');
  assert.equal(harness.element('conflict-panel').hidden, false, 'the conflict panel stays open with its raw views');
  assert.equal(harness.element('conflict-raw-remote')._value || harness.element('conflict-raw-remote').value, 'remote\r\nbody', 'remote raw stays reachable');
  assert.ok(!toasts.some(message => /worker-error/.test(message)), 'the internal worker error is not surfaced as a save-flow toast');
});

test('a late rejection from an OLD comparison target never overwrites the new target', async () => {
  const harness = buildConflictHarness();
  const original = { id: 'reject-stale', title: 'T', htmlContent: 'local\r\nbody', isProtected: false, accessRevision: '1', currentRevision: '1', expiresAt: null, markdownTheme: '' };
  harness.element('page-data').textContent = JSON.stringify(original);
  harness.element('content-textarea')._value = original.htmlContent;
  const toasts = [];
  const remotes = [
    { id: 'reject-stale', currentRevision: '2', htmlContent: 'remote A\r\n', codeType: 'html', title: 'T', description: null, markdownTheme: null },
    { id: 'reject-stale', currentRevision: '3', htmlContent: 'remote B\r\n', codeType: 'html', title: 'T', description: null, markdownTheme: null }
  ];
  let call = 0;
  runAdminDetail(harness, {
    document: { getElementById: harness.element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '', className: '', children: [], appendChild() {}, setAttribute() {} }) },
    window: { AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' }, SourceDiff: harness.SourceDiff },
    Toast: { error(message) { toasts.push(message); }, success() {} },
    fetch: async () => ({ ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: remotes[Math.min(call, 1)] }) }) && (call++, { ok: false, status: 412, json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: remotes[Math.min(call - 1, 1)] }) }),
    console, Date, performance
  });

  // Flow A starts; flow B supersedes it before A settles.
  await harness.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(harness.compareCalls.length, 1);
  harness.element('edit-title')._value = 'edited between flows';
  await harness.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(harness.compareCalls.length, 2, 'flow B started its own comparison');
  assert.match(harness.element('conflict-raw-remote-title').textContent, /第 3 版/, 'the panel now targets remote B');

  // Flow A's comparison fails LATE: it must not touch the B-targeted panel.
  harness.pendingCompares[0].reject(new Error('worker-error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.element('conflict-diff-status').textContent, /正在比较/, 'flow B remains in flight, untouched by the stale rejection');
  assert.ok(!toasts.some(message => /worker-error/.test(message)), 'the stale rejection surfaces no spurious toast');

  // Flow B then finishes normally and renders its own result.
  harness.pendingCompares[1]({ status: 'ok', parts: [{ value: 'B diff', added: true, removed: false }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.element('conflict-diff-status').textContent, /正文行级差异/, 'flow B completes with its own result');
});
