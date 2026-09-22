// #31 history UI: page structure, stale-result discipline in admin-history.js,
// version-labelled meta comparison, chunked/bounded diff rendering and the
// backward-compatible SourceDiff extension surface.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue31-ui-synthetic-secret';
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
    body: JSON.stringify({ htmlContent: '<h1>UI31 V1</h1>', codeType: 'html', title: 'UI31 share' })
  });
  assert.equal(res.status, 200);
  return (await res.json()).urlId;
}

async function historyPage(id) {
  return (await fetch(`${origin}/admin/pages/${id}/history`)).text();
}

test('the history page renders the shell, list, compare, preview and empty regions accessibly', async () => {
  const id = await create();
  const html = await historyPage(id);
  assert.match(html, /id="history-table"/, 'metadata table exists');
  assert.match(html, /id="history-empty"/, 'empty-state element exists');
  assert.match(html, /admin-pagination/, 'pagination uses the existing shell language');
  assert.match(html, /id="compare-select-a"/);
  assert.match(html, /id="compare-select-b"/);
  assert.match(html, /id="compare-run"/);
  assert.match(html, /id="compare-status"[^>]*role="status"/, 'comparison status is a live region');
  assert.match(html, /id="compare-meta-summary"/);
  assert.match(html, /id="compare-meta"/);
  assert.match(html, /id="compare-diff"/);
  assert.match(html, /id="history-raw-view"/, 'full raw source viewer for unfinished comparisons');
  assert.match(html, /id="history-preview-frame"/);
  assert.match(html, /sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"/,
    'the embedded preview iframe never grants same-origin');
  assert.match(html, /id="history-preview-open"/, 'direct preview opening is available');
  assert.match(html, /暂无|版本历史/, 'honest empty or populated presentation');
  assert.match(html, /北京/, 'times are presented in the management time zone');
});

test('the detail page links the history surface', async () => {
  const id = await create();
  const html = await (await fetch(`${origin}/admin/pages/${id}`)).text();
  assert.match(html, new RegExp(`href="/admin/pages/${id}/history"`));
});

test('admin-history.js enforces stale-result discipline and version-labelled comparison', async () => {
  const source = await (await fetch(`${origin}/js/admin-history.js`)).text();
  assert.match(source, /revisions\/'\s*\+|\/admin\/pages\/'\s*\+/, 'history client targets the owned endpoints');
  assert.match(source, /compareToken|comparisonToken|historyToken/, 'a monotonic token guards async flows');
  assert.match(source, /SourceDiff\.compare/, 'body diff runs through the official worker client');
  assert.match(source, /renderMetaChanges/, 'meta fields are compared');
  assert.match(source, /previousLabel|currentLabel|版本/, 'labels identify the selected revisions, not a draft');
  assert.match(source, /未完成比较|差异过大/, 'unfinished comparisons are reported as unfinished');
  assert.match(source, /revisions\/'\s*\+[^]*preview/, 'preview targets the dedicated sandboxed endpoint');
  assert.ok(!source.includes('allow-same-origin'), 'the client never adds same-origin grants');
  assert.match(source, /dataset\.|token|expected/, 'preview/raw assignments guard against stale loads');
});

test('SourceDiff.renderMetaChanges stays backward compatible and supports version labels', async () => {
  const source = await (await fetch(`${origin}/js/source-diff.js`)).text();
  assert.match(source, /当前远端/, 'the #30 conflict labels remain the default');
  assert.match(source, /我的修改/);
  assert.match(source, /previousLabel|leftLabel/, 'custom previous-side label option exists');
  assert.match(source, /currentLabel|rightLabel/, 'custom current-side label option exists');
  assert.match(source, /MAX_RENDERED_ROWS|initialRows|chunk/i, 'rendering is bounded and chunked');
});

// DOM-conformance text: a node's text is its own textContent when set,
// otherwise the recursive text of its children.
const nodeText = node => {
  if (typeof node.textContent === 'string' && node.textContent) return node.textContent;
  return (node.children || []).map(nodeText).join('');
};

function buildDom() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const node = {
        id, _value: '', hidden: false, disabled: false, dataset: {}, events: {}, attrs: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, fn) { this.events[name] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; },
        getAttribute(name) { return this.attrs[name]; },
        removeAttribute(name) { delete this.attrs[name]; },
        appendChild(child) { this.children.push(child); },
        focus() {},
        closest() { return null; }
      };
      Object.defineProperty(node, 'value', {
        get() { return this._value; },
        set(input) { this._value = input; }
      });
      Object.defineProperty(node, 'src', {
        get() { return this.attrs.src; },
        set(input) { this.attrs.src = input; }
      });
      Object.defineProperty(node, 'textContent', {
        get() { return this._ownText !== undefined ? this._ownText : (this.children || []).map(nodeText).join(''); },
        set(input) { this._ownText = input; this.children = []; }
      });
      Object.defineProperty(node, 'innerHTML', {
        get() { return nodeText(node); },
        set(input) { this._innerHTML = input; this.children = []; }
      });
      elements.set(id, node);
    }
    return elements.get(id);
  }
  return { elements, element };
}

