const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let randomFillCounter = 0;

function createSandbox() {
  const storage = new Map();
  const sandbox = {
    window: {
      crypto: {
        getRandomValues(array) {
          // File-level counter so separate sandboxes never produce identical
          // fallback bytes (browsers use real window.crypto randomness).
          randomFillCounter += 1;
          for (let i = 0; i < array.length; i += 1) array[i] = (i * 7 + randomFillCounter * 31 + 3) % 256;
          return array;
        }
      },
      sessionStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
      },
      location: { reload() { sandbox.window.location.reloaded = (sandbox.window.location.reloaded || 0) + 1; } }
    },
    sessionStorage: null
  };
  sandbox.window.document = {
    documentElement: { dataset: {} },
    cookie: '',
    querySelector() { return null; }
  };
  Object.defineProperty(sandbox.window.document, 'cookie', {
    get() { return sandbox.window.document.__cookie || ''; },
    set(value) {
      const name = String(value).split('=')[0];
      const parts = (sandbox.window.document.__cookie || '').split('; ').filter(Boolean);
      const kept = parts.filter(part => !part.startsWith(name + '='));
      kept.push(value);
      sandbox.window.document.__cookie = kept.join('; ');
    }
  });
  sandbox.window.sessionStorage._map = storage;
  return sandbox;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Full-file VM harness for admin.js clone-intent behaviour (same pattern as
// test/admin-navigation.test.js): minimal DOM, captured submit listeners and
// a forms registry keyed by action path. This is VM evidence only — the real
// browser flow is exercised separately.
function createAdminCloneHarness() {
  const storage = new Map();
  let randomFillCounter = 9000;
  const forms = {};
  const submitListeners = [];
  const pageShowListeners = [];

  function makeField(form) {
    return {
      value: '',
      closest(selector) {
        return selector === 'form[data-clone-form]' ? form : null;
      }
    };
  }

  function ensureForm(actionPath) {
    if (!forms[actionPath]) {
      const form = {
        action: `https://quickshare.test${actionPath}`,
        matches: (selector) => selector === 'form[data-clone-form]',
        querySelector: (selector) => (selector === '[data-clone-request-id]' ? form.__field : null)
      };
      form.__field = makeField(form);
      forms[actionPath] = form;
    }
    return forms[actionPath];
  }

  const documentStub = {
    documentElement: { dataset: {} },
    __cookie: '',
    addEventListener(type, handler) {
      if (type === 'submit') submitListeners.push(handler);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }; },
    body: { appendChild() {} }
  };
  Object.defineProperty(documentStub, 'cookie', {
    get() { return documentStub.__cookie; },
    set(value) {
      const name = String(value).split('=')[0];
      const parts = documentStub.__cookie.split('; ').filter(Boolean);
      const kept = parts.filter(part => !part.startsWith(name + '='));
      kept.push(value);
      documentStub.__cookie = kept.join('; ');
    }
  });

  const sandbox = {
    window: {
      crypto: {
        getRandomValues(array) {
          randomFillCounter += 1;
          for (let i = 0; i < array.length; i += 1) array[i] = (i * 11 + randomFillCounter * 17 + 5) % 256;
          return array;
        },
        randomUUID: undefined
      },
      sessionStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
      },
      addEventListener(type, handler) {
        if (type === 'pageshow') pageShowListeners.push(handler);
      },
      location: { href: 'https://quickshare.test/admin/pages' }
    },
    document: documentStub,
    URL,
    URLSearchParams
  };
  sandbox.window.sessionStorage._map = storage;
  sandbox.window.document = documentStub;

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    window: sandbox.window,
    forms,
    ensureForm,
    fireSubmit(actionPath) {
      const event = { target: ensureForm(actionPath) };
      for (const handler of submitListeners) handler(event);
    },
    firePageShow() {
      for (const handler of pageShowListeners) handler({ persisted: true });
    }
  };
}

function loadModule(sandbox) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'publishing-request.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.QuickSharePublishingRequest;
}

function setSessionTag(sandbox, tag) {
  sandbox.window.document.documentElement.dataset.publishSessionTag = tag;
}

test('same session + same draft key keeps one pending request id across retries and reloads', () => {
  const first = createSandbox();
  setSessionTag(first, 'tag-s1');
  const moduleA = loadModule(first);
  const claimA = moduleA.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(claimA.mode, 'new');

  // Reload in the same session (same tag, sessionStorage restored).
  const reloaded = createSandbox();
  setSessionTag(reloaded, 'tag-s1');
  reloaded.window.sessionStorage._map.set('quickshare.publish.requestId',
    first.window.sessionStorage._map.get('quickshare.publish.requestId'));
  const moduleB = loadModule(reloaded);
  const claimB = moduleB.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(claimB.mode, 'retry', 'the unknown request keeps its original id');
  assert.equal(claimB.requestId, claimA.requestId);
});

