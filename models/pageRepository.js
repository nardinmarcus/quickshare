function createPageRepository(env = process.env) {
  if (env.NODE_ENV === 'test') {
    const { MemoryPageRepository } = require('./memory-pages');
    return new MemoryPageRepository();
  }

  const connectionString = env.DATABASE_URL || env.POSTGRES_URL;

  if (connectionString) {
    const { PostgresPageRepository } = require('./postgres-pages');
    return new PostgresPageRepository(connectionString, env);
  }

  const isVercelProduction = env.VERCEL_ENV === 'production';
  const isStandaloneProduction = env.NODE_ENV === 'production' && !env.VERCEL_ENV;

  if (isVercelProduction || isStandaloneProduction) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required in production');
  }

  const { MemoryPageRepository } = require('./memory-pages');
  return new MemoryPageRepository();
}

module.exports = {
  createPageRepository
};