function runHistoryClient(dom, globals) {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/admin-history.js', 'utf8');
  vm.runInNewContext(source, globals);
}

function historyGlobals(dom, overrides = {}) {
  const AdminTime = { format: value => 'formatted-' + value, toDateTimeLocal: () => '', parseDateTimeLocal: () => 0 };
  return {
    document: {
      getElementById: dom.element,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => {
        const node = { className: '', children: [], dataset: {}, appendChild(child) { this.children.push(child); }, setAttribute() {} };
        Object.defineProperty(node, 'textContent', {
          get() { return this._ownText !== undefined ? this._ownText : (this.children || []).map(nodeText).join(''); },
          set(input) { this._ownText = input; this.children = []; }
        });
        Object.defineProperty(node, 'innerHTML', {
          get() { return nodeText(node); },
          set(input) { node.textContent = input; }
        });
        return node;
      }
    },
    window: { AdminTime, SourceDiff: overrides.SourceDiff || { compare: async () => ({ status: 'ok', parts: [] }), renderParts() {}, renderMetaChanges() {}, cancelRender() {} } },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    Toast: { error() {}, success() {} },
    setTimeout, clearTimeout, console, Date, encodeURIComponent
  };
}

const HISTORY_DATA = {
  id: 'hist-ui', codeType: 'markdown', currentRevision: '3',
  revisions: [
    { revision: '3', createdAt: 1700000003000, source: 'dashboard-edit', restoredFrom: null },
    { revision: '2', createdAt: 1700000002000, source: 'dashboard-edit', restoredFrom: null },
    { revision: '1', createdAt: 1700000001000, source: 'api', restoredFrom: null }
  ],
  pagination: { page: 1, limit: 20, total: '3', totalPages: 1, hasNext: false, hasPrevious: false }
};

test('rapid comparison switches discard the stale flow and only the final target renders', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  dom.element('compare-select-a')._value = '2';
  dom.element('compare-select-b')._value = '3';

  const bodies = {
    '1': 'first body', '2': 'second body', '3': 'third body'
  };
  const meta = {
    '1': { revision: '1', htmlContent: bodies['1'], title: 'T1', description: 'D1', markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h1', createdAt: 1, source: 'api', restoredFrom: null },
    '2': { revision: '2', htmlContent: bodies['2'], title: 'T2', description: 'D2', markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h2', createdAt: 2, source: 'dashboard-edit', restoredFrom: null },
    '3': { revision: '3', htmlContent: bodies['3'], title: 'T3', description: 'D3', markdownTheme: 'bytedance', codeType: 'markdown', snapshotHash: 'h3', createdAt: 3, source: 'dashboard-edit', restoredFrom: null }
  };
  const fetchLog = [];
  // The FIRST worker call is gated: it only resolves after the owner has
  // already switched to a new comparison, proving late results are dropped.
  let releaseFirst = () => {};
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const sourceDiffCalls = [];
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      fetchLog.push(url);
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      return { ok: true, status: 200, json: async () => ({ success: true, revision: meta[revision] }) };
    },
    SourceDiff: {
      compare: async (oldText, newText) => {
        sourceDiffCalls.push([oldText, newText]);
        if (sourceDiffCalls.length === 1) await firstGate;
        return { status: 'ok', parts: [{ value: 'diff', added: false, removed: false }] };
      },
      renderParts() {}, renderMetaChanges() {}, cancelRender() {}
    }
  });
  runHistoryClient(dom, globals);

  const firstFlow = dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sourceDiffCalls.length, 1, 'the first flow fetched both revisions and started its comparison');
  // Switch immediately to revisions 1 vs 3 while the first comparison is pending.
  dom.element('compare-select-a')._value = '1';
  dom.element('compare-select-b')._value = '3';
  const secondFlow = dom.element('compare-run').events.click();
  await secondFlow;

  releaseFirst();
  await firstFlow;
  await new Promise(resolve => setImmediate(resolve));

  const rendered = dom.element('compare-meta-summary').innerHTML + dom.element('compare-status').textContent;
  assert.match(rendered, /版本 1/, 'the surviving flow is labelled with its own revisions');
  assert.match(rendered, /版本 3/);
  assert.ok(!rendered.includes('版本 2'), 'the superseded target never renders');
  assert.equal(sourceDiffCalls.length, 2, 'both flows reached the worker client…');
  assert.deepEqual(sourceDiffCalls.at(-1), [bodies['1'], bodies['3']], '…but only the final comparison is authoritative');
  assert.ok(!dom.element('compare-meta-summary').innerHTML.includes('T2'), 'stale metadata values are not shown');
});

