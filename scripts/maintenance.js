#!/usr/bin/env node
// Operator-only process: never loads .env or falls back to a detached memory store.
const { PostgresPageRepository } = require('../models/postgres-pages');

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (!['pause', 'resume', 'status'].includes(action) || extra.length) {
    throw new Error('Usage: npm run maintenance -- pause|resume|status');
  }
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) throw new Error('Explicit DATABASE_MIGRATION_URL is required; memory mode cannot control another process');
  const repository = new PostgresPageRepository(connectionString);
  try {
    const result = action === 'status'
      ? { publishingWritesPaused: await repository.getPublishingWritesPaused() }
      : await repository.setPublishingWritesPaused(action === 'pause');
    console.log(JSON.stringify({ action, ...result }));
  } finally {
    await repository.pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Do not print pg errors, connection strings, credentials, or SQL values.
    const usage = /^(Usage:|Explicit DATABASE_MIGRATION_URL)/.test(error.message);
    console.error(usage ? error.message : 'Maintenance operation failed; pause/drain is NOT confirmed. Keep writers isolated and investigate.');
    process.exitCode = 1;
  });
}
