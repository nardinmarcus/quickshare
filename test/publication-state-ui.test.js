const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue35-publication-ui-secret';

const app = require('../app');
const repository = app.locals.pageRepository;

let server;
let origin;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function get(path) {
  const response = await fetch(origin + path);
  return { status: response.status, text: await response.text() };
}

async function seedShare({ id, published = true, password = null } = {}) {
  const { encryptSecret, hashSecret } = require('../utils/security');
  await repository.create({
    id,
    htmlContent: `<h1>${id} body</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: null,
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
  if (!published) {
    await repository.setPublished(id, { published: false, expectedAccessRevision: '1', returnUpdated: true });
  }
}

test('the list row carries the publication badge, toggle state and access baseline', async () => {
  await seedShare({ id: 'ui-list-pub' });
  await seedShare({ id: 'ui-list-unpub', published: false });

  const list = await get('/admin/pages');
  assert.equal(list.status, 200);
  // Published row: pause action available, not pressed.
  assert.match(list.text, /data-page-id="ui-list-pub"[^>]*data-published="true"/);
  assert.match(list.text, /aria-label="下架分享 ui-list-pub"/);
  // Unpublished row: 已下架 badge, resume action, explicit baseline for the request.
  assert.match(list.text, /admin-unpublished-badge">已下架</);
  assert.match(list.text, /data-page-id="ui-list-unpub"[^>]*data-published="false"[^>]*data-access-revision="2"/);
  assert.match(list.text, /aria-label="重新发布分享 ui-list-unpub"/);
});

test('the detail page renders the publication state with the matching action and hint', async () => {
  await seedShare({ id: 'ui-detail-pub' });
  await seedShare({ id: 'ui-detail-unpub', published: false });

  const published = await get('/admin/pages/ui-detail-pub');
  assert.equal(published.status, 200);
  assert.match(published.text, /发布状态/);
  assert.match(published.text, /id="publish-state-value"[^>]*>已发布/);
  assert.match(published.text, /id="unpublish-btn"/);
  assert.doesNotMatch(published.text, /id="republish-btn"(?! hidden)/);
  assert.match(published.text, /下架或重新发布都会推进访问版本/);
  assert.match(published.text, /id="publish-access-baseline">1</);

  const unpublished = await get('/admin/pages/ui-detail-unpub');
  assert.equal(unpublished.status, 200);
  assert.match(unpublished.text, /id="publish-state-value"[^>]*>已下架/);
  assert.match(unpublished.text, /id="republish-btn"/);
  assert.match(unpublished.text, /id="publish-access-baseline">2</);
});

// ---- Shared response helpers ----

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flushPromises() {
  // The fetch → json → toast chain spans several microtask hops; drain them
  // all before asserting.
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

// ---- admin-detail.js VM behaviour (harness family of
// test/access-revision-ui.test.js) ----

function createDetailHarness({ response, fetchError } = {}) {
  const state = { response, fetchError };
  const storage = new Map();
  const elements = new Map();
  const reloads = [];
  const toasts = [];
  const fetchCalls = [];

  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id,
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
      dataset: {}, events: {}, attrs: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name]; },
      removeAttribute(name) { delete this.attrs[name]; }, focus() {}
    });
    return elements.get(id);
  }

  const original = {
    id: 'ui-detail-share',
    title: 'Detail Share',
    description: null,
    htmlContent: 'body',
    codeType: 'html',
    isProtected: false,
    isFavorite: false,
    accessRevision: '4',
    currentRevision: '2',
    published: true,
    password: null,
    expiresAt: null,
    markdownTheme: null,
    createdAt: Date.now()
  };
  element('page-data').textContent = JSON.stringify(original);
  element('content-textarea').value = 'body';

  const documentStub = {
    getElementById: element,
    querySelector(selector) {
      return selector === 'meta[name="csrf-token"]' ? { getAttribute: () => 'csrf-token' } : null;
    },
    querySelectorAll: () => [],
    documentElement: { dataset: { dashboardSessionTag: 'dash-tag-35' } },
    createElement: () => ({ textContent: '', innerHTML: '' })
  };

  const sandbox = {
    document: documentStub,
    window: {
      AdminTime: { toDateTimeLocal: () => '', parseDateTimeLocal: () => 0, format: () => '' },
      SourceDiff: { renderMetaChanges() {}, renderParts() {}, compare: async () => ({ status: 'ok', parts: [] }) },
      sessionStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
      },
      location: { reload() { reloads.push(true); } }
    },
    Toast: {
      error: message => toasts.push({ type: 'error', message }),
      success: message => toasts.push({ type: 'success', message })
    },
    fetch: async (url, options) => {
      // Record EVERY attempt, including the one that will fail on transport:
      // the retry assertion compares the original and retried request ids.
      fetchCalls.push({ url, options });
      if (state.fetchError) throw state.fetchError;
      return state.response;
    },
    console, Date, JSON, Math
  };
  sandbox.window.document = documentStub;

  // Load publishing-request.js first (same script order as the detail view).
  const prSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'publishing-request.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(prSource, sandbox);
  const detailSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-detail.js'), 'utf8');
  vm.runInContext(detailSource, sandbox);

  return {
    element,
    fetchCalls,
    reloads,
    toasts,
    storage,
    setState(next) { Object.assign(state, next); },
    click(action) {
      return element(action === 'unpublish' ? 'unpublish-btn' : 'republish-btn').events.click();
    }
  };
}

test('detail unpublish sends the operation id and the displayed access baseline', async () => {
  const harness = createDetailHarness({
    response: jsonResponse(200, { success: true, changed: true, published: false, accessRevision: '5' })
  });
  await harness.click('unpublish');
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  const call = harness.fetchCalls[0];
  assert.equal(call.url, '/admin/pages/ui-detail-share/unpublish');
  assert.equal(call.options.method, 'POST');
  assert.match(call.options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(call.options.headers['X-CSRF-Token'], 'csrf-token');
  assert.deepEqual(JSON.parse(call.options.body), { expectedAccessRevision: '4' });
  assert.deepEqual(harness.reloads, [true], 'a definitive outcome reloads the true server state');
});

test('a lost detail publish response keeps the original request id for the retry', async () => {
  const harness = createDetailHarness({ fetchError: new TypeError('Failed to fetch') });
  await harness.click('unpublish');
  await flushPromises();
  assert.deepEqual(harness.reloads, []);
  assert.match(harness.toasts.at(-1).message, /原请求/);

  harness.setState({
    response: jsonResponse(200, {
      success: true, replayed: true, action: 'unpublish', changed: true, published: false, accessRevision: '5'
    }),
    fetchError: undefined
  });
  await harness.click('unpublish');
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 2, 'the retry happens on the next explicit click');
  assert.equal(
    harness.fetchCalls[0].options.headers['Idempotency-Key'],
    harness.fetchCalls[1].options.headers['Idempotency-Key'],
    'the ORIGINAL request id is reused'
  );
  assert.deepEqual(harness.reloads, [true]);
  assert.match(harness.toasts.at(-1).message, /已确认/);
});

test('a stale baseline on the detail page never rotates silently', async () => {
  const harness = createDetailHarness({
    response: jsonResponse(412, {
      success: false,
      code: 'ACCESS_REVISION_CONFLICT',
      error: 'Share 访问设置已更改，请刷新后重新确认；未保存的输入已保留。'
    })
  });
  await harness.click('unpublish');
  await flushPromises();

  assert.deepEqual(harness.reloads, []);
  assert.match(harness.toasts.at(-1).message, /刷新/);
  const intent = JSON.parse(harness.storage.get('quickshare.dashboard.intent.unpublish.ui-detail-share'));
  assert.ok(intent, 'the pending identity is retained; a refresh re-baselines it');
});

// ---- admin.js list-toggle VM behaviour (clone-intent harness family) ----

function createListHarness({ response, fetchError, confirmAnswer = true } = {}) {
  const state = { response, fetchError };
  const storage = new Map();
  const reloads = [];
  const toasts = [];
  const fetchCalls = [];
  const confirms = [];

  function makeControl(id, { published, accessRevision }) {
    const attributes = new Map([
      ['aria-busy', 'false'],
      ['aria-pressed', String(!published)]
    ]);
    let clickHandler;
    const node = {
      dataset: {
        pageId: id,
        pageTitle: id,
        published: String(published),
        accessRevision
      },
      disabled: false,
      getAttribute(name) { return attributes.get(name); },
      setAttribute(name, value) { attributes.set(name, value); },
      addEventListener(type, handler) { if (type === 'click') clickHandler = handler; },
      async click() { await clickHandler(); }
    };
    return node;
  }

  const controls = [makeControl('list-toggle-pub', { published: true, accessRevision: '2' })];

  const documentStub = {
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '[data-publish-toggle]' ? controls : [];
    },
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }; },
    body: { appendChild() {} }
  };

  const sandbox = {
    window: {
      crypto: {
        getRandomValues(array) {
          for (let i = 0; i < array.length; i += 1) array[i] = (i * 7 + 3) % 256;
          return array;
        },
        randomUUID: undefined
      },
      sessionStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
      },
      addEventListener() {},
      location: { reload() { reloads.push(true); }, search: '', origin: 'https://quickshare.test', href: '' },
      confirm(...args) { confirms.push(args[0]); return confirmAnswer; }
    },
    document: documentStub,
    URL, URLSearchParams,
    Toast: {
      success: message => toasts.push({ type: 'success', message }),
      error: message => toasts.push({ type: 'error', message })
    },
    fetch: async (url, options) => {
      // Record EVERY attempt, including the one that will fail on transport:
      // the retry assertion compares the original and retried request ids.
      fetchCalls.push({ url, options });
      if (state.fetchError) throw state.fetchError;
      return state.response;
    },
    // admin.js delays the success reload by 800ms in the browser; run it
    // synchronously here so the VM assertion observes the reload outcome.
    setTimeout: function (fn) { fn(); return 0; }
  };
  sandbox.window.document = documentStub;

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    controls,
    reloads,
    toasts,
    fetchCalls,
    confirms,
    storage,
    setState(next) { Object.assign(state, next); }
  };
}

test('list toggle confirms, submits the row baseline and reloads on success', async () => {
  const harness = createListHarness({
    response: jsonResponse(200, { success: true, changed: true, published: false, accessRevision: '3' })
  });
  await harness.controls[0].click();
  await flushPromises();

  assert.equal(harness.confirms.length, 1, 'the public pause is a deliberate confirmed action');
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, '/admin/pages/list-toggle-pub/unpublish');
  assert.match(harness.fetchCalls[0].options.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{16,128}$/);
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), { expectedAccessRevision: '2' });
  assert.deepEqual(harness.reloads, [true]);
});

test('a lost list toggle response retries with the original request id', async () => {
  const harness = createListHarness({ fetchError: new TypeError('Failed to fetch') });
  await harness.controls[0].click();
  await flushPromises();
  assert.deepEqual(harness.reloads, []);

  harness.setState({
    fetchError: undefined,
    response: jsonResponse(200, {
      success: true, replayed: true, action: 'unpublish', changed: true, published: false, accessRevision: '3'
    })
  });
  await harness.controls[0].click();
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(
    harness.fetchCalls[0].options.headers['Idempotency-Key'],
    harness.fetchCalls[1].options.headers['Idempotency-Key'],
    'the original id is reused for the ledger replay'
  );
  assert.deepEqual(harness.reloads, [true]);
});

test('a declined confirmation never contacts the server', async () => {
  const harness = createListHarness({ confirmAnswer: false, response: jsonResponse(200, { success: true }) });
  await harness.controls[0].click();
  await flushPromises();
  assert.deepEqual(harness.fetchCalls, []);
  assert.deepEqual(harness.reloads, []);
});
