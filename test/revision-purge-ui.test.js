// #34 purge client behavior under VM (no browser): the confirm dialog's
// explicit-confirmation gating, pointer AND keyboard operation, busy-state
// protection, honest copy for fresh vs repeated purges, refusal handling and
// the purged-row/compare 410 states. Runs the real public/js/admin-history.js
// in a sandboxed context against a minimal DOM double.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const HISTORY_DATA = {
  id: 'hist-purge',
  codeType: 'html',
  currentRevision: '2',
  revisions: [
    { revision: '2', createdAt: 2, source: 'dashboard-edit', restoredFrom: null },
    { revision: '1', createdAt: 1, source: 'api', restoredFrom: null }
  ],
  pagination: { page: 1, limit: 20, total: '2', totalPages: 1, hasNext: false, hasPrevious: false }
};

function buildDom() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const node = {
        id, _value: '', _ownText: undefined, hidden: false, disabled: false,
        dataset: {}, events: {}, attrs: {}, children: [],
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

function purgeGlobals(dom, overrides = {}) {
  const toasts = { success: [], error: [] };
  const globals = {
    document: {
      documentElement: { dataset: overrides.sessionTag ? { dashboardSessionTag: overrides.sessionTag } : {} },
      getElementById: dom.element,
      querySelector: (selector) => (selector === 'meta[name="csrf-token"]' ? { getAttribute: () => 'csrf-token-34' } : null),
      querySelectorAll: () => [],
      createElement: () => dom.element('created-' + Math.random())
    },
    window: {
      QuickSharePublishingRequest: null,
      AdminTime: { format: v => 'f' + v, toDateTimeLocal: () => '', parseDateTimeLocal: () => 0 },
      SourceDiff: { compare: async () => ({ status: 'ok', parts: [] }), renderParts() {}, renderMetaChanges() {}, cancelRender() {} },
      location: { reload: overrides.reload || (() => {}) },
      sessionStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {}
      }
    },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    Toast: {
      success: (message) => toasts.success.push(message),
      error: (message) => toasts.error.push(message)
    },
    setTimeout, clearTimeout, console, Date, encodeURIComponent
  };
  globals.toasts = toasts;
  return globals;
}

function runHistoryScript(globals) {
  globals.window.document = globals.document;
  vm.runInNewContext(fs.readFileSync('public/js/publishing-request.js', 'utf8'), globals);
  vm.runInNewContext(fs.readFileSync('public/js/admin-history.js', 'utf8'), globals);
}

function clickHistoryAction(dom, action, revision) {
  dom.element('history-table').events.click({
    target: {
      closest: (selector) => (selector === '[data-history-action]'
        ? { getAttribute: (name) => (name === 'data-history-action' ? action : String(revision)) }
        : null)
    }
  });
}

