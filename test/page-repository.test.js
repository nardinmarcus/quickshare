const test = require('node:test');
const assert = require('node:assert/strict');

const { createPageRepository } = require('../models/pageRepository');
const { MemoryPageRepository } = require('../models/memory-pages');

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test('test environment always uses the in-memory repository', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://production.example/quickshare';
  process.env.POSTGRES_URL = 'postgres://production.example/quickshare';

  try {
    assert.ok(createPageRepository() instanceof MemoryPageRepository);
  } finally {
    restoreEnvironment('NODE_ENV', originalNodeEnv);
    restoreEnvironment('DATABASE_URL', originalDatabaseUrl);
    restoreEnvironment('POSTGRES_URL', originalPostgresUrl);
  }
});
