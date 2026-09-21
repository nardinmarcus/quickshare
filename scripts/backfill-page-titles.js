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

/**
 * One scan pass over Shares whose title is missing or still the raw id.
 * --write goes through the same conditional content protocol as any owner
 * edit: it reads the live content baseline in the publishing transaction and
 * lets the repository create the next immutable snapshot, so a title backfill
 * can never bypass Revision history. Shares whose baseline moved mid-run are
 * reported as conflicts and left for the next invocation.
 */
async function backfillTitles(transactionOrRepository, options) {
  const rows = await transactionOrRepository.listPagesNeedingTitleBackfill(options.limit);
  const output = [];
  let changed = 0;
  let conflicts = 0;

  for (const page of rows) {
    const nextTitle = derivePageTitle(
      page.html_content,
      page.code_type || 'html',
      null,
      Number(page.created_at) || Date.now()
    );

    if (!nextTitle || nextTitle === page.title) {
      continue;
    }

    if (!options.write) {
      output.push(`dry-run ${page.id}: ${nextTitle}`);
      changed += 1;
      continue;
    }

    const current = await transactionOrRepository.getById(page.id);
    if (!current) {
      continue;
    }

    try {
      await transactionOrRepository.updatePage(page.id, {
        title: nextTitle,
        expectedContentRevision: String(current.current_revision),
        // Content revisions need row-level provenance: a maintenance title
        // backfill is its own write path, not an owner dashboard edit.
        actorSource: 'title-backfill',
        actorIdentity: 'maintenance:title-backfill'
      });
      output.push(`update ${page.id}: ${nextTitle}`);
      changed += 1;
    } catch (error) {
      if (error.code === 'CONTENT_REVISION_CONFLICT') {
        conflicts += 1;
        continue;
      }
      throw error;
    }
  }

  output.push(`${options.write ? 'updated' : 'would update'} ${changed} of ${rows.length} scanned pages`);
  if (conflicts > 0) {
    output.push(`${conflicts} page(s) changed during the run; rerun to retry`);
  }
  return { output, scanned: rows.length, changed, conflicts, done: rows.length < options.limit };
}

async function runTitleBackfill(repository, options) {
  if (!options.write) {
    return backfillTitles(repository, options);
  }
  const result = await createPublishing(repository).run(async transaction => {
    let aggregated = { output: [], scanned: 0, changed: 0, conflicts: 0, done: false };
    while (!aggregated.done) {
      const pass = await backfillTitles(transaction, options);
      aggregated.output.push(...pass.output);
      aggregated.scanned += pass.scanned;
      aggregated.changed += pass.changed;
      aggregated.conflicts += pass.conflicts;
      aggregated.done = pass.done;
    }
    return aggregated;
  });
  return result;
}

async function main({ repository, argv = process.argv.slice(2), log = console.log } = {}) {
  const options = parseArgs(argv);
  let ownRepository = false;
  let repo = repository;

  if (!repo) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL or POSTGRES_URL is required');
    }
    repo = new PostgresPageRepository(connectionString, { ...process.env, POSTGRES_POOL_MAX: '1' });
    ownRepository = true;
  }

  try {
    const result = await runTitleBackfill(repo, options);
    result.output.forEach(line => log(line));
    return result;
  } finally {
    if (ownRepository) await repo.pool.end();
  }
}

if (require.main === module) {
  main({ log: console.log }).catch(error => {
    console.error(error.code === 'PUBLISHING_MAINTENANCE' ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

module.exports = { backfillTitles, parseArgs, runTitleBackfill, main };
