// #36 — Dashboard grant/revoke UI: the admin-apis page renders REAL
// read-grant controls per key, the client script wires toggle/grant/revoke
// over Cookie+CSRF, and no dead update/publish switches exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue36-ui-legacy-key';
process.env.SESSION_SECRET = 'issue36-grants-ui-secret';

const app = require('../app');

const SCRIPT_SOURCE = fs.readFileSync(require.resolve('../public/js/admin-apis.js'), 'utf8');

let server;
let origin;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise(resolve => server.close(resolve)));

// ---- Minimal DOM shim (repo convention: no jsdom dependency) ----
const CSS_ESCAPE = value => String(value).replace(/([^A-Za-z0-9_-])/g, '\\$1');

function datasetKeyToAttr(key) {
  return `data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

function createElement(tagName) {
  const node = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    type: '',
    htmlFor: '',
    dataset: {},
    attrs: {},
    events: {},
    focused: false,
    classList: {
      add(...names) { for (const name of names) node.classes.add(name); },
      remove(...names) { for (const name of names) node.classes.delete(name); },
      toggle(name, force) {
        const target = force === undefined ? !node.classes.has(name) : force;
        if (target) node.classes.add(name); else node.classes.delete(name);
      },
      contains: name => node.classes.has(name)
    },
    classes: new Set(),
    appendChild(child) { node.children.push(child); child.parentNode = node; return child; },
    prepend(...kids) { node.children.unshift(...kids); kids.forEach(kid => { kid.parentNode = node; }); },
    append(...kids) { node.children.push(...kids); kids.forEach(kid => { kid.parentNode = node; }); },
    remove() {
      if (node.parentNode) {
        const index = node.parentNode.children.indexOf(node);
        if (index >= 0) node.parentNode.children.splice(index, 1);
      }
      node.removed = true;
    },
    setAttribute(name, value) {
      node.attrs[name] = String(value);
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        node.dataset[camel] = String(value);
      }
    },
    getAttribute: name => (name in node.attrs ? node.attrs[name] : null),
    focus() { node.focused = true; },
    addEventListener(name, handler) { node.events[name] = handler; },
    querySelector(selector) {
      let found = null;
      const visit = (child) => {
        if (found) return;
        if (matchesSelector(child, selector)) { found = child; return; }
        for (const grand of child.children) visit(grand);
      };
      for (const child of node.children) visit(child);
      return found;
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = (child) => {
        if (matchesSelector(child, selector)) results.push(child);
        for (const grand of child.children) visit(grand);
      };
      for (const child of node.children) visit(child);
      return results;
    },
    matches(selector) {
      const source = selector.trim();
      if (source.startsWith('#')) return node.id === source.slice(1);
      return matchSimple(node, source);
    },
    closest(selector) {
      let current = node;
      while (current) {
        if (current.matches && current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    walk(visit) {
      visit(node);
      for (const child of node.children) child.walk(visit);
    }
  };
  if (node.tagName === 'INPUT') node.classes.add('cyber-input');
  return node;
}

function attrValue(node, name) {
  if (name in node.attrs) return node.attrs[name];
  if (name.startsWith('data-')) {
    const camel = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return node.dataset[camel];
  }
  return undefined;
}

function matchSimple(node, source) {
  let rest = source;
  const tagMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagMatch) {
    if (node.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }
  let matched = tagMatch !== null;
  for (const [, name, expected] of [...rest.matchAll(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g)]) {
    matched = true;
    const actual = attrValue(node, name);
    if (expected === undefined) { if (actual === undefined) return false; }
    else if (String(actual) !== expected) return false;
  }
  for (const [, name] of [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)]) {
    matched = true;
    if (!node.classes.has(name) && node.className.split(/\s+/).indexOf(name) < 0) return false;
  }
  return matched;
}

function matchesSelector(node, selector) {
  const source = selector.trim();
  if (source.startsWith('#')) return node.id === source.slice(1);
  return matchSimple(node, source);
}

function makeDom({ keyRowsChildren = [], csrf = 'ui-csrf-token' } = {}) {
  const byId = new Map();
  function elementWithId(id) {
    if (!byId.has(id)) {
      const node = createElement('div');
      node.id = id;
      byId.set(id, node);
    }
    return byId.get(id);
  }

  const form = elementWithId('api-key-form');
  form.tagName = 'FORM';
  const nameInput = elementWithId('api-key-name');
  nameInput.tagName = 'INPUT';
  const secretPanel = elementWithId('new-api-key-panel');
  const secretValue = elementWithId('new-api-key-value');
  const copyButton = elementWithId('copy-api-key-btn');
  const keyRows = elementWithId('api-keys-body');
  keyRows.children = keyRowsChildren;

  const all = [...byId.values()];

  function rootQuery(selector, results = []) {
    for (const node of all) node.walk(visitNode => matchesSelector(visitNode, selector) && results.push(visitNode));
    return results;
  }

  // Register later-created fixture nodes so getElementById/querySelector can
  // find them (the real DOM has one document; this shim has one `all` list).
  function adopt(node) {
    if (!all.includes(node)) all.push(node);
    for (const child of node.children) adopt(child);
  }

  // Register created nodes so later queries can find them.
  function register(node) {
    if (!all.includes(node)) all.push(node);
    for (const child of node.children) register(child);
  }

  const document = {
    getElementById: id => {
      const existing = all.find(node => node.id === id);
      if (existing) return existing;
      return elementWithId(id);
    },
    querySelector: selector => (selector === 'meta[name="csrf-token"]'
      ? { content: csrf }
      : rootQuery(selector)[0] || null),
    querySelectorAll: selector => {
      // "#api-key-form button, #api-keys-body button" — return every button.
      return rootQuery('button');
    },
    createElement: tagName => {
      const node = createElement(tagName);
      // Script-created nodes join the document so later lookups find them.
      queueMicrotask(() => adopt(node));
      return node;
    }
  };

  const originalCreate = document.createElement;
  const toasts = [];
  const fetchCalls = [];
  let queue = Promise.resolve();

  return {
    document,
    byId,
    register,
    toasts,
    fetchCalls,
    confirmMessage: null,
    set nextResponse(value) { queue = Promise.resolve(value); },
    run() {
      const context = {
        document,
        window: {
          Toast: {
            success: message => toasts.push(['success', message]),
            error: message => toasts.push(['error', message]),
            info: message => toasts.push(['info', message])
          },
          AdminTime: { format: () => '' },
          confirm: message => { context.confirmMessage = message; return true; }
        },
        Toast: null,
        fetch: async (url, options = {}) => {
          fetchCalls.push({ url, options });
          const response = await queue;
          return response;
        },
        CSS: { escape: CSS_ESCAPE },
        console,
        alert: message => toasts.push(['alert', message])
      };
      vm.runInNewContext(SCRIPT_SOURCE, context);
      return context;
    }
  };
}

function buttonLike({ className, dataset = {}, label }) {
  const node = createElement('button');
  node.tagName = 'BUTTON';
  node.type = 'button';
  for (const classNamePart of className.split(/\s+/)) node.classes.add(classNamePart);
  Object.assign(node.dataset, dataset);
  node.setAttribute('aria-label', label);
  node.textContent = label;
  return node;
}

async function seedKey(name) {
  const created = await fetch(`${origin}/admin/apis/keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  }).then(response => response.json());
  assert.equal(created.success, true);
  return created.apiKey;
}