test('an unfinished comparison is displayed as unfinished and keeps both raw sources reachable', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  dom.element('compare-select-a')._value = '1';
  dom.element('compare-select-b')._value = '2';

  const meta = {
    '1': { revision: '1', htmlContent: 'AAA huge\nbody', title: 'T1', description: null, markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h1', createdAt: 1, source: 'api', restoredFrom: null },
    '2': { revision: '2', htmlContent: 'BBB huge\nbody', title: 'T2', description: null, markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h2', createdAt: 2, source: 'dashboard-edit', restoredFrom: null }
  };
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      return { ok: true, status: 200, json: async () => ({ success: true, revision: meta[revision] }) };
    },
    SourceDiff: {
      compare: async () => ({ status: 'timeout' }),
      renderParts() {}, renderMetaChanges() {}, cancelRender() {}
    }
  });
  runHistoryClient(dom, globals);

  await dom.element('compare-run').events.click();
  const status = dom.element('compare-status').textContent;
  assert.match(status, /未完成比较|差异过大/, 'timeout is reported as unfinished');
  assert.ok(!status.includes('没有'), 'an unfinished comparison is never shown as "no differences"');
  const rawPanel = dom.element('history-raw-view');
  assert.equal(rawPanel.hidden, false, 'raw sources are reachable after an unfinished comparison');
  assert.match(dom.element('compare-meta-summary').innerHTML + dom.element('compare-status').textContent, /版本 1[\s\S]*版本 2|版本 1|版本 2/);
});

test('single-version raw and preview selections guard against stale loads', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  const revisions = {
    '1': { revision: '1', htmlContent: 'OLD RAW', title: null, description: null, markdownTheme: null, codeType: 'html', snapshotHash: 'h', createdAt: 1, source: 'api', restoredFrom: null },
    '2': { revision: '2', htmlContent: 'NEW RAW', title: null, description: null, markdownTheme: null, codeType: 'html', snapshotHash: 'h', createdAt: 2, source: 'api', restoredFrom: null }
  };
  let blockSecond;
  const gate = new Promise(resolve => { blockSecond = resolve; });
  let calls = 0;
  const rawView = dom.element('history-raw-view');
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      calls += 1;
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      if (calls === 1) { await gate; return { ok: true, status: 200, json: async () => ({ success: true, revision: revisions[revision] }) }; }
      return { ok: true, status: 200, json: async () => ({ success: true, revision: revisions[revision] }) };
    }
  });
  rawView.hidden = true;
  runHistoryClient(dom, globals);

  const rawAction = revision => dom.element('history-table').events.click({
    target: { closest: selector => (selector.includes('data-history-action') ? {
      getAttribute: name => (name === 'data-history-action' ? 'raw' : name === 'data-revision' ? revision : null)
    } : null) }
  });
  const first = rawAction('1');
  const second = rawAction('2');
  blockSecond();
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rawView._value, 'NEW RAW', 'the stale older fetch never overwrites the newer selection');
});

