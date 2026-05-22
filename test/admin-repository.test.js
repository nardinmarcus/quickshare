const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPageRepository } = require('../models/memory-pages');

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
