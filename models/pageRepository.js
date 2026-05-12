function createPageRepository() {
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
    const { PostgresPageRepository } = require('./postgres-pages');
    return new PostgresPageRepository(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  }

  const { MemoryPageRepository } = require('./memory-pages');
  return new MemoryPageRepository();
}

module.exports = {
  createPageRepository
};
