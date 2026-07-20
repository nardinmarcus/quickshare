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

function createControl(isFavorite, options = {}) {
  const pageId = options.pageId || 'favorite/test';
  const pageTitle = options.pageTitle || 'Test Share';
  const attributes = new Map([
    ['aria-busy', 'false'],
    ['aria-pressed', String(isFavorite)],
    ['aria-label', isFavorite ? `取消收藏 ${pageTitle}` : `收藏分享 ${pageTitle}`]
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
        pageId,
        pageTitle,
        isFavorite: String(isFavorite),
        ...(options.refreshUrl ? { refreshUrl: options.refreshUrl } : {})
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

function runController({ isFavorite, controls, fetch }) {
  const favorites = (controls || [{ isFavorite }]).map((options) =>
    createControl(options.isFavorite, options)
  );
  const notifications = [];
  const navigation = [];
  const location = {
    assign(url) {
      navigation.push(url);
    }
  };
  const context = {
    document: {
      querySelector(selector) {
        if (selector === '[data-favorite-toggle]') return favorites[0]?.control || null;
        return { getAttribute: () => 'csrf-token' };
      },
      querySelectorAll(selector) {
        return selector === '[data-favorite-toggle]'
          ? favorites.map(favorite => favorite.control)
          : [];
      }
    },
    fetch,
    location,
    window: { location },
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
  return { favorite: favorites[0], favorites, notifications, navigation };
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
  const { favorite, notifications, navigation } = runController({
    controls: [{
      isFavorite: true,
      refreshUrl: '/admin/pages?favorite=true&search=Retry'
    }],
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
  assert.deepEqual(navigation, []);
});

test('favorite control translates a rejected network request into retryable Chinese feedback', async () => {
  const { favorite, notifications } = runController({
    isFavorite: true,
    async fetch() {
      throw new TypeError('Failed to fetch');
    }
  });

  favorite.click();
  await flushPromises();

  assert.equal(favorite.control.disabled, false);
  assert.equal(favorite.attributes.get('aria-busy'), 'false');
  assert.equal(favorite.attributes.get('aria-pressed'), 'true');
  assert.deepEqual(notifications, [{ type: 'error', message: '网络连接失败，请重试' }]);
});

test('shared favorite controller binds every row and refreshes only a confirmed Favorite Shares removal', async () => {
  const fetchCalls = [];
  const refreshUrl = '/admin/pages?search=Issue7+Rows&favorite=true&sort=created_at&order=desc&page=2';
  const { favorites, notifications, navigation } = runController({
    controls: [
      { isFavorite: false, pageId: 'normal-row', pageTitle: 'Normal Row' },
      {
        isFavorite: true,
        pageId: 'filtered-row',
        pageTitle: 'Filtered Row',
        refreshUrl
      }
    ],
    async fetch(url, options) {
      fetchCalls.push({ url, options });
      const { isFavorite } = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { success: true, changed: true, isFavorite };
        }
      };
    }
  });

  favorites[0].click();
  await flushPromises();

  assert.equal(favorites[0].attributes.get('aria-pressed'), 'true');
  assert.equal(favorites[1].attributes.get('aria-pressed'), 'true');
  assert.deepEqual(navigation, []);

  favorites[1].click();
  await flushPromises();

  assert.deepEqual(fetchCalls.map(call => call.url), [
    '/admin/pages/normal-row/favorite',
    '/admin/pages/filtered-row/favorite'
  ]);
  assert.equal(favorites[1].attributes.get('aria-pressed'), 'false');
  assert.deepEqual(notifications, [
    { type: 'success', message: '已收藏' },
    { type: 'success', message: '已取消收藏' }
  ]);
  assert.deepEqual(navigation, [refreshUrl]);
});
