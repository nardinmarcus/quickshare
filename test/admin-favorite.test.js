const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/admin-favorite.js'), 'utf8');

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createControl(isFavorite) {
  const attributes = new Map([
    ['aria-busy', 'false'],
    ['aria-pressed', String(isFavorite)],
    ['aria-label', isFavorite ? '取消收藏 Test Share' : '收藏分享 Test Share']
  ]);
  const iconClasses = new Set([isFavorite ? 'fas' : 'far', 'fa-star', 'admin-favorite-icon']);
  const icon = {
    classList: {
      toggle(name, force) {
        if (force) iconClasses.add(name);
        else iconClasses.delete(name);
      }
    }
  };
  const label = { textContent: isFavorite ? '取消收藏' : '收藏' };
  let clickHandler;

  return {
    control: {
      dataset: {
        pageId: 'favorite/test',
        pageTitle: 'Test Share',
        isFavorite: String(isFavorite)
      },
      disabled: false,
      getAttribute(name) {
        return attributes.get(name);
      },
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      querySelector(selector) {
        return selector === '.admin-favorite-icon' ? icon : label;
      },
      addEventListener(type, handler) {
        if (type === 'click') clickHandler = handler;
      }
    },
    attributes,
    iconClasses,
    label,
    click() {
      clickHandler();
    }
  };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function runController({ isFavorite, fetch }) {
  const favorite = createControl(isFavorite);
  const notifications = [];
  const context = {
    document: {
      querySelector(selector) {
        if (selector === '[data-favorite-toggle]') return favorite.control;
        return { getAttribute: () => 'csrf-token' };
      }
    },
    fetch,
    Toast: {
      success(message) {
        notifications.push({ type: 'success', message });
      },
      error(message) {
        notifications.push({ type: 'error', message });
      }
    }
  };

  vm.runInNewContext(source, context);
  return { favorite, notifications };
}

test('favorite control waits for the server and ignores repeat clicks while busy', async () => {
  const response = createDeferred();
  const fetchCalls = [];
  const { favorite, notifications } = runController({
    isFavorite: false,
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return response.promise;
    }
  });

  favorite.click();
  favorite.click();

  assert.equal(fetchCalls.length, 1);
  assert.equal(favorite.control.disabled, true);
  assert.equal(favorite.attributes.get('aria-busy'), 'true');
  assert.equal(favorite.attributes.get('aria-pressed'), 'false');
  assert.equal(favorite.label.textContent, '收藏');
  assert.equal(fetchCalls[0].url, '/admin/pages/favorite%2Ftest/favorite');
  assert.equal(fetchCalls[0].options.headers['X-CSRF-Token'], 'csrf-token');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { isFavorite: true });

  response.resolve({
    ok: true,
    async json() {
      return { success: true, changed: true, isFavorite: true };
    }
  });
  await flushPromises();

  assert.equal(favorite.control.disabled, false);
  assert.equal(favorite.attributes.get('aria-busy'), 'false');
  assert.equal(favorite.attributes.get('aria-pressed'), 'true');
  assert.equal(favorite.attributes.get('aria-label'), '取消收藏 Test Share');
  assert.equal(favorite.label.textContent, '取消收藏');
  assert.equal(favorite.iconClasses.has('fas'), true);
  assert.equal(favorite.iconClasses.has('far'), false);
  assert.deepEqual(notifications, [{ type: 'success', message: '已收藏' }]);
});

test('favorite control keeps its previous state when the request fails', async () => {
  const { favorite, notifications } = runController({
    isFavorite: true,
    async fetch() {
      return {
        ok: false,
        async json() {
          return { success: false, error: '暂时无法更新收藏' };
        }
      };
    }
  });

  favorite.click();
  await flushPromises();

  assert.equal(favorite.control.disabled, false);
  assert.equal(favorite.attributes.get('aria-busy'), 'false');
  assert.equal(favorite.attributes.get('aria-pressed'), 'true');
  assert.equal(favorite.attributes.get('aria-label'), '取消收藏 Test Share');
  assert.equal(favorite.label.textContent, '取消收藏');
  assert.equal(favorite.iconClasses.has('fas'), true);
  assert.deepEqual(notifications, [{ type: 'error', message: '暂时无法更新收藏' }]);
});