async function seedShare(title) {
  const created = await fetch(`${origin}/api/v1/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SHARE_API_KEY },
    body: JSON.stringify({ htmlContent: `<h1>${title}</h1>`, title })
  }).then(response => response.json());
  assert.equal(created.success, true);
  return created.urlId;
}

test('served page renders per-key grant controls and scope badges; no dead update/publish switches', async () => {
  const key = await seedKey('UI render key');
  const shareId = await seedShare('UI Render Share');
  await fetch(`${origin}/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId })
  });

  const page = await fetch(`${origin}/admin/apis`).then(response => response.text());
  assert.match(page, /data-read-grant-count="[^"]+"/);
  assert.match(page, /api-key-grants-btn/);
  assert.match(page, /aria-controls="grants-[^"]+"/);
  assert.match(page, /aria-expanded="false"/);
  assert.match(page, /data-grants-panel="[^"]+"/);
  assert.match(page, /data-grant-item="[^"]+"/, 'existing grants render as items');
  assert.match(page, /撤回/);
  assert.match(page, /data-grant-form="[^"]+"/);
  assert.match(page, /api-key-scope">share:create</, 'scope badges render');
  assert.match(page, /授予读取/);
  // No dead toggles: the page never renders update/publish scope switches.
  assert.doesNotMatch(page, /share:update/);
  assert.doesNotMatch(page, /share:publish/);
  // Secrets never render.
  assert.doesNotMatch(page, new RegExp(key.secret));

  const script = await fetch(`${origin}/js/admin-apis.js`).then(response => response.text());
  assert.match(script, /api-key-grants-btn/);
  assert.match(script, /\/grants/);
});

