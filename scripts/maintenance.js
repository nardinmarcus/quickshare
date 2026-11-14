#!/usr/bin/env node
'use strict';

// Controlled operator switch for publishing write maintenance (T04,
// issue #28). This is the ONLY supported way to change
// `publishing_writes_paused`; there is deliberately no end-user or admin-UI
// setting for it.
//
//   node scripts/maintenance.js status
//   node scripts/maintenance.js pause    [--ip <operator-ip>]
//   node scripts/maintenance.js resume   [--ip <operator-ip>]
//
// `pause` takes the maintenance gate exclusively and waits until every
// in-flight publishing transaction has finished (drained) before it
// returns; a successful pause therefore means no earlier write can still
// commit. While paused, publishing writes are refused with a maintenance
// 503 and view events are not counted; reads and login stay available.
// See docs/maintenance.md for the full release procedure.
//
// Requires DATABASE_URL (or POSTGRES_URL) and migration 005 applied
// (`npm run db:migrate`).

require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');
const {
  getPublishingWritesPaused,
  setPublishingWritesPaused
} = require('../models/publishing');
const { parseArgs } = require('./backup-lib');

const COMMANDS = new Set(['status', 'pause', 'resume']);

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!COMMANDS.has(command)) {
    throw new Error('Usage: node scripts/maintenance.js <status|pause|resume> [--ip <ip>]');
  }

  const options = parseArgs(rest, {
    ip: { type: 'string' }
  });
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const pool = createPostgresPool(connectionString, { max: 1 });

  try {
    if (command === 'status') {
      const paused = await getPublishingWritesPaused(pool);
      console.log(JSON.stringify({ ok: true, command, publishingWritesPaused: paused }));
      return;
    }

    const startedAt = Date.now();
    const result = await setPublishingWritesPaused(pool, {
      paused: command === 'pause',
      ip: options.ip || 'maintenance-cli'
    });

    console.log(JSON.stringify({
      ok: true,
      command,
      publishingWritesPaused: result.paused,
      changed: result.changed,
      // For `pause` this includes the drain wait: the command only returns
      // once every in-flight publishing transaction has ended.
      durationMs: Date.now() - startedAt
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  if (error && error.code === '42703') {
    console.error('[maintenance] failed: site_settings.publishing_writes_paused is missing; run `npm run db:migrate` first');
  } else {
    console.error(`[maintenance] failed: ${error.message}`);
  }

  process.exitCode = 1;
});