test('same session + changed draft rotates to a new explicit intent id', () => {
  const sandbox = createSandbox();
  setSessionTag(sandbox, 'tag-s1');
  const module = loadModule(sandbox);
  const first = module.claimRequestDraftId('draft-v1', { title: 'V1' });
  assert.equal(first.mode, 'new');
  const second = module.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(second.mode, 'new');
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(module.consumePendingReplaced(), true, 'rotation over an unknown pending must be surfaced');
});

test('a DIFFERENT session tag blocks the old pending: no silent claim, no rotation', () => {
  const first = createSandbox();
  setSessionTag(first, 'tag-s1');
  const moduleA = loadModule(first);
  const original = moduleA.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(original.mode, 'new');

  // Old tab reloads after the cookie/session was replaced elsewhere.
  const reloaded = createSandbox();
  setSessionTag(reloaded, 'tag-s2');
  reloaded.window.sessionStorage._map.set('quickshare.publish.requestId',
    first.window.sessionStorage._map.get('quickshare.publish.requestId'));
  const moduleB = loadModule(reloaded);

  const pending = moduleB.pendingState();
  assert.equal(pending.orphan, true, 'the stale pending is displayed read-only as orphaned');

  const blocked = moduleB.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(blocked.mode, 'blocked', 'the old id must never be claimed under the new namespace');

  // After the user explicitly abandons it, publishing becomes a new intent.
  assert.equal(moduleB.discardPending(), true);
  const afterDiscard = moduleB.claimRequestDraftId('draft-v2', { title: 'V2' });
  assert.equal(afterDiscard.mode, 'new');
  assert.notEqual(afterDiscard.requestId, original.requestId,
    'the old id must never land in the new namespace');
});

test('an orphaned pending survives: no auto-delete on load, read-only until the user decides', () => {
  const first = createSandbox();
  setSessionTag(first, 'tag-s1');
  const moduleA = loadModule(first);
  moduleA.claimRequestDraftId('draft-v3', { title: 'V3' });

  const reloaded = createSandbox();
  setSessionTag(reloaded, 'tag-s2');
  reloaded.window.sessionStorage._map.set('quickshare.publish.requestId',
    first.window.sessionStorage._map.get('quickshare.publish.requestId'));
  const moduleB = loadModule(reloaded);

  const pending = moduleB.pendingState();
  assert.ok(pending, 'the orphan is kept visible, not auto-deleted');
  assert.equal(pending.requestId, JSON.parse(
    reloaded.window.sessionStorage._map.get('quickshare.publish.requestId')).requestId);
  assert.equal(pending.orphan, true);
  assert.equal(pending.summary.title, 'V3', 'the non-sensitive original summary is kept for display');
});

test('confirming completion clears the pending pair', () => {
  const sandbox = createSandbox();
  setSessionTag(sandbox, 'tag-s1');
  const module = loadModule(sandbox);
  const first = module.claimRequestDraftId('3', { title: 'T' });
  module.confirmCompleted();
  const next = module.claimRequestDraftId('3', { title: 'T' });
  assert.equal(next.mode, 'new');
  assert.notEqual(next.requestId, first.requestId, 'same content, new intent');
  assert.equal(module.pendingState().requestId, next.requestId);
});

test('manual fallback generates an RFC 4122 UUID v4 shape (8-4-4-4-12, version 4, valid variant)', () => {
  const sandbox = createSandbox();
  sandbox.window.crypto = { getRandomValues(array) {
    for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) % 256;
    return array;
  } };
  const module = loadModule(sandbox);

  for (let round = 0; round < 8; round += 1) {
    const id = module.claimRequestDraftId(`k${round}`, {}).requestId;
    assert.match(id, UUID_RE);
  }
});

test('clone intents persist for retry, and completion rotates (cookie-confirmed)', () => {
  const sandbox = createSandbox();
  setSessionTag(sandbox, 'tag-s1');
  sandbox.window.document.cookie = '';
  const module = loadModule(sandbox);

  module.persistCloneIntent('clone-id-0123456789012', 'share0001');
  assert.equal(module.cloneIntentState().requestId, 'clone-id-0123456789012');
  assert.equal(module.cloneIntentState().completed, false, 'unconfirmed: retry stays possible');

  // The response arrived: the completion cookie names the same request id.
  sandbox.window.document.cookie = 'clone_intent_done=clone-id-0123456789012';
  module.reconcileCloneIntents();
  assert.equal(module.cloneIntentState().completed, true, 'completed intents rotate on the next click');
});

