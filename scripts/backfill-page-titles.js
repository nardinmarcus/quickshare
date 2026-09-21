#!/usr/bin/env node
require('dotenv').config();

const { PostgresPageRepository } = require('../models/postgres-pages');
const { createPublishing } = require('../models/publishing');
const { derivePageTitle } = require('../utils/pageTitle');

function parseArgs(argv) {
  const options = {
    write: false,
    limit: 200
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--write') {
      options.write = true;
    } else if (value === '--limit') {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const repository = new PostgresPageRepository(connectionString, { ...process.env, POSTGRES_POOL_MAX: '1' });

  try {
    const backfill = async (transaction) => {
      const result = await transaction.pool.query(
        `
          SELECT id, html_content, code_type, title, created_at
          FROM pages
          WHERE title IS NULL OR title = '' OR title = id
          ORDER BY created_at DESC
          LIMIT $1
        `,
        [options.limit]
      );

      let changed = 0;
      const output = [];

      for (const page of result.rows) {
        const nextTitle = derivePageTitle(
          page.html_content,
          page.code_type || 'html',
          null,
          Number(page.created_at) || Date.now()
        );

        if (!nextTitle || nextTitle === page.title) {
          continue;
        }

        changed += 1;
        output.push(`${options.write ? 'update' : 'dry-run'} ${page.id}: ${nextTitle}`);

        if (options.write) {
          await transaction.updatePage(page.id, { title: nextTitle });
        }
      }

      output.push(`${options.write ? 'updated' : 'would update'} ${changed} of ${result.rows.length} scanned pages`);
      return output;
    };
    const output = options.write
      ? await createPublishing(repository).run(backfill)
      : await backfill(repository);
    output.forEach(line => console.log(line));
  } finally {
    await repository.pool.end();
  }
}

main().catch(error => {
  console.error(error.code === 'PUBLISHING_MAINTENANCE' ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
});