test('diff rendering is chunked, bounded, and cancellable', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/source-diff.js', 'utf8');
  const created = [];
  function createElement() {
    const node = { className: '', children: [], dataset: {}, appendChild(child) { this.children.push(child); }, setAttribute() {} };
    Object.defineProperty(node, 'textContent', {
      get() { return this._ownText || this.children.map(child => child.textContent).join(''); },
      set(value) { this._ownText = value; this.children = []; }
    });
    created.push(node);
    return node;
  }
  let queued = [];
  const scheduler = callback => { queued.push(callback); return queued.length; };
  const context = {
    document: { createElement },
    Worker: function () { return { postMessage() {}, terminate() {} }; },
    requestAnimationFrame: scheduler,
    setTimeout: scheduler
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const SourceDiff = context.SourceDiff;
  const container = createElement();
  const part = { value: Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n'), added: false, removed: false };

  const outcome = SourceDiff.renderParts(container, [part], { chunkSize: 400 });
  const rowsAfterFirstChunk = container.children.length;
  assert.ok(rowsAfterFirstChunk > 0 && rowsAfterFirstChunk <= 401, `the first synchronous chunk is bounded (got ${rowsAfterFirstChunk})`);
  assert.equal(outcome.totalRows, 3000);
  assert.equal(outcome.truncated, true, 'rows beyond the hard cap are honestly truncated, never silently dropped');

  let guard = 0;
  while (queued.length && guard < 100) {
    const next = queued.shift();
    next();
    guard += 1;
  }
  assert.equal(container.children.filter(child => (child.className || '').includes('diff-truncated')).length, 1,
    'exactly one truncation notice explains the bounded display');
  assert.ok(!container.textContent.includes('未完成'), 'truncation notice does not pretend the diff failed');
  assert.ok(container.textContent.match(/2000/), 'the truncation notice states the bound');

  const fresh = createElement();
  queued = [];
  const bigPart = { value: Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n'), added: false, removed: false };
  const second = SourceDiff.renderParts(fresh, [bigPart], { chunkSize: 300 });
  assert.equal(second.truncated, false, '1200 rows are below the 2000-row cap');
  const renderedBeforeCancel = fresh.children.length;
  SourceDiff.cancelRender(fresh);
  while (queued.length) queued.shift()();
  assert.equal(fresh.children.length, renderedBeforeCancel, 'a cancelled render appends no further chunks');
});

test('renderMetaChanges labels default to the #30 conflict wording and accept history labels', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/source-diff.js', 'utf8');
  const context = {
    document: { createElement: () => ({ textContent: '', className: '', children: [], appendChild(child) { this.children.push(child); }, setAttribute() {} }) },
    Worker: function () { return { postMessage() {}, terminate() {} }; }
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const SourceDiff = context.SourceDiff;
  const fields = [
    { label: '标题', remoteValue: 'A title', localValue: 'B title' },
    { label: '描述', remoteValue: 'same', localValue: 'same' },
    { label: 'Markdown 主题', remoteValue: 'github', localValue: 'bytedance' }
  ];

  const legacy = { textContent: '', children: [], appendChild(child) { this.children.push(child); } };
  SourceDiff.renderMetaChanges(legacy, fields);
  const legacyText = JSON.stringify(legacy.children.map(row => row.children.map(cell => cell.textContent).join('|')));
  assert.match(legacyText, /当前远端/, 'default labels keep the #30 conflict wording');
  assert.match(legacyText, /我的修改/);
  assert.ok(!legacyText.includes('same|'), 'unchanged fields produce no row');

  const history = { textContent: '', hidden: true, children: [], appendChild(child) { this.children.push(child); } };
  SourceDiff.renderMetaChanges(history, fields, { previousLabel: '版本 2', currentLabel: '版本 5' });
  const historyText = JSON.stringify(history.children.map(row => row.children.map(cell => cell.textContent).join('|')));
  assert.match(historyText, /版本 2：A title/);
  assert.match(historyText, /版本 5：B title/);
  assert.ok(!historyText.includes('当前远端'), 'history comparisons are never mislabelled as a draft');
  assert.equal(history.hidden, false);
});

// ---- #31 rework R1/R4: cross-page comparison and both-side raw reachability
// through the normal history UI. ----

test('compare inputs accept arbitrary revision strings, not only the current page', async () => {
  const id = await create();
  const html = await historyPage(id);
  assert.match(html, /<input[^>]*id="compare-select-a"/, 'version A is a free input, not a page-limited select');
  assert.match(html, /<input[^>]*id="compare-select-b"/, 'version B is a free input, not a page-limited select');
  assert.match(html, /list="history-revision-options"/, 'current-page revisions remain reachable via a datalist');
  assert.match(html, /id="history-revision-options"/);
  assert.doesNotMatch(html, /选择本页两个版本/, 'the compare contract is not scoped to the current page');
});

test('typed out-of-page versions compare verbatim with exact >2^53 labels', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify({
    id: 'cross-page', codeType: 'markdown', currentRevision: '9007199254740993',
    revisions: [
      { revision: '9007199254740993', createdAt: 3, source: 'dashboard-edit', restoredFrom: null },
      { revision: '9007199254740992', createdAt: 2, source: 'dashboard-edit', restoredFrom: null }
    ],
    pagination: { page: 1, limit: 20, total: '2', totalPages: 1, hasNext: false, hasPrevious: false }
  });
  const big = { revision: '9007199254740993', htmlContent: 'big newest body', title: 'BT', description: null, markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h', createdAt: 3, source: 'dashboard-edit', restoredFrom: null };
  const first = { revision: '1', htmlContent: 'very first body', title: 'FT', description: null, markdownTheme: 'github', codeType: 'markdown', snapshotHash: 'h', createdAt: 1, source: 'api', restoredFrom: null };
  const fetchUrls = [];
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      fetchUrls.push(url);
      if (url.endsWith('/revisions/9007199254740993')) return { ok: true, status: 200, json: async () => ({ success: true, revision: big }) };
      if (url.endsWith('/revisions/1')) return { ok: true, status: 200, json: async () => ({ success: true, revision: first }) };
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'Revision not found' }) };
    },
    SourceDiff: {
      compare: async () => ({ status: 'ok', parts: [{ value: 'x', added: false, removed: false }] }),
      renderParts() {}, renderMetaChanges() {}, cancelRender() {}
    }
  });
  runHistoryClient(dom, globals);
  dom.element('compare-select-a')._value = '1';
  dom.element('compare-select-b')._value = '9007199254740993';
  await dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(fetchUrls.some(url => url.endsWith('/revisions/1')), 'version 1 is fetched even though it is not on this page');
  assert.ok(fetchUrls.some(url => url.endsWith('/revisions/9007199254740993')), 'the >2^53 revision string is passed verbatim');
  const rendered = dom.element('compare-meta-summary').innerHTML + dom.element('compare-status').textContent;
  assert.match(rendered, /版本 1/, 'the first-version label is exact');
  assert.match(rendered, /版本 9007199254740993/, 'the >2^53 label is the exact decimal string');
});

