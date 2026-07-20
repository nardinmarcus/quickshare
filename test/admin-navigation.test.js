const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');

function interactiveElement(properties = {}) {
  const listeners = new Map();

  return {
    ...properties,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    trigger(type, event = {}) {
      const handler = listeners.get(type);
      assert.equal(typeof handler, 'function', `${type} handler should be registered`);
      handler(event);
    }
  };
}

function runNavigationController() {
  const navigations = [];
  const searchForm = interactiveElement();
  const searchInput = { value: '' };
  const jumpInput = interactiveElement({ value: '3', max: '5' });
  const jumpButton = interactiveElement();
  const dateFrom = { value: '2026-07-01' };
  const dateTo = { value: '2026-07-31' };
  const dateButton = interactiveElement();
  const pagesContext = {
    dataset: {
      adminPagesUrl: '/admin/pages?type=markdown&favorite=true&sort=created_at&order=desc&page=2'
    }
  };
  const elements = new Map([
    ['admin-pages-context', pagesContext],
    ['admin-search-form', searchForm],
    ['admin-search-input', searchInput],
    ['jump-page-input', jumpInput],
    ['jump-page-btn', jumpButton],
    ['filter-date-from', dateFrom],
    ['filter-date-to', dateTo],
    ['date-filter-btn', dateButton]
  ]);
  const location = {
    origin: 'https://quickshare.test',
    search: '?search=&type=markdown&favorite=true&unused=',
    get href() {
      return navigations.at(-1) || 'https://quickshare.test/admin/pages';
    },
    set href(value) {
      navigations.push(value);
    }
  };
  const context = {
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    window: { location },
    URL,
    URLSearchParams
  };

  vm.runInNewContext(source, context);
  return { searchForm, jumpButton, dateButton, navigations };
}

test('admin list browser navigation starts from the canonical server query and omits empty values', () => {
  const { searchForm, jumpButton, dateButton, navigations } = runNavigationController();

  let prevented = false;
  searchForm.trigger('submit', {
    preventDefault() {
      prevented = true;
    }
  });
  dateButton.trigger('click');
  jumpButton.trigger('click');

  assert.equal(prevented, true);
  assert.deepEqual(navigations, [
    '/admin/pages?type=markdown&favorite=true&sort=created_at&order=desc',
    '/admin/pages?type=markdown&favorite=true&sort=created_at&order=desc&dateFrom=2026-07-01&dateTo=2026-07-31',
    '/admin/pages?type=markdown&favorite=true&sort=created_at&order=desc&page=3'
  ]);
  navigations.forEach((href) => {
    const params = new URL(href, 'https://quickshare.test').searchParams;
    for (const value of params.values()) assert.notEqual(value, '');
  });
});
