#!/usr/bin/env node
require('dotenv').config();

const { Pool } = require('pg');
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

  const pool = new Pool({
    connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 1
  });

  try {
    const result = await pool.query(
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
      console.log(`${options.write ? 'update' : 'dry-run'} ${page.id}: ${nextTitle}`);

      if (options.write) {
        await pool.query('UPDATE pages SET title = $1 WHERE id = $2', [nextTitle, page.id]);
      }
    }

    console.log(`${options.write ? 'updated' : 'would update'} ${changed} of ${result.rows.length} scanned pages`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