test('missing and invalid typed versions produce version-labelled clear statuses', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      if (revision === '999') return { ok: false, status: 404, json: async () => ({ success: false, error: 'Revision not found' }) };
      if (revision === 'abc') return { ok: false, status: 400, json: async () => ({ success: false, code: 'INVALID_CONTENT_REVISION', error: 'content revision must be a positive decimal string' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, revision: { revision, htmlContent: 'body ' + revision, title: null, description: null, markdownTheme: null, codeType: 'markdown', snapshotHash: 'h', createdAt: 1, source: 'api', restoredFrom: null } }) };
    }
  });
  runHistoryClient(dom, globals);
  dom.element('compare-select-a')._value = HISTORY_DATA.revisions[HISTORY_DATA.revisions.length - 1].revision;
  dom.element('compare-select-b')._value = '999';
  await dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  let status = dom.element('compare-status').textContent;
  assert.match(status, /999/, 'the failing version is named');
  assert.match(status, /不存在/, 'a missing version is clearly reported as not existing');
  dom.element('compare-select-b')._value = 'abc';
  await dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  status = dom.element('compare-status').textContent;
  assert.match(status, /abc/, 'the invalid version is named');
  assert.match(status, /有效|无效|格式/, 'an invalid version is clearly reported as a format problem');
});

test('both compared revisions expose full raw sources and previews from the compare panel', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  const bodies = {
    '1': 'first RAW body', '3': 'newest RAW body'
  };
  const meta = {
    '1': { revision: '1', htmlContent: bodies['1'], title: null, description: null, markdownTheme: null, codeType: 'markdown', snapshotHash: 'h', createdAt: 1, source: 'api', restoredFrom: null },
    '3': { revision: '3', htmlContent: bodies['3'], title: null, description: null, markdownTheme: null, codeType: 'markdown', snapshotHash: 'h', createdAt: 3, source: 'dashboard-edit', restoredFrom: null }
  };
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      return { ok: true, status: 200, json: async () => ({ success: true, revision: meta[revision] }) };
    },
    SourceDiff: {
      compare: async () => ({ status: 'ok', parts: [{ value: 'x', added: false, removed: false }] }),
      renderParts() {}, renderMetaChanges() {}, cancelRender() {}
    }
  });
  runHistoryClient(dom, globals);
  dom.element('compare-select-a')._value = '1';
  dom.element('compare-select-b')._value = '3';
  await dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  const rawA = dom.element('compare-raw-a');
  const rawB = dom.element('compare-raw-b');
  assert.ok(rawA && rawA.events.click, 'a raw button for compared version A exists in the compare panel');
  assert.ok(rawB && rawB.events.click, 'a raw button for compared version B exists in the compare panel');
  await rawB.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.element('history-raw-view')._value, bodies['3'], 'version B raw loads even though it came from the compare panel');
  await rawA.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.element('history-raw-view')._value, bodies['1'], 'version A raw loads as well');
  const previewA = dom.element('compare-preview-a');
  assert.ok(previewA && previewA.events.click, 'a preview action for compared version A exists');
  await previewA.events.click();
  assert.equal(dom.element('history-preview-frame').getAttribute('src'), '/admin/pages/hist-ui/revisions/1/preview', 'preview targets the compared revision');
});

