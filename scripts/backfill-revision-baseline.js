#!/usr/bin/env node
'use strict';

// Operator entry for the Share content-Revision baseline backfill (T06,
// issue #30; parent spec issue #24 §11 step 4).
//
//   node scripts/backfill-revision-baseline.js
//
// Preconditions, in order (see docs/content-revision-rollout.md):
//   1. migration 007 applied (`npm run db:migrate`);
//   2. publishing writes paused and drained
//      (`npm run db:maintenance -- pause`) — this script verifies the
//      paused flag itself and refuses to run outside the window; it
//      never pauses or resumes the instance;
//   3. after a successful run, deploy the revision-aware write protocol
//      and only then resume writes (`npm run db:maintenance -- resume`).
//
// The run gives every pre-existing Share a Revision 1 baseline capturing
// its current body and presentation fields exactly, preserving IDs and
// URLs. It is idempotent: a second run baselines nothing.
//
// Requires DATABASE_URL (or POSTGRES_URL).

require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');
const { runBaselineBackfill } = require('./revision-baseline-lib');
const { parseArgs } = require('./backup-lib');

async function main() {
  parseArgs(process.argv.slice(2), {});
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const pool = createPostgresPool(connectionString, { max: 1 });

  try {
    const startedAt = Date.now();
    const result = await runBaselineBackfill(pool, { now: startedAt });
    console.log(JSON.stringify({
      ok: true,
      command: 'backfill-revision-baseline',
      baselined: result.baselined,
      skipped: result.skipped,
      capturedAt: result.capturedAt,
      durationMs: Date.now() - startedAt
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[db:backfill-revisions] failed: ${error.message}`);
  process.exitCode = 1;
});
