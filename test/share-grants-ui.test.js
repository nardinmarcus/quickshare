// #37 — Dashboard grant/revoke UI: per-Share read/edit grants and future
// auto-edit are real controls wired over Cookie+CSRF.
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
    },
    createTextNode: text => {
      const node = createElement('span');
      node.tagName = '#TEXT';
      node.textContent = String(text);
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

test('served page renders separate read/edit/publish controls and truthful publish-only rows', async () => {
  const key = await seedKey('UI render key');
  const shareId = await seedShare('UI Render Share');
  const publishOnlyKey = await seedKey('UI publish-only render key');
  const publishOnlyShareId = await seedShare('UI Publish Only Share');
  await fetch(`${origin}/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId })
  });
  const publishOnlyGrant = await fetch(`${origin}/admin/apis/keys/${publishOnlyKey.id}/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId: publishOnlyShareId, canPublish: true })
  });
  assert.equal(publishOnlyGrant.status, 201);

  const page = await fetch(`${origin}/admin/apis`).then(response => response.text());
  assert.match(page, /data-read-grant-count="[^"]+"/);
  assert.match(page, /api-key-grants-btn/);
  assert.match(page, /aria-controls="grants-[^"]+"/);
  assert.match(page, /aria-expanded="false"/);
  assert.match(page, /data-grants-panel="[^"]+"/);
  assert.match(page, /data-grant-item="[^"]+"/, 'existing grants render as items');
  assert.match(page, /撤回读取授权/);
  assert.match(page, /api-key-edit-grant-btn/);
  assert.match(page, /data-can-update="false"/);
  assert.match(page, /api-key-publish-grant-btn/);
  assert.match(page, /data-can-publish="true"/);
  assert.match(page, /仅可上下架/, 'publish-only row names its real access level');
  assert.match(page, /data-auto-grant-edit="[^"]+"/);
  assert.match(page, /data-grant-form="[^"]+"/);
  assert.match(page, /api-key-scope">share:create</, 'scope badges render');
  assert.match(page, /授予授权/);
  assert.match(page, /share:update/);
  assert.match(page, /share:publish/, 'publish scope is rendered from the active server capability');
  // Secrets never render.
  assert.doesNotMatch(page, new RegExp(key.secret));

  const script = await fetch(`${origin}/js/admin-apis.js`).then(response => response.text());
  assert.match(script, /api-key-grants-btn/);
  assert.match(script, /\/grants/);

  const editGranted = await fetch(`${origin}/admin/apis/keys/${key.id}/grants/${shareId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canUpdate: true })
  });
  assert.equal(editGranted.status, 200);
  const editPage = await fetch(`${origin}/admin/apis`).then(response => response.text());
  assert.match(editPage, /disabled title=.*请先撤销编辑权，再撤回读取授权/);
  assert.match(editPage, /先撤销编辑权/);
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
  const readInput = createElement('input');
  readInput.setAttribute('name', 'canRead');
  readInput.type = 'checkbox';
  readInput.checked = true;
  const editInput = createElement('input');
  editInput.setAttribute('name', 'canUpdate');
  editInput.type = 'checkbox';
  const publishInput = createElement('input');
  publishInput.setAttribute('name', 'canPublish');
  publishInput.type = 'checkbox';
  const submit = buttonLike({ className: 'cyber-btn', dataset: {}, label: '授予读取' });
  grantForm.appendChild(shareInput);
  grantForm.append(readInput, editInput, publishInput, submit);
  panel.appendChild(grantForm);

  const harness = makeDom({ keyRowsChildren: [keyRow, grantsRow] });
  harness.register(keyRow); harness.register(grantsRow);
  harness.nextResponse = { ok: true, status: 201, json: async () => ({ success: true, changed: true, grant: { apiKeyId: key.id, shareId, canRead: true, canUpdate: false, canPublish: false }, scopes: ['share:create', 'share:read'] }) };
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
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), { shareId, canRead: true, canUpdate: false, canPublish: false });
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
  assert.deepEqual(harness.toasts[1], ['info', '该 Share 已具有所选授权，未重复添加']);
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

test('edit grant and auto-edit controls send real CSRF-protected requests and preserve UI state on errors', async () => {
  const keyId = 'ui-edit-key01';
  const shareId = 'ui-edit-share01';
  const keyRow = createElement('tr');
  const panelRow = createElement('tr');
  panelRow.id = `grants-${keyId}`;
  panelRow.hidden = false;
  const panel = createElement('div');
  panel.setAttribute('data-grants-panel', keyId);
  const list = createElement('ul');
  list.setAttribute('data-grant-list', keyId);
  panel.appendChild(list);
  const autoToggle = createElement('input');
  autoToggle.type = 'checkbox';
  autoToggle.className = 'api-key-auto-edit-toggle';
  autoToggle.dataset.autoGrantEdit = keyId;
  autoToggle.checked = false;
  panel.appendChild(autoToggle);
  const form = createElement('form');
  form.setAttribute('data-grant-form', keyId);
  const shareInput = createElement('input');
  shareInput.setAttribute('name', 'shareId');
  shareInput.value = shareId;
  const readInput = createElement('input');
  readInput.setAttribute('name', 'canRead');
  readInput.type = 'checkbox';
  readInput.checked = true;
  const editInput = createElement('input');
  editInput.setAttribute('name', 'canUpdate');
  editInput.type = 'checkbox';
  editInput.checked = true;
  const publishInput = createElement('input');
  publishInput.setAttribute('name', 'canPublish');
  publishInput.type = 'checkbox';
  form.append(shareInput, readInput, editInput, publishInput);
  panel.appendChild(form);
  const panelCell = createElement('td');
  panelCell.appendChild(panel);
  panelRow.appendChild(panelCell);
  const counter = createElement('span');
  counter.setAttribute('data-read-grant-count', keyId);
  counter.textContent = '0';
  const scopeList = createElement('div');
  scopeList.setAttribute('data-api-key-scopes', keyId);
  keyRow.append(counter, scopeList);

  const harness = makeDom({ keyRowsChildren: [keyRow, panelRow] });
  harness.register(keyRow); harness.register(panelRow);
  harness.nextResponse = { ok: true, status: 201, json: async () => ({
    success: true, changed: true,
    grant: { apiKeyId: keyId, shareId, canRead: true, canUpdate: true },
    scopes: ['share:create', 'share:read', 'share:update']
  }) };
  harness.run();

  await keyRowsSubmit(harness, form);
  await settle(() => counter.textContent === '1', 'edit grant request');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), { shareId, canRead: true, canUpdate: true, canPublish: false });
  assert.equal(harness.fetchCalls[0].options.headers['X-CSRF-Token'], 'ui-csrf-token');
  const item = list.children.find(node => node.matches(`[data-grant-item="${CSS_ESCAPE(shareId)}"]`));
  assert.ok(item);
  const editButton = item.querySelector('.api-key-edit-grant-btn');
  const revokeButton = item.querySelector('.api-key-revoke-btn');
  assert.equal(editButton.dataset.canUpdate, 'true');
  assert.equal(revokeButton.disabled, true, 'read revocation waits until dependent edit grant is removed');
  assert.equal(revokeButton.textContent, '先撤销编辑权');
  assert.equal(counter.textContent, '1');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create', 'share:read', 'share:update']);

  harness.nextResponse = { ok: true, status: 200, json: async () => ({
    success: true, changed: true,
    grant: { apiKeyId: keyId, shareId, canRead: true, canUpdate: false },
    scopes: ['share:create', 'share:read']
  }) };
  await keyRowsClick(harness, revokeButton);
  await settle(() => harness.fetchCalls.length === 1, 'dependent read revoke is blocked without a request');
  assert.equal(revokeButton.disabled, true, 'client refuses to send a read revoke while edit depends on it');

  await keyRowsClick(harness, editButton);
  await settle(() => editButton.dataset.canUpdate === 'false', 'edit downgrade request');
  assert.equal(revokeButton.disabled, false, 'read revoke becomes available after edit is removed');
  assert.equal(revokeButton.textContent, '撤回读取授权');
  assert.equal(harness.fetchCalls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(harness.fetchCalls[1].options.body), { canUpdate: false });
  assert.equal(editButton.dataset.canUpdate, 'false');
  assert.equal(editButton.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create', 'share:read']);

  harness.nextResponse = { ok: true, status: 200, json: async () => ({ success: true, changed: true, autoGrantNewShareEdit: true }) };
  autoToggle.checked = true;
  await harness.byId.get('api-keys-body').events.change({ target: autoToggle });
  await settle(() => harness.toasts.some(([, message]) => message.includes('启用自动编辑授权')), 'auto-grant enable request');
  assert.equal(harness.fetchCalls[2].options.method, 'PUT');
  assert.deepEqual(JSON.parse(harness.fetchCalls[2].options.body), { enabled: true });
  assert.equal(autoToggle.checked, true);

  harness.nextResponse = { ok: false, status: 503, json: async () => ({ success: false, error: '暂时不可用' }) };
  autoToggle.checked = false;
  await harness.byId.get('api-keys-body').events.change({ target: autoToggle });
  await settle(() => harness.toasts.some(([type, message]) => type === 'error' && message === '暂时不可用'), 'auto-grant failure');
  assert.equal(autoToggle.checked, true, 'failed request restores the visible previous state');
  assert.deepEqual(harness.toasts[harness.toasts.length - 1], ['error', '暂时不可用']);
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

test('publish toggle preserves read access and labels the effective combined grant', async () => {
  const keyId = 'ui-publish-key01';
  const shareId = 'ui-publish-share01';
  const keyRow = createElement('tr');
  const panelRow = createElement('tr');
  panelRow.id = `grants-${keyId}`;
  panelRow.hidden = false;
  const panel = createElement('div');
  panel.setAttribute('data-grants-panel', keyId);
  const list = createElement('ul');
  list.setAttribute('data-grant-list', keyId);
  const existingItem = createElement('li');
  existingItem.setAttribute('data-grant-item', shareId);
  list.appendChild(existingItem);
  panel.appendChild(list);
  const form = createElement('form');
  form.setAttribute('data-grant-form', keyId);
  const shareInput = createElement('input');
  shareInput.setAttribute('name', 'shareId');
  shareInput.value = shareId;
  const readInput = createElement('input');
  readInput.setAttribute('name', 'canRead');
  readInput.type = 'checkbox';
  readInput.checked = false;
  const editInput = createElement('input');
  editInput.setAttribute('name', 'canUpdate');
  editInput.type = 'checkbox';
  const publishInput = createElement('input');
  publishInput.setAttribute('name', 'canPublish');
  publishInput.type = 'checkbox';
  publishInput.checked = true;
  form.append(shareInput, readInput, editInput, publishInput);
  panel.appendChild(form);
  const panelCell = createElement('td');
  panelCell.appendChild(panel);
  panelRow.appendChild(panelCell);
  const counter = createElement('span');
  counter.setAttribute('data-read-grant-count', keyId);
  counter.textContent = '1';
  const scopeList = createElement('div');
  scopeList.setAttribute('data-api-key-scopes', keyId);
  keyRow.append(counter, scopeList);

  const harness = makeDom({ keyRowsChildren: [keyRow, panelRow] });
  harness.register(keyRow); harness.register(panelRow);
  harness.nextResponse = { ok: true, status: 201, json: async () => ({
    success: true, changed: true,
    grant: { apiKeyId: keyId, shareId, canRead: true, canUpdate: false, canPublish: true },
    scopes: ['share:create', 'share:read', 'share:publish']
  }) };
  harness.run();

  await keyRowsSubmit(harness, form);
  await settle(() => harness.toasts.length === 1, 'publish permission added to an existing read grant');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), { shareId, canRead: false, canUpdate: false, canPublish: true });
  assert.equal(harness.toasts[0][1], '已分别授予读取与上下架权', 'feedback reports the merged server grant, not just the submitted checkbox');
  assert.equal(counter.textContent, '1', 'adding an independent permission does not add a duplicate Share row');
  let item = list.children[0];
  assert.equal(item.querySelector('[data-grant-access]').textContent, '读取 + 上下架');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create', 'share:read', 'share:publish']);

  const publishButton = item.querySelector('.api-key-publish-grant-btn');
  harness.nextResponse = { ok: true, status: 200, json: async () => ({
    success: true, changed: true,
    grant: { apiKeyId: keyId, shareId, canRead: true, canUpdate: false, canPublish: false },
    scopes: ['share:create', 'share:read']
  }) };
  await keyRowsClick(harness, publishButton);
  await settle(() => publishButton.dataset.canPublish === 'false', 'publish permission revoked independently');
  assert.equal(harness.fetchCalls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(harness.fetchCalls[1].options.body), { canPublish: false });
  item = list.children[0];
  assert.equal(item.querySelector('[data-grant-access]').textContent, '仅读取');
  assert.equal(counter.textContent, '1', 'revoking publish preserves the read grant row');
  assert.deepEqual(scopeList.children.map(node => node.textContent), ['share:create', 'share:read']);
  assert.deepEqual(harness.toasts[1], ['success', '已撤销上下架权；其他读取/编辑授权保持不变']);
});

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
  await settle(() => harness.byId.get('new-api-key-value').textContent !== '' && keyRows.children.length > 0, 'creation settled');

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