// ---- #31 rework R2-failure-path: a comparator failure is a distinct,
// terminal unfinished state in the history UI too — never mislabelled as an
// oversized diff, with raw sources reachable. ----

test('a rejected comparison reports a distinct unfinished failure with raw sources reachable', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  dom.element('compare-select-a')._value = '1';
  dom.element('compare-select-b')._value = '2';
  const meta = {
    '1': { revision: '1', htmlContent: 'AAA', title: null, description: null, markdownTheme: null, codeType: 'markdown', snapshotHash: 'h', createdAt: 1, source: 'api', restoredFrom: null },
    '2': { revision: '2', htmlContent: 'BBB', title: null, description: null, markdownTheme: null, codeType: 'markdown', snapshotHash: 'h', createdAt: 2, source: 'api', restoredFrom: null }
  };
  const globals = historyGlobals(dom, {
    fetch: async (url) => {
      const revision = url.split('/revisions/')[1]?.split(/[/?]/)[0];
      return { ok: true, status: 200, json: async () => ({ success: true, revision: meta[revision] }) };
    },
    SourceDiff: {
      compare: async () => { throw new Error('worker-error'); },
      renderParts() {}, renderMetaChanges() {}, cancelRender() {}
    }
  });
  runHistoryClient(dom, globals);
  await dom.element('compare-run').events.click();
  await new Promise(resolve => setImmediate(resolve));
  const status = dom.element('compare-status').textContent;
  assert.match(status, /未完成/, 'the comparison reports an unfinished state');
  assert.match(status, /失败|异常|错误/, 'the comparator failure is named as a failure');
  assert.doesNotMatch(status, /差异过大/, 'a comparator failure is not mislabelled as an oversized diff');
  assert.doesNotMatch(status, /worker-error/, 'internal error identities are not surfaced raw');
  assert.equal(dom.element('history-raw-panel').hidden, false, 'raw sources stay reachable');
  assert.equal(dom.element('history-raw-view')._value, 'AAA', 'version A raw is auto-loaded for the failed comparison');
});

// ---- #33 owner restore UI: dialog identity, idempotent intent ----

function buildDom2() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const node = {
        id, _value: '', _ownText: undefined, hidden: false, disabled: false, dataset: {}, events: {}, attrs: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, fn) { this.events[name] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name]; },
        removeAttribute(name) { delete this.attrs[name]; },
        appendChild(child) { this.children.push(child); },
        focus() { this.focused = true; },
        closest() { return null; }
      };
      Object.defineProperty(node, 'value', {
        get() { return this._value; },
        set(input) { this._value = input; }
      });
      Object.defineProperty(node, 'textContent', {
        get() { return this._ownText !== undefined ? this._ownText : ''; },
        set(input) { this._ownText = input; }
      });
      elements.set(id, node);
    }
    return elements.get(id);
  }
  return { elements, element };
}

function restoreGlobals(dom, overrides = {}) {
  const storage = new Map();
  return {
    document: {
      documentElement: { dataset: overrides.sessionTag ? { dashboardSessionTag: overrides.sessionTag } : {} },
      getElementById: dom.element,
      querySelector: (selector) => {
        if (selector === 'meta[name="csrf-token"]') return { getAttribute: () => 'csrf-token-33' };
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => dom.element('created-' + Math.random())
    },
    window: {
      QuickSharePublishingRequest: overrides.publishingRequest || null,
      AdminTime: { format: v => 'f' + v, toDateTimeLocal: () => '', parseDateTimeLocal: () => 0 },
      SourceDiff: { compare: async () => ({ status: 'ok', parts: [] }), renderParts() {}, renderMetaChanges() {}, cancelRender() {} },
      location: { reload: overrides.reload || (() => {}) },
      sessionStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
      }
    },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    Toast: { error() {}, success() {} },
    setTimeout, clearTimeout, console, Date, encodeURIComponent
  };
}

function runHistoryScript(globals) {
  const fs = require('fs');
  const vm = require('vm');
  globals.window.document = globals.document;
  vm.runInNewContext(fs.readFileSync('public/js/publishing-request.js', 'utf8'), globals);
  vm.runInNewContext(fs.readFileSync('public/js/admin-history.js', 'utf8'), globals);
}