function openPurgeDialog(dom, revision) {
  clickHistoryAction(dom, 'purge', revision);
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('the purge dialog names the exact Share+revision and stays disabled until the typed confirmation matches', async () => {
  const dom = buildDom();
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(purgeGlobals(dom));

  openPurgeDialog(dom, '1');
  const dialog = dom.element('purge-dialog');
  assert.equal(dialog.hidden, false, 'the dialog opens from the row purge action');
  assert.match(dom.element('purge-summary').textContent, /hist-purge/, 'the summary names the exact Share');
  assert.match(dom.element('purge-summary').textContent, /版本 1/, 'the summary names the exact revision');
  assert.equal(dom.element('purge-confirm-expected').textContent, 'hist-purge:1', 'the expected confirmation string is shown');
  assert.equal(dom.element('purge-confirm-input').focused, true, 'focus lands in the confirmation input');
  assert.equal(dom.element('purge-confirm').disabled, true, 'confirm starts disabled');

  dom.element('purge-confirm-input').value = 'hist-purge:9';
  dom.element('purge-confirm-input').events.input();
  assert.equal(dom.element('purge-confirm').disabled, true, 'a wrong confirmation never enables the button');

  dom.element('purge-confirm-input').value = 'hist-purge:1';
  dom.element('purge-confirm-input').events.input();
  assert.equal(dom.element('purge-confirm').disabled, false, 'the exact confirmation enables the button');

  dom.element('purge-cancel').events.click();
  assert.equal(dialog.hidden, true, 'cancel closes the dialog');
  assert.equal(dom.element('purge-confirm-input').value, '', 'cancel clears the typed confirmation');
  assert.equal(dom.element('purge-confirm').disabled, true, 'a reopened dialog starts disabled again');
});

test('Enter submits an exact confirmation and Escape cancels; a mismatched Enter never submits', async () => {
  const dom = buildDom();
  const calls = [];
  let reloaded = false;
  const globals = purgeGlobals(dom, {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, changed: true, alreadyPurged: false, purged: { shareId: 'hist-purge', revision: '1', purgedAt: 1 }, message: '已清除在线保存的该版本内容，只保留不含正文的墓碑；其他版本、离线备份与接收者下载不受影响。' })
      };
    },
    reload: () => { reloaded = true; }
  });
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(globals);

  openPurgeDialog(dom, '1');
  // Mismatched Enter: no request, dialog stays open.
  dom.element('purge-confirm-input').value = 'hist-purge:2';
  dom.element('purge-confirm-input').events.keydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(calls.length, 0, 'Enter with a wrong confirmation submits nothing');

  // Escape cancels the idle dialog and resets the confirmation state.
  dom.element('purge-confirm-input').events.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dom.element('purge-dialog').hidden, true, 'Escape closes the idle dialog');
  assert.equal(dom.element('purge-confirm').disabled, true, 'a reopened dialog starts disabled');

  // Reopen, type the exact confirmation, press Enter: one purge request.
  openPurgeDialog(dom, '1');
  dom.element('purge-confirm-input').value = 'hist-purge:1';
  dom.element('purge-confirm-input').events.input();
  dom.element('purge-confirm-input').events.keydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(calls.length, 1, 'Enter with the exact confirmation submits once');
  assert.equal(calls[0].url, '/admin/pages/hist-purge/revisions/1/purge');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'csrf-token-34', 'the purge carries the session CSRF token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: 'hist-purge:1' }, 'the body confirmation names Share+revision');
  assert.equal(reloaded, true, 'the page reloads for an honest tombstone list');
  assert.deepEqual(globals.toasts.error, [], 'no failure is implied');
  assert.match(globals.toasts.success.join('\n'), /在线/, 'the success copy promises only the online stored version');
});

test('keyboard controls are inert while a purge is in flight; the dialog cannot be dismissed into an unknown state', async () => {
  const dom = buildDom();
  let resolveFetch;
  const calls = [];
  let reloaded = false;
  const globals = purgeGlobals(dom, {
    fetch: (url, options) => {
      calls.push({ url, options });
      return new Promise((resolve) => { resolveFetch = () => resolve({
        ok: true, status: 200,
        json: async () => ({ success: true, changed: true, alreadyPurged: false, purged: { shareId: 'hist-purge', revision: '1', purgedAt: 1 }, message: 'ok' })
      }); });
    },
    reload: () => { reloaded = true; }
  });
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(globals);

  openPurgeDialog(dom, '1');
  dom.element('purge-confirm-input').value = 'hist-purge:1';
  dom.element('purge-confirm-input').events.input();
  // The click handler returns confirmPurge(); do NOT await it while the
  // deferred fetch is pending — capture it and resolve explicitly.
  const inFlight = dom.element('purge-confirm').events.click();
  await flush();
  assert.equal(calls.length, 1, 'the purge request is in flight');

  // Neither Enter nor Escape may act while the request is unresolved.
  dom.element('purge-confirm-input').events.keydown({ key: 'Enter', preventDefault() {} });
  dom.element('purge-confirm-input').events.keydown({ key: 'Escape', preventDefault() {} });
  await flush();
  assert.equal(calls.length, 1, 'no duplicate destructive request');
  assert.equal(dom.element('purge-dialog').hidden, false, 'the busy dialog stays open');
  assert.equal(dom.element('purge-cancel').disabled, true, 'cancel is disabled while busy');

  resolveFetch();
  if (inFlight && typeof inFlight.then === 'function') await inFlight;
  await flush();
  assert.equal(reloaded, true, 'the confirmed outcome reloads once resolved');
});

