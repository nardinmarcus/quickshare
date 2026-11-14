#!/usr/bin/env node
'use strict';

// Verify that a database restored from a QuickShare full backup matches the
// backup manifest (T03, issue #27): migration ledger, every table and row
// digest (bodies, IDs, themes, favorites, expiry, access_revision), API
// keys, audit log, and site settings. Optionally checks password capability
// for protected Shares when the operator supplies known plaintext fixtures
// via --passwords (a JSON file mapping page id -> plaintext); decryption of
// the stored password echo additionally needs the runtime SESSION_SECRET in
// the environment, which is stored separately from the backup on purpose.
//
// The report always carries safeToServe: false. A restored snapshot never
// regains serving permission from verification alone: revocations and
// history clears that happened after the restore point are not visible in
// the snapshot, and legacy protect writes predate audit coverage, so an
// empty revocation list cannot prove none happened.
//
// Usage:
//   node scripts/verify-backup.js --input-dir ./backup-2026-01-01 --database-url postgres://user:pass@127.0.0.1:5432/quickshare_restore_test [--passwords ./passwords.json] [--report ./verify-report.json]
//
// Exit code 0 means every integrity check passed; safeToServe is reported
// separately and is not part of the exit code.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createPostgresPool } = require('../models/postgres-config');
const { isValidScryptHash, verifySecret, decryptSecret } = require('../utils/security');
const {
  assertIsolatedDatabaseUrl,
  collectSnapshot,
  compareSnapshots,
  detectAccessRevocations,
  evaluateRevisionIntegrity,
  parseArgs
} = require('./backup-lib');

async function evaluatePasswordCapability(pageRows, passwordFixtures) {
  const protectedPages = pageRows.filter(row => Number(row.is_protected) === 1);
  const structuralFailures = [];

  for (const row of protectedPages) {
    if (!isValidScryptHash(row.password_hash)) {
      structuralFailures.push(`pages ${row.id}: password hash missing or not a valid scrypt hash after restore`);
    }

    if (typeof row.encrypted_password !== 'string' || row.encrypted_password.length === 0) {
      structuralFailures.push(`pages ${row.id}: encrypted password echo missing after restore`);
    }
  }

  const fixtureIds = Object.keys(passwordFixtures || {});
  const fixtureFailures = [];
  let plaintextVerified = 0;

  for (const pageId of fixtureIds) {
    const row = protectedPages.find(candidate => candidate.id === pageId);

    if (!row) {
      fixtureFailures.push(`password fixture references unknown or unprotected page ${pageId}`);
      continue;
    }

    const plaintext = passwordFixtures[pageId];
    const hashOk = await verifySecret(plaintext, row.password_hash);
    let echoOk = false;

    try {
      echoOk = decryptSecret(row.encrypted_password) === plaintext;
    } catch (error) {
      echoOk = false;
    }

    if (hashOk && echoOk) {
      plaintextVerified += 1;
    } else {
      fixtureFailures.push(
        `pages ${pageId}: password capability check failed (hash ${hashOk ? 'ok' : 'mismatch'}, echo ${echoOk ? 'ok' : 'mismatch'})`
      );
    }
  }

  let status = 'structural-only';

  if (fixtureIds.length > 0 && plaintextVerified === protectedPages.length && fixtureFailures.length === 0) {
    status = 'verified';
  } else if (plaintextVerified > 0) {
    status = 'partial';
  }

  return {
    protectedPages: protectedPages.length,
    plaintextVerified,
    status,
    failures: [...structuralFailures, ...fixtureFailures]
  };
}

function buildReport({ manifest, receipt, snapshot, pageRows, auditRows, revisionRows, passwordCapability, verifyDurationMs }) {
  const failures = compareSnapshots(manifest.snapshot, snapshot);
  failures.push(...evaluateRevisionIntegrity(pageRows, revisionRows || []));
  failures.push(...passwordCapability.failures);

  const revocations = detectAccessRevocations(auditRows);

  return {
    ok: failures.length === 0,
    checkedAt: Date.now(),
    restorePoint: manifest.restorePoint,
    backupDurationMs: manifest.backupDurationMs,
    restoreDurationMs: receipt ? receipt.restoreDurationMs : null,
    verifyDurationMs,
    source: manifest.source,
    tables: snapshot.tables,
    counts: snapshot.counts,
    ledger: snapshot.ledger.map(row => row.version),
    passwordCapability: {
      protectedPages: passwordCapability.protectedPages,
      plaintextVerified: passwordCapability.plaintextVerified,
      status: passwordCapability.status
    },
    contentRevisions: {
      tracked: Boolean(snapshot.pages && snapshot.pages.hasContentRevision),
      snapshots: (revisionRows || []).length,
      // Tombstones (T10): purged snapshots whose payload stayed purged.
      // The count is informational; the purge-shape rules themselves
      // are enforced by the integrity evaluation above.
      purgedSnapshots: (revisionRows || []).filter(
        row => row.purged_at !== null && row.purged_at !== undefined
      ).length,
      sharesWithBaseline: (pageRows || []).filter(
        row => row.current_revision !== null && row.current_revision !== undefined
      ).length
    },
    revocations: {
      detected: revocations,
      historyComplete: false,
      note: 'Detected events are the revocations recorded at or before the restore point. Revocations or clears after the restore point are not in the snapshot and cannot be verified from it; legacy protect writes also predate audit coverage, so an empty list does not prove no revocation happened.'
    },
    safeToServe: false,
    safeToServeReasons: [
      'A restored snapshot does not carry serving permission; it stays offline by default.',
      'Revocations and history clears after the restore point cannot be verified from the backup.',
      'The owner must re-enable restored Shares and managed Keys item by item after review.'
    ],
    failures
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    inputDir: { type: 'string', required: true },
    databaseUrl: { type: 'string', required: true },
    passwords: { type: 'string' },
    report: { type: 'string' },
    allowNonTest: { type: 'boolean' }
  });

  assertIsolatedDatabaseUrl(options.databaseUrl, {
    allowNonTest: options.allowNonTest,
    purpose: 'verification target database'
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(options.inputDir, 'manifest.json'), 'utf8')
  );

  if (manifest.format !== 'quickshare-full-backup') {
    throw new Error('manifest.json is not a quickshare-full-backup manifest');
  }

  const receiptPath = path.join(options.inputDir, 'restore-receipt.json');
  const receipt = fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    : null;

  const passwordFixtures = options.passwords
    ? JSON.parse(fs.readFileSync(options.passwords, 'utf8'))
    : {};

  const pool = createPostgresPool(options.databaseUrl, { max: 1 });
  const verifyStartedAt = Date.now();

  try {
    const { snapshot, pageRows, auditRows, revisionRows } = await collectSnapshot(
      (text, params) => pool.query(text, params)
    );
    const passwordCapability = await evaluatePasswordCapability(pageRows, passwordFixtures);
    const report = buildReport({
      manifest,
      receipt,
      snapshot,
      pageRows,
      auditRows,
      revisionRows,
      passwordCapability,
      verifyDurationMs: Date.now() - verifyStartedAt
    });

    if (options.report) {
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }

    console.log(JSON.stringify(report, null, 2));

    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[db:verify-backup] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildReport, evaluatePasswordCapability };