const HISTORY_DATA_33 = {
  id: 'hist-restore',
  codeType: 'html',
  currentRevision: '3',
  revisions: [
    { revision: '3', createdAt: 3, source: 'dashboard-edit', restoredFrom: null },
    { revision: '2', createdAt: 2, source: 'dashboard-edit', restoredFrom: null },
    { revision: '1', createdAt: 1, source: 'web', restoredFrom: null }
  ],
  pagination: { page: 1, limit: 20, total: '3', totalPages: 1, hasNext: false, hasPrevious: false }
};

test('the restore dialog identifies the source and current revisions and states the policy is unchanged', async () => {
  const id = await create();
  const html = await historyPage(id);
  assert.match(html, /data-history-action="restore"/, 'each revision row offers a restore action');
  assert.match(html, /id="restore-dialog"/, 'the confirm dialog exists');
  assert.match(html, /id="restore-policy-note"/, 'the policy note exists');
  assert.match(html, /不改变分享链接、密码、有效期、访问版本、发布状态、收藏或浏览量/, 'the note enumerates the untouched policy surface');
  assert.match(html, /data-dashboard-session-tag=/, 'the page binds the dashboard session tag');
  assert.match(html, /publishing-request\.js/, 'the dashboard intent helper is loaded');

  // VM: opening the dialog names BOTH the source and the current version.
  const dom = buildDom2();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
  runHistoryScript(restoreGlobals(dom));
  const restoreButton = { getAttribute: (name) => (name === 'data-history-action' ? 'restore' : name === 'data-revision' ? '1' : null), closest: () => null };
  const rowButton = dom.element('history-table');
  // Simulate the delegated click path through the row button element.
  rowButton.events.click({
    target: {
      closest(selector) {
        if (selector === '[data-history-action]') {
          return {
            getAttribute: (name) => (name === 'data-history-action' ? 'restore' : '1')
          };
        }
        return null;
      }
    }
  });
  assert.equal(dom.element('restore-dialog').hidden, false, 'the dialog opens');
  assert.match(dom.element('restore-summary').textContent, /版本 1/, 'the summary names the SOURCE revision');
  assert.match(dom.element('restore-summary').textContent, /当前版本为 3/, 'the summary names the CURRENT revision');
  assert.match(dom.element('restore-summary').textContent, /访问策略不变/);
});

test('restore confirm sends the source revision, current If-Match and one request id; success confirms and reloads', async () => {
  const dom = buildDom2();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
  const calls = [];
  let reloaded = false;
  const globals = restoreGlobals(dom, {
    sessionTag: 'session-A',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, changed: true, requestId: options.headers['Idempotency-Key'], page: { currentRevision: '4' } })
      };
    },
    reload: () => { reloaded = true; }
  });
  runHistoryScript(globals);
  dom.element('history-table').events.click({
    target: { closest: (selector) => (selector === '[data-history-action]' ? { getAttribute: (name) => (name === 'data-history-action' ? 'restore' : '1') } : null) }
  });
  await dom.element('restore-confirm').events.click();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/admin/pages/hist-restore/restore');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['If-Match'], '"content:hist-restore:3"', 'the tag identifies the CURRENT content');
  assert.match(calls[0].options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/, 'one client-generated UUID per intent');
  assert.deepEqual(JSON.parse(calls[0].options.body), { revision: '1' });
  assert.equal(globals.window.sessionStorage.getItem('quickshare.dashboard.intent.restore.hist-restore'), null,
    'a confirmed restore consumes the pending intent');
  assert.equal(reloaded, true, 'the page reloads so the list and current revision are honest');
  assert.match(dom.element('restore-summary').textContent, /访问策略不变/);
});

test('a lost restore response keeps the pending intent and the retry reuses the ORIGINAL id', async () => {
  const dom = buildDom2();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
  const calls = [];
  let fail = true;
  const globals = restoreGlobals(dom, {
    sessionTag: 'session-A',
    fetch: async (url, options) => {
      calls.push(options.headers['Idempotency-Key']);
      if (fail) throw new TypeError('network down');
      return { ok: true, status: 200, json: async () => ({ success: true, changed: true, page: { currentRevision: '4' } }) };
    },
    reload: () => {}
  });
  runHistoryScript(globals);
  dom.element('history-table').events.click({
    target: { closest: (selector) => (selector === '[data-history-action]' ? { getAttribute: (name) => (name === 'data-history-action' ? 'restore' : '1') } : null) }
  });
  await dom.element('restore-confirm').events.click();
  assert.equal(calls.length, 1);
  assert.match(dom.element('restore-status').textContent, /结果未知/);
  assert.match(dom.element('restore-status').textContent, /原请求重试/);

  // The pending intent survived with the ORIGINAL id and the draft key.
  const pending = JSON.parse(globals.window.sessionStorage.getItem('quickshare.dashboard.intent.restore.hist-restore'));
  assert.equal(pending.requestId, calls[0]);

  fail = false;
  await dom.element('restore-confirm').events.click();
  assert.equal(calls.length, 2);
  assert.equal(calls[1], calls[0], 'the retry reuses the ORIGINAL request id and confirms the original result');
  assert.equal(globals.window.sessionStorage.getItem('quickshare.dashboard.intent.restore.hist-restore'), null);
});

