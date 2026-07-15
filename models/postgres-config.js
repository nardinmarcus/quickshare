const DEFAULTS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 2500,
  idleTimeoutMillis: 10000,
  statementTimeoutMillis: 4000,
  queryTimeoutMillis: 4500,
  idleTransactionTimeoutMillis: 5000
});

function readBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }

  return parsed;
}

function normalizeConnectionString(connectionString, env = process.env) {
  let url;

  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error('Postgres connection string must be a valid URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Postgres connection string must use postgres:// or postgresql://');
  }

  if (env.POSTGRES_SSL === 'false') {
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

    if (!localHosts.has(url.hostname)) {
      throw new Error('POSTGRES_SSL=false is only allowed for localhost');
    }
  }

  url.searchParams.delete('uselibpqcompat');
  url.searchParams.set('sslmode', env.POSTGRES_SSL === 'false' ? 'disable' : 'verify-full');
  return url.toString();
}

function buildPostgresPoolOptions(connectionString, env = process.env) {
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  return {
    connectionString: normalizeConnectionString(connectionString, env),
    max: readBoundedInteger(env.POSTGRES_POOL_MAX, DEFAULTS.max, 1, 10),
    connectionTimeoutMillis: readBoundedInteger(
      env.POSTGRES_CONNECTION_TIMEOUT_MS,
      DEFAULTS.connectionTimeoutMillis,
      100,
      9000
    ),
    idleTimeoutMillis: readBoundedInteger(
      env.POSTGRES_IDLE_TIMEOUT_MS,
      DEFAULTS.idleTimeoutMillis,
      1000,
      60000
    ),
    statement_timeout: readBoundedInteger(
      env.POSTGRES_STATEMENT_TIMEOUT_MS,
      DEFAULTS.statementTimeoutMillis,
      100,
      9000
    ),
    query_timeout: readBoundedInteger(
      env.POSTGRES_QUERY_TIMEOUT_MS,
      DEFAULTS.queryTimeoutMillis,
      100,
      9000
    ),
    idle_in_transaction_session_timeout: readBoundedInteger(
      env.POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS,
      DEFAULTS.idleTransactionTimeoutMillis,
      100,
      60000
    )
  };
}

function createPostgresPool(connectionString, options = {}) {
  const { Pool } = require('pg');
  const env = options.env || process.env;
  const poolOptions = buildPostgresPoolOptions(connectionString, env);

  if (options.max !== undefined) {
    poolOptions.max = options.max;
  }

  const pool = new Pool(poolOptions);
  const logger = options.logger || console;

  pool.on('error', (error) => {
    logger.error('[postgres-pool] idle client error', {
      code: error?.code || 'UNKNOWN',
      name: error?.name || 'Error'
    });
  });

  return pool;
}

module.exports = {
  buildPostgresPoolOptions,
  createPostgresPool,
  normalizeConnectionString,
  readBoundedInteger
};
