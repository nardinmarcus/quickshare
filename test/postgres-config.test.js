const test = require('node:test');
const assert = require('node:assert/strict');

const { PostgresPageRepository } = require('../models/postgres-pages');
const { buildPostgresPoolOptions } = require('../models/postgres-config');

test('Postgres pool options enforce bounded defaults and explicit verified SSL', () => {
  const options = buildPostgresPoolOptions(
    'postgres://user:password@example.com:5432/quickshare?sslmode=require',
    {}
  );
  const connectionUrl = new URL(options.connectionString);

  assert.equal(connectionUrl.searchParams.get('sslmode'), 'verify-full');
  assert.equal(options.max, 3);
  assert.equal(options.connectionTimeoutMillis, 2500);
  assert.equal(options.idleTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 4000);
  assert.equal(options.query_timeout, 4500);
  assert.equal(options.idle_in_transaction_session_timeout, 5000);
});

test('Postgres pool options fall back from invalid overrides and allow explicit local SSL disable', () => {
  const options = buildPostgresPoolOptions(
    'postgres://user:password@localhost:5432/quickshare?sslmode=require',
    {
      POSTGRES_SSL: 'false',
      POSTGRES_POOL_MAX: '-1',
      POSTGRES_CONNECTION_TIMEOUT_MS: 'not-a-number',
      POSTGRES_IDLE_TIMEOUT_MS: '0',
      POSTGRES_STATEMENT_TIMEOUT_MS: '999999',
      POSTGRES_QUERY_TIMEOUT_MS: '1',
      POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '-10'
    }
  );
  const connectionUrl = new URL(options.connectionString);

  assert.equal(connectionUrl.searchParams.get('sslmode'), 'disable');
  assert.equal(options.max, 3);
  assert.equal(options.connectionTimeoutMillis, 2500);
  assert.equal(options.idleTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 4000);
  assert.equal(options.query_timeout, 4500);
  assert.equal(options.idle_in_transaction_session_timeout, 5000);
});

test('Postgres pool options reject disabling SSL for a remote host', () => {
  assert.throws(
    () => buildPostgresPoolOptions(
      'postgres://user:password@db.example.com:5432/quickshare',
      { POSTGRES_SSL: 'false' }
    ),
    /only allowed for localhost/i
  );
});

test('Postgres repository installs an idle pool error listener', async () => {
  const repository = new PostgresPageRepository(
    'postgres://user:password@localhost:5432/quickshare?sslmode=disable',
    { POSTGRES_SSL: 'false' }
  );

  assert.equal(repository.pool.listenerCount('error'), 1);
  await repository.pool.end();
});
