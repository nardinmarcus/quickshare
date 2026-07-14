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