test('toggle opens the panel; grant and revoke round-trip over CSRF with honest feedback', async () => {
  const key = await seedKey('UI flow key');
  const shareId = await seedShare('UI Flow Share');

  const keyRow = createElement('tr');
  const grantsRow = createElement('tr');
  grantsRow.id = `grants-${key.id}`;
  grantsRow.hidden = true;
  const panel = createElement('div');
  panel.setAttribute('data-grants-panel', key.id);
  const list = createElement('ul');
  list.setAttribute('data-grant-list', key.id);
  panel.appendChild(list);
  const counter = createElement('span');
  counter.setAttribute('data-read-grant-count', key.id);
  counter.textContent = '0';
  const scopeList = createElement('div');
  scopeList.setAttribute('data-api-key-scopes', key.id);
  const createBadge = createElement('code');
  createBadge.textContent = 'share:create';
  scopeList.appendChild(createBadge);
  const toggle = buttonLike({
    className: 'admin-icon-link api-key-grants-btn',
    dataset: { apiKeyId: key.id },
    label: '读取授权'
  });
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `grants-${key.id}`);
  const keyRowCell = createElement('td');
  keyRowCell.appendChild(counter);
  keyRowCell.appendChild(scopeList);
  const actionCell = createElement('td');
  actionCell.appendChild(toggle);
  keyRow.appendChild(keyRowCell);
  keyRow.appendChild(actionCell);
  const panelCell = createElement('td');
  panelCell.appendChild(panel);
  grantsRow.appendChild(panelCell);
  const grantForm = createElement('form');
  grantForm.setAttribute('data-grant-form', key.id);
  const shareInput = createElement('input');
  shareInput.tagName = 'INPUT';
  shareInput.setAttribute('name', 'shareId');
  const submit = buttonLike({ className: 'cyber-btn', dataset: {}, label: '授予读取' });
  shareInput.appendChild; // inputs have no children
  grantForm.appendChild(shareInput);
  grantForm.appendChild(submit);
  panel.appendChild(grantForm);

  const harness = makeDom({ keyRowsChildren: [keyRow, grantsRow] });
  harness.register(keyRow); harness.register(grantsRow);
  harness.nextResponse = { ok: true, status: 201, json: async () => ({ success: true, changed: true, grant: { apiKeyId: key.id, shareId, canRead: true }, scopes: ['share:create', 'share:read'] }) };
  const context = harness.run();

  // 1. Toggle opens the panel and moves focus to the input.
  await keyRowsClick(harness, toggle);
  await settle(() => toggle.getAttribute('aria-expanded') === 'true', 'panel toggled');
  assert.equal(grantsRow.hidden, false, 'panel visible after toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(shareInput.focused, true, 'focus moves to the Share ID input');

  // 2. Grant: POST with CSRF, item appended, count bumped, success toast.
  shareInput.value = shareId;
  await keyRowsSubmit(harness, grantForm);
  await settle(() => harness.toasts.length >= 1, 'grant toast');
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, `/admin/apis/keys/${key.id}/grants`);
  assert.equal(harness.fetchCalls[0].options.headers['X-CSRF-Token'], 'ui-csrf-token');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), { shareId });
  assert.ok(list.children.some(item => item.matches(`[data-grant-item="${CSS_ESCAPE(shareId)}"]`)), 'grant item rendered');
  assert.equal(counter.textContent, '1', 'counter bumped');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create', 'share:read'], 'scope badges reflect grant');
  assert.deepEqual(harness.toasts[0], ['success', '已授予读取授权']);
  assert.equal(shareInput.value, '', 'input cleared after grant');

  // 3. Duplicate grant: honest "already present" info, no new item.
  harness.nextResponse = { ok: true, status: 200, json: async () => ({ success: true, changed: false }) };
  shareInput.value = shareId;
  await keyRowsSubmit(harness, grantForm);
  await settle(() => harness.toasts.length >= 2, 'duplicate toast');
  assert.deepEqual(harness.toasts[1], ['info', '该 Share 已在授权列表中，未重复添加']);
  assert.equal(counter.textContent, '1', 'counter unchanged on duplicate');

  // 4. Revoke via the item button: DELETE, item removed, count restored.
  const item = list.children.find(node => node.matches(`[data-grant-item="${CSS_ESCAPE(shareId)}"]`));
  const revokeButton = buttonLike({
    className: 'admin-delete-btn api-key-revoke-btn',
    dataset: { apiKeyId: key.id, shareId },
    label: '撤回'
  });
  item.appendChild(revokeButton);
  harness.nextResponse = { ok: true, status: 200, json: async () => ({ success: true, changed: true, scopes: ['share:create'] }) };
  await keyRowsClick(harness, revokeButton);
  await settle(() => harness.toasts.length >= 3, 'revoke toast');
  assert.equal(harness.fetchCalls[2].url, `/admin/apis/keys/${key.id}/grants/${shareId}`);
  assert.equal(harness.fetchCalls[2].options.method, 'DELETE');
  assert.equal(counter.textContent, '0', 'counter decremented');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create'], 'stale read badge removed after last revoke');
  assert.ok(!list.children.some(node => node.matches(`[data-grant-item="${CSS_ESCAPE(shareId)}"]`)), 'item removed');
  assert.ok(list.children.some(node => node.matches('[data-grant-empty]')), 'empty state restored');
  assert.deepEqual(harness.toasts[2], ['success', '已撤回读取授权']);

  // 5. Failure path surfaces the server error without mutating the panel.
  harness.nextResponse = { ok: false, status: 404, json: async () => ({ success: false, error: 'Share 不存在或没有对它的授权' }) };
  shareInput.value = 'no-such-share0';
  await keyRowsSubmit(harness, grantForm);
  await settle(() => harness.toasts.length >= 4, 'failure toast');
  assert.deepEqual(harness.toasts[3], ['error', 'Share 不存在或没有对它的授权']);
  assert.equal(counter.textContent, '0');
});

