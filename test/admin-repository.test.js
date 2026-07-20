const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPageRepository } = require('../models/memory-pages');
const { PostgresPageRepository } = require('../models/postgres-pages');

test('admin page listing is sorted by creation time and paginated', async () => {
  const repository = new MemoryPageRepository();
  await repository.init();

  await repository.create({
    id: 'old-page',
    htmlContent: '<h1>Old</h1>',
    createdAt: 1000,
    isProtected: false,
    codeType: 'html'
  });
  await repository.create({
    id: 'middle-page',
    htmlContent: '# Middle',
    createdAt: 2000,
    isProtected: false,
    codeType: 'markdown'
  });
  await repository.create({
    id: 'new-page',
    htmlContent: '<svg></svg>',
    createdAt: 3000,
    isProtected: true,
    codeType: 'svg'
  });

  const firstPage = await repository.listAdminPages({ limit: 2, offset: 0 });
  const secondPage = await repository.listAdminPages({ limit: 2, offset: 2 });

  assert.deepEqual(firstPage.map(page => page.id), ['new-page', 'middle-page']);
  assert.deepEqual(secondPage.map(page => page.id), ['old-page']);
  assert.equal(await repository.countPages(), 3);
});

test('memory pages default to a non-null false favorite state', async () => {
  const repository = new MemoryPageRepository();

  await repository.create({
    id: 'favorite-default',
    htmlContent: '<h1>Default favorite state</h1>',
    createdAt: 1000,
    isProtected: false,
    codeType: 'html'
  });

  const page = await repository.getById('favorite-default');
  assert.equal(page.is_favorite, false);
});

test('memory repository marks a Share favorite and reports the transition', async () => {
  const repository = new MemoryPageRepository();

  await repository.create({
    id: 'favorite-transition',
    htmlContent: '<h1>Favorite transition</h1>',
    createdAt: 1000
  });

  const result = await repository.setFavorite('favorite-transition', true);

  assert.deepEqual(result, {
    found: true,
    changed: true,
    isFavorite: true,
    previousValue: false
  });
  assert.equal((await repository.getById('favorite-transition')).is_favorite, true);
});

test('memory favorite mutation is idempotent and missing-safe', async () => {
  const repository = new MemoryPageRepository();

  await repository.create({
    id: 'favorite-idempotent',
    htmlContent: '<h1>Favorite idempotency</h1>',
    createdAt: 1000
  });
  await repository.setFavorite('favorite-idempotent', true);

  assert.deepEqual(await repository.setFavorite('favorite-idempotent', true), {
    found: true,
    changed: false,
    isFavorite: true,
    previousValue: true
  });
  assert.deepEqual(await repository.setFavorite('favorite-idempotent', false), {
    found: true,
    changed: true,
    isFavorite: false,
    previousValue: true
  });
  assert.deepEqual(await repository.setFavorite('missing-favorite', true), {
    found: false,
    changed: false,
    isFavorite: false,
    previousValue: null
  });
});

test('memory favorite mutation accepts only boolean targets', async () => {
  const repository = new MemoryPageRepository();

  await repository.create({
    id: 'favorite-boolean',
    htmlContent: '<h1>Favorite boolean</h1>',
    createdAt: 1000
  });

  await assert.rejects(
    repository.setFavorite('favorite-boolean', 'true'),
    /isFavorite must be a boolean/
  );
  assert.equal((await repository.getById('favorite-boolean')).is_favorite, false);
});

test('admin stats aggregate totals, protection, types, and recent days', async () => {
  const repository = new MemoryPageRepository();
  await repository.init();
  const now = Date.now();

  await repository.create({
    id: 'html-public',
    htmlContent: '<h1>Hello</h1>',
    createdAt: now - 1000,
    isProtected: false,
    codeType: 'html'
  });
  await repository.create({
    id: 'markdown-protected',
    htmlContent: '# Secret',
    createdAt: now - 2000,
    isProtected: true,
    codeType: 'markdown'
  });
  await repository.create({
    id: 'html-protected',
    htmlContent: '<p>Secret</p>',
    createdAt: now - 3000,
    isProtected: true,
    codeType: 'html'
  });

  const stats = await repository.getAdminStats();

  assert.equal(stats.total, 3);
  assert.equal(stats.public, 1);
  assert.equal(stats.protected, 2);
  assert.deepEqual(stats.byType, [
    { codeType: 'html', count: 2 },
    { codeType: 'markdown', count: 1 }
  ]);
  assert.equal(stats.recentDays.length, 14);
  assert.equal(stats.recentDays.at(-1).count, 3);
});