test('a 412 during restore retains the original baseline and id until explicit conflict resolution', async () => {
  const dom = buildDom2();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
  const calls = [];
  const globals = restoreGlobals(dom, {
    sessionTag: 'session-A',
    fetch: async (url, options) => {
      calls.push({ id: options.headers['Idempotency-Key'], ifMatch: options.headers['If-Match'] });
      if (calls.length === 1) {
        return {
          ok: false, status: 412,
          json: async () => ({ success: false, code: 'CONTENT_REVISION_CONFLICT', error: 'conflict', current: { currentRevision: '9' } })
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, changed: true, page: { currentRevision: '10' } }) };
    },
    reload: () => {}
  });
  runHistoryScript(globals);
  dom.element('history-table').events.click({
    target: { closest: (selector) => (selector === '[data-history-action]' ? { getAttribute: (name) => (name === 'data-history-action' ? 'restore' : '2') } : null) }
  });
  await dom.element('restore-confirm').events.click();
  assert.equal(calls.length, 1);
  assert.match(dom.element('restore-status').textContent, /第 9 版/, 'the dialog names the new current version');
  assert.match(dom.element('restore-status').textContent, /未执行也未产生新版本/);
  const pending = JSON.parse(globals.window.sessionStorage.getItem('quickshare.dashboard.intent.restore.hist-restore'));
  assert.equal(pending.requestId, calls[0].id, 'a refusal does not abandon an unknown earlier attempt');
  assert.match(dom.element('restore-summary').textContent, /当前版本为 3/, 'the authorized baseline is unchanged');

  await dom.element('restore-confirm').events.click();
  assert.equal(calls[1].ifMatch, '"content:hist-restore:3"', 'no hidden baseline upgrade');
  assert.equal(calls[1].id, calls[0].id, 'the original intent is retained');
});

test('unchanged restore stays visible as confirmed without reloading or retaining pending', async () => {
  const dom = buildDom2();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
  let reloads = 0;
  const globals = restoreGlobals(dom, {
    sessionTag: 'session-A', reload: () => { reloads += 1; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, changed: false, page: { currentRevision: '3' } }) })
  });
  runHistoryScript(globals);
  dom.element('history-table').events.click({ target: { closest: () => ({ getAttribute: n => n === 'data-history-action' ? 'restore' : '3' }) } });
  await dom.element('restore-confirm').events.click();
  assert.equal(reloads, 0);
  assert.match(dom.element('restore-status').textContent, /未产生新版本.*已确认完成/);
  assert.equal(globals.window.QuickSharePublishingRequest.readDashboardIntent('restore', 'hist-restore'), null);
});

for (const status of [401, 403, 409, 410, 428, 500, 503, 200]) {
  test(`restore retains original intent after ${status} refusal or unreadable success`, async () => {
    const dom = buildDom2();
    dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA_33);
    const calls = [];
    const globals = restoreGlobals(dom, {
      sessionTag: 'session-A',
      fetch: async (url, options) => {
        calls.push(options);
        return { ok: status === 200, status, json: async () => {
          if (status === 200) throw new SyntaxError('truncated JSON');
          return { success: false, error: 'refused' };
        } };
      }
    });
    runHistoryScript(globals);
    dom.element('history-table').events.click({ target: { closest: () => ({ getAttribute: n => n === 'data-history-action' ? 'restore' : '1' }) } });
    await dom.element('restore-confirm').events.click();
    const pending = globals.window.QuickSharePublishingRequest.readDashboardIntent('restore', 'hist-restore');
    assert.ok(pending, 'not cleared without a confirmed result');
    assert.equal(pending.sessionTag, 'session-A', 'real window.document binding is exercised');
    assert.equal(calls.length, 1, 'no automatic retry');
    await dom.element('restore-confirm').events.click();
    assert.equal(calls[1].headers['Idempotency-Key'], calls[0].headers['Idempotency-Key']);
    assert.equal(calls[1].headers['If-Match'], calls[0].headers['If-Match']);
  });
}