test('an unconfirmed clone intent is kept (not cleared) so the retry can reuse the same id', () => {
  const sandbox = createSandbox();
  setSessionTag(sandbox, 'tag-s1');
  sandbox.window.document.cookie = '';
  const module = loadModule(sandbox);
  module.persistCloneIntent('clone-id-unconfirmed1', 'share0002');
  module.reconcileCloneIntents();
  assert.equal(module.cloneIntentState().completed, false);
  assert.equal(module.cloneIntentState().requestId, 'clone-id-unconfirmed1');
});

test('the homepage wiring loads publishing-request.js and main.js uses it', () => {
  const footer = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'footer.ejs'), 'utf8');
  const publishingRequestPos = footer.indexOf('/js/publishing-request.js');
  const mainPos = footer.indexOf('/js/main.js');
  assert.ok(publishingRequestPos !== -1, 'publishing-request.js is included on the homepage');
  assert.ok(mainPos !== -1);
  assert.ok(publishingRequestPos < mainPos, 'publishing-request.js loads before main.js');

  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.match(main, /Idempotency-Key/, 'web creation sends the request id header');
  assert.match(main, /claimRequestDraftId/, 'the request id follows the draft lifecycle');
  assert.match(main, /confirmCompleted/, 'a completed publish clears the pending id');
  assert.match(main, /PUBLISH_SESSION_REQUIRED/, 'a missing session surfaces an explicit refusal');
  assert.match(main, /expiresAt[\s\S]*claimRequestDraftId/, 'pending resolution precedes the local expiry gate');
  assert.match(main, /pending-publish-status/, 'pending state is visible on the page');
});

test('admin clone submit reuses an unconfirmed intent id for the same target (retry path)', () => {
  const harness = createAdminCloneHarness();
  harness.window.QuickShareCloneIntents.persist('clone-retry-012345678', 'shareAAA');
  const form = harness.ensureForm('/admin/pages/shareAAA/clone');
  form.querySelector('[data-clone-request-id]').value = '';

  harness.fireSubmit('/admin/pages/shareAAA/clone');

  const field = form.querySelector('[data-clone-request-id]');
  assert.equal(field.value, 'clone-retry-012345678', 'the unconfirmed intent id is reused for the retry');
  assert.equal(JSON.parse(harness.window.sessionStorage.getItem('quickshare.clone.intent')).requestId,
    'clone-retry-012345678');
  assert.match(field.value, /^[A-Za-z0-9_-]{16,128}$/);
});

test('a completed intent for the target rotates: fresh click, fresh id', () => {
  const harness = createAdminCloneHarness();
  harness.window.document.cookie = 'clone_intent_done=clone-done-012345678';
  harness.window.QuickShareCloneIntents.persist('clone-done-012345678', 'shareAAA');
  const form = harness.ensureForm('/admin/pages/shareAAA/clone');
  form.querySelector('[data-clone-request-id]').value = 'clone-done-012345678';

  harness.fireSubmit('/admin/pages/shareAAA/clone');

  const field = form.querySelector('[data-clone-request-id]');
  assert.notEqual(field.value, 'clone-done-012345678', 'the completed id must not be resubmitted');
  assert.match(field.value, UUID_RE, 'a new explicit clone gets a fresh UUID v4');
  assert.equal(JSON.parse(harness.window.sessionStorage.getItem('quickshare.clone.intent')).requestId, field.value);
});

// ---- Rework round 3 closure 2: pending status text follows draft changes ----

test('pendingStatusMessage: same draft claims retry, diverged draft is neutral, orphan stays read-only', () => {
  const sandbox = createSandbox();
  setSessionTag(sandbox, 'tag-s1');
  const module = loadModule(sandbox);
  const assertMessage = typeof module.pendingStatusMessage === 'function';

  const pending = { requestId: 'abcdef12-0000-0000-0000-000000003456', draftKey: 'key-a', orphan: false };

  if (assertMessage) {
    assert.match(
      module.pendingStatusMessage(pending, 'key-a'),
      /将以原请求重试/,
      'same draft key: the retry claim stays accurate'
    );
    assert.match(
      module.pendingStatusMessage(pending, 'key-b'),
      /不同|新发布/,
      'a diverged draft must NOT claim the original-request retry'
    );
    assert.match(
      module.pendingStatusMessage(pending, null),
      /结果未知|管理后台/,
      'unknown current draft: neutral wording'
    );
    const orphan = { requestId: pending.requestId, draftKey: 'key-a', orphan: true };
    assert.match(module.pendingStatusMessage(orphan, 'key-a'), /失效|放弃|管理后台/,
      'orphan stays read-only regardless of draft');
    assert.equal(module.pendingStatusMessage(null, 'key-a'), null);
  } else {
    assert.fail('pendingStatusMessage helper must exist so status text can follow draft changes');
  }
});
