#!/usr/bin/env node
require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');
const { runMigrations } = require('../models/postgres-migrations');

async function main() {
  const connectionString = process.env.DATABASE_MIGRATION_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING
    || process.env.DATABASE_URL
    || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('A direct migration URL or DATABASE_URL is required');
  }

  const pool = createPostgresPool(connectionString, { max: 1 });

  try {
    const result = await runMigrations(pool);
    console.log(`[db:migrate] complete: ${result.applied.length} applied, ${result.skipped.length} skipped`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[db:migrate] failed: ${error.message}`);
  process.exitCode = 1;
});
