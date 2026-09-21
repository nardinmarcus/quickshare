const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/admin-detail.js'), 'utf8');

function fixture(response) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, checked: false, dataset: {}, events: {}, attrs: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name]; },
      removeAttribute(name) { delete this.attrs[name]; }, focus() {}
    });
    return elements.get(id);
  }
  const original = { id: 'ui-share', title: 'Original', htmlContent: 'original body', isProtected: true, accessRevision: '7', currentRevision: '3', expiresAt: Date.now() + 86400000, markdownTheme: 'github' };
  element('page-data').textContent = JSON.stringify(original);
  // The textarea renders the ORIGINAL body; user edits happen after load,
  // matching the real page's capture-then-edit sequence.
  element('content-textarea').value = 'original body';
  element('edit-title').value = 'UNSAVED TITLE';
  element('edit-protected').checked = true;
  element('edit-theme').value = 'github';
  element('edit-expires').value = '2030-01-01T12:34';
  const calls = [];
  const errors = [];
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ textContent: '', innerHTML: '' }) },
    window: {
      AdminTime: { toDateTimeLocal: () => '2030-01-01T12:34', parseDateTimeLocal: () => original.expiresAt - 12345, format: () => '' },
      SourceDiff: { renderMetaChanges() {}, renderParts() {}, compare: async () => ({ status: 'ok', parts: [] }) }
    },
    Toast: { error: value => errors.push(value), success() {} },
    fetch: async (url, options) => { calls.push({ url, headers: options.headers, ...options, body: JSON.parse(options.body) }); return response; },
    console, Date
  });
  return { element, calls, errors, original };
}

test('failed owner save retains draft and displayed access baseline across repeated attempts', async () => {
  const f = fixture({ ok: false, json: async () => ({ success: false, error: '访问设置已更改，请刷新' }) });
  await f.element('edit-toggle-btn').events.click();
  assert.equal(f.element('revoke-access-btn').disabled, true);
  f.element('edit-title').value = 'UNSAVED TITLE';
  f.element('edit-description').value = 'UNSAVED DESCRIPTION';
  f.element('content-textarea').value = 'UNSAVED BODY';
  for (let i = 0; i < 2; i += 1) {
    f.element('edit-save-access').events.click();
    await f.element('edit-form').events.submit({ preventDefault() {} });
  }
  assert.deepEqual(f.calls.map(call => call.body.expectedAccessRevision), ['7', '7']);
  assert.equal(f.element('content-textarea').value, 'UNSAVED BODY');
  assert.equal(f.element('edit-title').value, 'UNSAVED TITLE');
  assert.equal(f.element('edit-form').hidden, false);
  assert.equal(f.element('edit-save-access').disabled, false);
  assert.equal(f.element('edit-save-content').disabled, false);
  assert.equal(f.calls.length, 2, 'no automatic refresh or retry');
});

test('content and access saves are separate: content sends If-Match, access sends the exact expiry', async () => {
  const f = fixture({ ok: false, json: async () => ({ success: false, error: 'fixture failure' }) });
  // Content save with an ACTUAL body edit: If-Match plus the edited value.
  f.element('edit-title').value = 'UNSAVED TITLE';
  f.element('content-textarea').value = 'UNSAVED BODY';
  await f.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(f.calls[0].headers['If-Match'], '"content:ui-share:3"');
  assert.equal(f.calls[0].body.htmlContent, 'UNSAVED BODY', 'an actual edit transmits the edited value');
  assert.equal(f.calls[0].body.expiresAt, undefined, 'content saves never carry access fields');
  assert.equal(f.calls[0].body.expectedAccessRevision, undefined);
  // Access save: untouched datetime-local keeps the stored instant exactly.
  f.element('edit-save-access').events.click();
  await f.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(f.calls[1].body.expiresAt, f.original.expiresAt);
  assert.equal(f.calls[1].body.htmlContent, undefined, 'access saves never carry content fields');
  assert.equal(f.calls[1].headers['If-Match'], undefined);
  // A metadata-only content save (title edit, body untouched) sends the RAW
  // original body bytes — never the LF-normalized textarea rendering.
  const second = fixture({ ok: false, json: async () => ({ success: false, error: 'fixture failure' }) });
  second.element('edit-title').value = 'Renamed only';
  await second.element('edit-form').events.submit({ preventDefault() {} });
  assert.equal(second.calls[0].body.htmlContent, 'original body', 'untouched body transmits the raw original');
  assert.equal(second.calls[0].body.title, 'Renamed only');
});

test('explicit revoke submits displayed baseline and does not advance it on failure', async () => {
  const f = fixture({ ok: false, json: async () => ({ success: false, error: '访问设置已更改，请刷新' }) });
  await f.element('revoke-access-btn').events.click();
  await f.element('revoke-access-btn').events.click();
  assert.deepEqual(f.calls.map(call => call.body), [
    { revokeAccess: true, expectedAccessRevision: '7' },
    { revokeAccess: true, expectedAccessRevision: '7' }
  ]);
  assert.equal(f.element('revoke-access-btn').disabled, false);
  assert.match(f.element('access-action-status').textContent, /请刷新/);
});