test('refusals and network loss keep the dialog open with the real reason and never reload', async () => {
  const dom = buildDom();
  const calls = [];
  let reloaded = false;
  let failMode = 'current';
  const globals = purgeGlobals(dom, {
    fetch: async () => {
      calls.push(1);
      if (failMode === 'current') {
        return {
          ok: false, status: 409,
          json: async () => ({ success: false, code: 'CURRENT_REVISION_PURGE_FORBIDDEN', error: '当前版本不能清除：只能清除非当前的历史版本' })
        };
      }
      throw new Error('network gone');
    },
    reload: () => { reloaded = true; }
  });
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(globals);

  openPurgeDialog(dom, '2');
  dom.element('purge-confirm-input').value = 'hist-purge:2';
  dom.element('purge-confirm-input').events.input();
  await dom.element('purge-confirm').events.click();
  await flush();
  assert.equal(dom.element('purge-dialog').hidden, false, 'a refusal keeps the dialog open');
  assert.match(dom.element('purge-status').textContent, /当前版本不能清除/, 'the server reason is shown');
  assert.equal(reloaded, false, 'a refusal never reloads');

  failMode = 'network';
  await dom.element('purge-confirm').events.click();
  await flush();
  assert.equal(calls.length, 2, 'the retry re-posts the same explicit intent');
  assert.equal(dom.element('purge-dialog').hidden, false, 'an unknown outcome keeps the dialog open');
  assert.match(dom.element('purge-status').textContent, /网络失败，清除结果未知/, 'an unknown outcome says so');
  assert.equal(reloaded, false, 'an unknown outcome never reloads');
  assert.deepEqual(globals.toasts.success, [], 'no success is claimed for a refused or unknown purge');
});

test('a repeated purge confirms the tombstone without implying failure; the fresh copy promises only the online version', async () => {
  const dom = buildDom();
  let mode = 'repeat';
  const globals = purgeGlobals(dom, {
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => (mode === 'repeat'
        ? { success: true, changed: false, alreadyPurged: true, purged: { shareId: 'hist-purge', revision: '1', purgedAt: 7 }, message: '该版本此前已清除；本次确认未产生新的清除副作用。在线保存的该版本内容已不可读取。' }
        : { success: true, changed: true, alreadyPurged: false, purged: { shareId: 'hist-purge', revision: '1', purgedAt: 7 }, message: '已清除在线保存的该版本内容，只保留不含正文的墓碑；其他版本、离线备份与接收者下载不受影响。' })
    }),
    reload: () => {}
  });
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(globals);

  openPurgeDialog(dom, '1');
  dom.element('purge-confirm-input').value = 'hist-purge:1';
  dom.element('purge-confirm-input').events.input();
  await dom.element('purge-confirm').events.click();
  await flush();
  assert.equal(globals.toasts.error.length, 0, 'a confirmed tombstone is never reported as a failed purge');
  assert.match(globals.toasts.success.join('\n'), /此前已清除/, 'the repeat copy names the earlier purge');
  assert.match(globals.toasts.success.join('\n'), /未产生新的.*副作用/, 'the repeat promises no new side effects');

  mode = 'fresh';
  openPurgeDialog(dom, '1');
  dom.element('purge-confirm-input').value = 'hist-purge:1';
  dom.element('purge-confirm-input').events.input();
  await dom.element('purge-confirm').events.click();
  await flush();
  assert.equal(globals.toasts.error.length, 0);
  assert.match(globals.toasts.success.join('\n'), /仅保留墓碑/, 'the fresh copy names the tombstone outcome');
});

test('the purged-row info action and a 410 compare target state the tombstone exactly', async () => {
  const dom = buildDom();
  const globals = purgeGlobals(dom, {
    fetch: async (url) => ({
      ok: false, status: 410,
      json: async () => ({ success: false, code: 'REVISION_PURGED', error: '该版本内容已被永久清除，仅保留墓碑' })
    })
  });
  dom.element('history-data').textContent = JSON.stringify(HISTORY_DATA);
  runHistoryScript(globals);

  clickHistoryAction(dom, 'purge-info', '1');
  assert.match(dom.element('compare-status').textContent, /版本 1 的在线内容已清除/, 'the info action names the tombstone');
  assert.match(dom.element('compare-status').textContent, /其他版本与离线备份不受影响/, 'the info copy scopes the promise honestly');

  dom.element('compare-select-a').value = '1';
  dom.element('compare-select-b').value = '2';
  dom.element('compare-run').events.click();
  await flush();
  assert.match(dom.element('compare-status').textContent, /版本 1 的内容已被永久清除，无法比较/, 'a 410 compare target cancels with the purge-specific status');
  assert.doesNotMatch(dom.element('compare-status').textContent, /没有行级差异|无差异/, 'a purged target is never reported as "no diff"');
});
