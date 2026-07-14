const test = require('node:test');
const assert = require('node:assert/strict');

const { createPageRepository } = require('../models/pageRepository');
const { MemoryPageRepository } = require('../models/memory-pages');

test('production refuses to use the in-memory repository when the database URL is missing', () => {
  assert.throws(
    () => createPageRepository({ NODE_ENV: 'production', VERCEL_ENV: 'production' }),
    /DATABASE_URL or POSTGRES_URL is required/i
  );
});

test('development may explicitly use the in-memory repository', () => {
  const repository = createPageRepository({ NODE_ENV: 'development' });

  assert.equal(repository instanceof MemoryPageRepository, true);
});