async function keyRowsClick(harness, button) {
  const keyRows = harness.byId.get('api-keys-body');
  await keyRows.events.click({ target: button });
}

async function keyRowsSubmit(harness, formNode) {
  const keyRows = harness.byId.get('api-keys-body');
  await keyRows.events.submit({ target: formNode, preventDefault() {} });
}

/**
 * The client script runs inside a vm context whose microtask queue drains on
 * its own schedule. After dispatching an event, poll a host-visible
 * condition until the guest work settles (bounded, fail loudly).
 */
async function settle(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(check(), `did not settle: ${label}`);
}

test('creation flow builds a matching row: scope badges, zero count, toggle and empty panel', async () => {
  const harness = makeDom({});
  harness.nextResponse = {
    ok: true, status: 201,
    json: async () => ({ success: true, apiKey: { id: 'brand-new-key1', name: 'Fresh', key_prefix: 'qs.brand-…', created_at: Date.now(), last_used_at: null, credential_version: '1', scopes: ['share:create'], secret: 'qs.brand-new-key1.secret-value' } })
  };
  const context = harness.run();
  const form = harness.byId.get('api-key-form');
  const nameInput = harness.byId.get('api-key-name');
  const keyRows = harness.byId.get('api-keys-body');
  nameInput.value = 'Fresh';
  await form.events.submit({ preventDefault() {} });
  await settle(() => harness.byId.get('new-api-key-value').textContent !== '', 'creation settled');

  const newRow = keyRows.children[0];
  assert.ok(newRow, 'key row inserted');
  const badges = [];
  newRow.walk(node => node.matches('.api-key-scope') && badges.push(node.textContent));
  assert.deepEqual(badges, ['share:create'], 'fresh key renders its create-only scope');
  const counters = [];
  newRow.walk(node => node.matches('[data-read-grant-count]') && counters.push(node));
  assert.equal(counters[0].textContent, '0');
  const toggles = [];
  newRow.walk(node => node.matches('.api-key-grants-btn') && toggles.push(node));
  assert.equal(toggles.length, 1, 'grant toggle present');
  // The grants panel row directly follows the key row.
  const panelRow = keyRows.children[1];
  assert.equal(panelRow.hidden, true);
  assert.ok(panelRow.walk.length >= 0);
  const panels = [];
  panelRow.walk(node => node.matches(`[data-grants-panel="${CSS_ESCAPE('brand-new-key1')}"]`) && panels.push(node));
  assert.equal(panels.length, 1, 'panel registered for the new key');
  assert.equal(harness.byId.get('new-api-key-value').textContent, 'qs.brand-new-key1.secret-value', 'secret shown once');
});
