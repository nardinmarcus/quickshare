#!/usr/bin/env node
/*
 * Controlled baseline backfill for Share content revisions (#30).
 *
 * This is the dedicated baseline-window write required by parent #24 §11:
 * it runs AFTER the additive migration 007 and only while the publishing
 * maintenance gate is live-paused on the SAME transaction it writes through.
 * It never pauses or resumes anything, never runs DDL, and never touches
 * published state — it only inserts the missing Revision 1 snapshot with the
 * Share's original ID, URL path, body and title.
 *
 * dry-run (default): read-only report; does not require the pause.
 * --write:           requires DATABASE_URL/POSTGRES_URL and refuses to write
 *                    unless publishing_writes_paused is TRUE on the same
 *                    client transaction (allowPaused only bypasses the
 *                    rejection in the publishing interface; it is not proof
 *                    of a paused database — this script checks the live value).
 *
 * Repeat runs are safe: Shares that already have Revision 1 are skipped.
 */
require('dotenv').config();

const { PostgresPageRepository } = require('../models/postgres-pages');
const { createPublishing } = require('../models/publishing');

function baselineWindowError() {
  return Object.assign(new Error(
    'Baseline backfill requires an active write-maintenance window: pause first, prove old writers are drained, then run --write'
  ), { code: 'BASELINE_WINDOW_REQUIRED' });
}

function parseArgs(argv) {
  const options = { write: false, limit: 200 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--write') {
      options.write = true;
    } else if (value === '--limit') {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return options;
}

function revisionOneInput(row, capturedAt) {
  return {
    id: row.id,
    htmlContent: row.html_content,
    codeType: row.code_type || 'html',
    title: row.title,
    description: row.description,
    markdownTheme: row.markdown_theme,
    // The baseline row records the ACTUAL controlled capture moment; the
    // Share's original creation time stays untouched on pages.created_at.
    // The upgrade must never dress today's body up as a snapshot that existed
    // since the Share was created, and earlier history is never guessed.
    createdAt: capturedAt
  };
}

/**
 * One scan pass. In write mode it runs inside the publishing transaction with
 * the maintenance gate held on the same client, so the pause reading is live.
 * Returns { output, done } — done means no further batches are required.
 */
async function backfillRevisions(transactionOrRepository, { write, limit }) {
  const rows = await transactionOrRepository.listPagesMissingBaselineRevision(limit);
  const output = [];
  let backfilled = 0;
  let skipped = 0;
  const inconsistent = [];
  const capturedAt = Date.now();

  for (const row of rows) {
    if (String(row.current_revision) !== '1') {
      // A missing baseline with a moved pointer means someone wrote through an
      // unknown path; never guess history for it.
      inconsistent.push(`${row.id} (current_revision=${row.current_revision})`);
      continue;
    }
    if (!write) {
      output.push(`dry-run ${row.id}: would backfill Revision 1`);
      backfilled += 1;
      continue;
    }
    const created = await transactionOrRepository.createBaselineRevision(revisionOneInput(row, capturedAt));
    if (created) {
      await transactionOrRepository.createAuditLog({
        action: 'page.revision.backfill',
        pageId: row.id,
        details: JSON.stringify({ revision: '1', capturedAt }),
        ip: null
      });
      output.push(`backfill ${row.id}: Revision 1 written`);
      backfilled += 1;
    } else {
      output.push(`skipped ${row.id}: Revision 1 already present`);
      skipped += 1;
    }
  }

  if (inconsistent.length > 0) {
    throw Object.assign(new Error(
      `Refusing to guess history for ${inconsistent.length} Share(s) with moved revision pointers: ${inconsistent.slice(0, 5).join(', ')}`
    ), { code: 'BASELINE_INCONSISTENT', inconsistent });
  }

  if (rows.length === 0) {
    output.push('no Shares are missing Revision 1');
  }
  output.push(`${write ? 'backfilled' : 'would backfill'} ${backfilled} of ${rows.length} scanned Shares`);
  return { output, scanned: rows.length, backfilled, skipped: rows.length - backfilled, done: rows.length < limit };
}

async function runBackfill(repository, options) {
  if (!options.write) {
    // Read-only report; no gate required and nothing is written.
    return backfillRevisions(repository, options);
  }
  const result = await createPublishing(repository).run(async transaction => {
    // allowPaused above only bypasses the publishing rejection; the live
    // setting read on THIS transaction is the paused evidence.
    if (transaction.publishingWritesPaused !== true) {
      throw baselineWindowError();
    }
    let aggregated = { output: [], scanned: 0, backfilled: 0, skipped: 0, done: false };
    while (!aggregated.done) {
      const pass = await backfillRevisions(transaction, options);
      aggregated.output.push(...pass.output);
      aggregated.scanned += pass.scanned;
      aggregated.backfilled += pass.backfilled;
      aggregated.skipped += pass.skipped;
      aggregated.done = pass.done;
    }
    return aggregated;
  }, { allowPaused: true });
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
    const result = await runBackfill(repo, options);
    result.output.forEach(line => log(line));
    return result;
  } finally {
    if (ownRepository) await repo.pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Do not print connection strings or SQL values.
    console.error(error.code === 'BASELINE_WINDOW_REQUIRED' || error.code === 'BASELINE_INCONSISTENT'
      ? `${error.code}: ${error.message}`
      : error.message);
    process.exitCode = 1;
  });
}

module.exports = { baselineWindowError, backfillRevisions, parseArgs, revisionOneInput, runBackfill, main };