test('Postgres runtime methods never create or alter schema', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  const queries = [];

  repository.pool = {
    async query(sql) {
      queries.push(sql);

      if (sql.includes('SELECT id, name, key_prefix')) {
        return { rows: [] };
      }

      return { rows: [] };
    }
  };

  await repository.init();
  const apiKeys = await repository.listApiKeys();

  assert.deepEqual(apiKeys, []);
  assert.equal(queries.some(sql => /\b(?:CREATE|ALTER|DROP)\b/i.test(sql)), false);
});

test('Postgres public lookup reports expiry in one query', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  const queries = [];

  repository.pool = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (params[0] === 'missing-page') {
        return { rows: [] };
      }

      return {
        rows: [{
          id: params[0],
          html_content: '<h1>Page</h1>',
          expires_at: 5000,
          is_expired: params[0] === 'expired-page'
        }]
      };
    }
  };

  const result = await repository.getPublicById('expired-page', 5000);
  const activeResult = await repository.getPublicById('active-page', 4999);
  const missingResult = await repository.getPublicById('missing-page', 5000);

  assert.deepEqual(result, {
    page: {
      id: 'expired-page',
      html_content: '<h1>Page</h1>',
      expires_at: 5000
    },
    expired: true
  });
  assert.equal(activeResult.expired, false);
  assert.equal(missingResult, null);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].params, ['expired-page', 5000]);
  assert.match(queries[0].sql, /expires_at IS NOT NULL AND expires_at <= \$2/);
});

test('Postgres admin listing supports explicit unpaginated reads for exports', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  const queries = [];

  repository.pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    }
  };

  await repository.listAdminPages({ limit: null });
  await repository.listAdminPages();

  assert.deepEqual(queries[0].params, []);
  assert.doesNotMatch(queries[0].sql, /LIMIT \$\d+ OFFSET \$\d+/i);
  assert.deepEqual(queries[1].params, [50, 0]);
  assert.match(queries[1].sql, /LIMIT \$1 OFFSET \$2/i);
});

test('Postgres favorite mutation exposes the same result contract as memory storage', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  const queries = [];
  const outcomes = {
    changed: {
      found: true,
      changed: true,
      is_favorite: true,
      previous_value: false
    },
    unchanged: {
      found: true,
      changed: false,
      is_favorite: true,
      previous_value: true
    },
    missing: {
      found: false,
      changed: false,
      is_favorite: false,
      previous_value: null
    }
  };

  repository.pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [outcomes[params[0]]] };
    }
  };

  assert.deepEqual(await repository.setFavorite('changed', true), {
    found: true,
    changed: true,
    isFavorite: true,
    previousValue: false
  });
  assert.deepEqual(await repository.setFavorite('unchanged', true), {
    found: true,
    changed: false,
    isFavorite: true,
    previousValue: true
  });
  assert.deepEqual(await repository.setFavorite('missing', true), {
    found: false,
    changed: false,
    isFavorite: false,
    previousValue: null
  });
  await assert.rejects(repository.setFavorite('changed', 1), /isFavorite must be a boolean/);
  assert.match(queries[0].sql, /SELECT id, is_favorite[\s\S]+FOR UPDATE/i);
  assert.match(queries[0].sql, /UPDATE pages[\s\S]+FROM existing/i);
});

test('view events update eligible rows without selecting page content', async () => {
  const repository = Object.create(PostgresPageRepository.prototype);
  const queries = [];
  const states = {
    expired: { is_protected: 0, expires_at: 5000 },
    protected: { is_protected: 1, expires_at: null }
  };

  repository.pool = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (/^\s*UPDATE pages/i.test(sql)) {
        return { rowCount: params[0] === 'active' ? 1 : 0, rows: [] };
      }

      return { rows: states[params[0]] ? [states[params[0]]] : [] };
    }
  };

  assert.equal(await repository.recordViewEvent('active', 4999, false), 'counted');
  assert.equal(await repository.recordViewEvent('expired', 5000, false), 'expired');
  assert.equal(await repository.recordViewEvent('protected', 5000, false), 'protected');
  assert.equal(await repository.recordViewEvent('missing', 5000, false), 'not_found');

  assert.equal(queries.length, 7);
  assert.doesNotMatch(queries.map(query => query.sql).join('\n'), /SELECT\s+\*|html_content|password_hash/i);
  assert.match(queries[0].sql, /expires_at IS NULL OR expires_at > \$2/);
  assert.match(queries[0].sql, /is_protected, 0\) <> 1 OR \$3/);
  assert.deepEqual(queries[0].params, ['active', 4999, false]);
  assert.match(queries[2].sql, /SELECT is_protected, expires_at/);
});
