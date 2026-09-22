#!/usr/bin/env node
'use strict';

/*
 * Post-restore verification for QuickShare native backups.
 *
 * Connects to the source and restored databases with two independent
 * connections and verifies that the restore actually preserved:
 * content hashes, page IDs, full page rows, Markdown themes, Favorite Share
 * state, password hash verification AND decrypt/display ability, expiry,
 * managed API keys, audit logs, site settings and the migration ledger.
 *
 * Fail-closed semantics:
 * - The report always marks the restored database `safeToServe: false` and
 *   `offline-by-default`; this script never "re-enables" anything.
 * - Revocation/purge audit events recorded after the backup snapshot point
 *   leave reconciliation `unreconciled` and exit code 2 until the operator
 *   passes `--reconciled` after a manual owner review.
 * - Any data mismatch exits 1.
 *
 * Secrets: pass only synthetic fixture secrets in tests. Real secrets and
 * encryption material stay private and never enter manifests, logs or issues.
 */

const fs = require('fs');

const { createPostgresPool } = require('../models/postgres-config');
const { loadMigrations } = require('../models/postgres-migrations');
const { decryptSecret, verifySecret } = require('../utils/security');

const {
  assertTestDatabaseUrl,
  localPoolEnv,
  parseCliArgs,
  redactUrl
} = require('./backup-db');

const API_KEY_COMPARED_COLUMNS = Object.freeze([
  'id', 'name', 'key_hash', 'key_prefix', 'created_at', 'last_used_at', 'credential_version'
]);

const HARD_REVOCATION_AUDIT_ACTIONS = new Set([
  'page.delete',
  'page.delete.batch',
  'page.revision.purge',
  'api_key.delete',
  'api_key.rotate'
]);

// Policy-relevant field names emitted in page.update audit details as
// `JSON.stringify({ fields: Object.keys(updateOptions) })` (app.js). Password
// and protection changes are the main post-snapshot revocation vector; a
// forward-compatible `revokeAccess` field name is included for later tickets.
const POLICY_FIELD_NAMES = new Set([
  'isProtected',
  'passwordHash',
  'encryptedPassword',
  'expiresAt',
  'revokeAccess'
]);

const COVERED_OBJECTS = [
  'page-content-hashes',
  'page-ids',
  'page-full-rows',
  'markdown-themes',
  'favorite-share',
  'share-revisions',
  'revision-purge-tombstones',
  'revision-current-pointer',
  'password-verify-and-decrypt',
  'expiry',
  'managed-api-keys',
  'audit-logs',
  'publish-operations',
  'operation-receipt-purges',
  'site-settings',
  'migration-ledger'
];

const REVISION_COMPARED_COLUMNS = Object.freeze([
  'share_id', 'revision', 'html_content', 'code_type', 'title', 'description', 'markdown_theme', 'created_at',
  'snapshot_hash', 'source', 'actor', 'restored_from', 'purged_at'
]);

const POINTER_CONTENT_COLUMNS = Object.freeze([
  'html_content', 'code_type', 'title', 'description', 'markdown_theme'
]);

// Publish operation records (#32): every column including the encrypted
// receipt travels byte-identically; deleted-at tombstones restore as
// tombstones. #34 adds purged_at: the receipt-scrub moment for operations
// whose committed result was purged. Rows are keyed by
// (actor_namespace, request_id).
const OPERATION_COMPARED_COLUMNS = Object.freeze([
  'actor_namespace', 'request_id', 'action', 'request_digest', 'target_id',
  'result_share_id', 'result_revision', 'result_access_revision',
  'receipt_encrypted', 'created_at', 'deleted_at', 'purged_at'
]);

function sha256Hex(value) {
  return require('crypto').createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function valuesEqual(left, right) {
  return left === right || (left === null && right === null) || (left === undefined && right === undefined);
}

/**
 * Compares every page column between source and restored rows, keyed by ID.
 * Content drift is reported with per-side SHA-256 digests so the failure
 * message itself is evidence. comparedColumns is emitted so a future schema
 * extension (e.g. a new persistent column from a later migration) is covered
 * explicitly by full-row comparison instead of silently ignored.
 */
function comparePageInventory(sourceRows, restoreRows) {
  const sourceById = new Map(sourceRows.map(row => [row.id, row]));
  const restoreById = new Map(restoreRows.map(row => [row.id, row]));
  const issues = [];
  const contentHashes = new Map();

  for (const row of sourceRows) {
    if (!restoreById.has(row.id)) {
      issues.push({ field: 'id', pageId: row.id, message: `missing page ${row.id} on restore side` });
    }
  }
  for (const row of restoreRows) {
    if (!sourceById.has(row.id)) {
      issues.push({ field: 'id', pageId: row.id, message: `unexpected page ${row.id} on restore side` });
    }
  }

  const comparedColumns = [...new Set([
    ...Object.keys(sourceRows[0] || {}),
    ...Object.keys(restoreRows[0] || {})
  ])].sort();

  for (const [id, sourceRow] of sourceById) {
    const restoreRow = restoreById.get(id);

    if (!restoreRow) {
      continue;
    }

    for (const column of comparedColumns) {
      if (valuesEqual(sourceRow[column], restoreRow[column])) {
        continue;
      }

      if (column === 'html_content') {
        const sourceSha = sha256Hex(sourceRow[column] ?? '');
        const restoreSha = sha256Hex(restoreRow[column] ?? '');
        issues.push({
          field: column,
          pageId: id,
          message: `html_content sha256 drift for ${id}: source ${sourceSha}, restore ${restoreSha}`
        });
      } else {
        issues.push({
          field: column,
          pageId: id,
          message: `${column} drift for ${id}: source ${JSON.stringify(sourceRow[column])}, restore ${JSON.stringify(restoreRow[column])}`
        });
      }
    }

    contentHashes.set(id, sha256Hex(restoreRow.html_content ?? ''));
  }

  return {
    ok: issues.length === 0,
    issues,
    contentHashes,
    comparedColumns
  };
}

/**
 * Field-specific comparison of the immutable snapshot inventory, keyed by
 * (share_id, revision). A tampered snapshot is reported with its field and
 * exact share/revision — never folded into a generic mismatch.
 *
 * #34 tombstone semantics: a row with a non-NULL purged_at is a purge
 * tombstone. Its payload columns AND snapshot_hash must be NULL — a
 * "restored" backup that resurrects any payload byte on a tombstone fails
 * here. Conversely a live row (purged_at NULL) must still carry string
 * payload bytes. Tombstone rows are compared on identity/provenance only,
 * never treated as missing or recomputed from live content.
 */
function compareRevisionInventory(sourceRows, restoreRows) {
  const keyOf = row => `${row.share_id}:${row.revision}`;
  const sourceByKey = new Map(sourceRows.map(row => [keyOf(row), row]));
  const restoreByKey = new Map(restoreRows.map(row => [keyOf(row), row]));
  const issues = [];

  const isTombstone = row => row.purged_at !== null && row.purged_at !== undefined;
  const PURGEABLE_COLUMNS = ['html_content', 'title', 'description', 'markdown_theme', 'snapshot_hash'];

  for (const side of [[sourceRows, 'source'], [restoreRows, 'restore']]) {
    for (const row of side[0]) {
      if (isTombstone(row)) {
        for (const column of PURGEABLE_COLUMNS) {
          if (row[column] !== null) {
            issues.push({
              field: column,
              shareId: row.share_id,
              revision: String(row.revision),
              message: `tombstone ${keyOf(row)} on ${side[1]} side still carries ${column}; a purge tombstone must not retain payload bytes`
            });
          }
        }
      } else if (typeof row.html_content !== 'string') {
        issues.push({
          field: 'html_content',
          shareId: row.share_id,
          revision: String(row.revision),
          message: `live snapshot ${keyOf(row)} on ${side[1]} side has no payload bytes; NULL payload without purged_at is invalid`
        });
      }
    }
  }

  for (const [key, sourceRow] of sourceByKey) {
    const restoreRow = restoreByKey.get(key);
    if (!restoreRow) {
      issues.push({ field: 'revision', shareId: sourceRow.share_id, revision: String(sourceRow.revision), message: `missing snapshot ${key} on restore side` });
      continue;
    }
    for (const column of REVISION_COMPARED_COLUMNS) {
      if (valuesEqual(sourceRow[column], restoreRow[column])) continue;
      issues.push({
        field: column,
        shareId: sourceRow.share_id,
        revision: String(sourceRow.revision),
        message: `snapshot ${column} drift for ${key}: source ${JSON.stringify(sourceRow[column])}, restore ${JSON.stringify(restoreRow[column])}`
      });
    }
  }
  for (const [key, restoreRow] of restoreByKey) {
    if (!sourceByKey.has(key)) {
      issues.push({ field: 'revision', shareId: restoreRow.share_id, revision: String(restoreRow.revision), message: `unexpected snapshot ${key} on restore side` });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    comparedColumns: REVISION_COMPARED_COLUMNS,
    details: {
      tombstoneCount: restoreRows.filter(isTombstone).length,
      liveCount: restoreRows.length - restoreRows.filter(isTombstone).length
    }
  };
}

/**
 * Current-pointer consistency: every page's current_revision must exist as a
 * snapshot whose content exactly matches the materialized projection, and
 * published must be a real boolean. Runs per database side.
 */
function verifyRevisionPointers(pages) {
  const issues = [];
  const byKey = new Map();
  return function check(revisions) {
    byKey.clear();
    for (const row of revisions) byKey.set(`${row.share_id}:${row.revision}`, row);
    for (const page of pages) {
      const pointer = page.current_revision === null || page.current_revision === undefined ? null : String(page.current_revision);
      if (pointer === null) {
        issues.push({ field: 'current_revision', pageId: page.id, message: `page ${page.id} is missing current_revision` });
        continue;
      }
      const snapshot = byKey.get(`${page.id}:${pointer}`);
      if (!snapshot) {
        issues.push({ field: 'current_revision', pageId: page.id, message: `current_revision ${pointer} for ${page.id} has no snapshot row` });
        continue;
      }
      for (const column of POINTER_CONTENT_COLUMNS) {
        const snapshotValue = snapshot[column] === undefined ? null : snapshot[column];
        const projectionValue = page[column] === undefined ? null : page[column];
        if (valuesEqual(snapshotValue, projectionValue)) continue;
        issues.push({
          field: column,
          pageId: page.id,
          message: `snapshot/projection ${column} drift for ${page.id}@${pointer}: snapshot ${JSON.stringify(snapshotValue)}, projection ${JSON.stringify(projectionValue)}`
        });
      }
      if (typeof page.published !== 'boolean') {
        issues.push({ field: 'published', pageId: page.id, message: `published must be a boolean for ${page.id}` });
      }
    }
    return { ok: issues.length === 0, issues, details: { pages: pages.length, snapshots: revisions.length } };
  };
}

function verifyMigrationLedger(appliedRows, localMigrations) {
  const appliedByVersion = new Map(appliedRows.map(row => [row.version, row]));
  const localByVersion = new Map(localMigrations.map(migration => [migration.version, migration]));
  const issues = [];

  for (const migration of localMigrations) {
    const applied = appliedByVersion.get(migration.version);

    if (!applied) {
      issues.push({ field: 'version', message: `missing migration ${migration.version} in restored ledger` });
      continue;
    }

    if (applied.checksum !== migration.checksum) {
      issues.push({ field: 'checksum', message: `checksum mismatch for migration ${migration.version}: ` +
        `expected ${migration.checksum}, found ${applied.checksum}` });
    }
  }

  for (const applied of appliedRows) {
    if (!localByVersion.has(applied.version)) {
      issues.push({ field: 'version', message: `unknown applied migration ${applied.version} ` +
        'not present in db/migrations; extend the verification fixture before trusting this restore' });
    }
  }

  return { ok: issues.length === 0, issues };
}

function parseAuditFields(details) {
  try {
    const parsed = JSON.parse(details || 'null');
    return Array.isArray(parsed?.fields) ? parsed.fields.filter(name => typeof name === 'string') : null;
  } catch (error) {
    return null;
  }
}

/**
 * Detects revocation-relevant audit events recorded AFTER the snapshot point,
 * using the vocabulary the application actually emits: hard purges plus
 * `page.update` entries whose `details.fields` touch password, protection,
 * expiry or revocation state. Events at or before the snapshot are part of the
 * backed-up history and never reported. Returning an empty list is NOT proof
 * that nothing happened (some policy routes emit no audit rows) — coverage
 * classification in buildVerificationReport handles that honestly.
 */
function findPostSnapshotRevocations(auditRows, snapshotAt) {
  const events = [];

  for (const row of auditRows) {
    if (Number(row.created_at) <= Number(snapshotAt)) {
      continue;
    }

    if (HARD_REVOCATION_AUDIT_ACTIONS.has(row.action)) {
      events.push({ action: row.action, pageId: row.page_id || null, fields: null, createdAt: Number(row.created_at) });
      continue;
    }

    if (row.action === 'page.update') {
      const fields = parseAuditFields(row.details);

      if (!fields) {
        continue;
      }

      const policyFields = fields.filter(name => POLICY_FIELD_NAMES.has(name));

      if (policyFields.length > 0) {
        events.push({ action: row.action, pageId: row.page_id || null, fields: policyFields, createdAt: Number(row.created_at) });
      }
    }
  }

  return events;
}

/**
 * Classifies reconciliation need. There is deliberately no 'not-required'
 * outcome: absence of matching audit rows is not proof of absence of policy
 * changes (legacy routes emit no records), so a clean-looking history still
 * requires explicit owner review before anything restored is reused.
 */
function classifyRevocationCoverage(postSnapshotEvents) {
  if (postSnapshotEvents.length > 0) {
    return {
      status: 'unreconciled',
      reason: 'revocations or purges were recorded after the snapshot point; the owner must reconcile them ' +
        'before any restored credential or public content may be considered — the restored database stays offline'
    };
  }

  return {
    status: 'owner-review-required',
    reason: 'no post-snapshot revocation events were found in the audit log, but audit history cannot prove ' +
      'their absence (some policy-change routes emit no audit records); owner review is required ' +
      'before any restored credential or public content is reused'
  };
}

function buildVerificationReport({
  checks,
  durationsMs,
  postSnapshotRevocations,
  manifest,
  target
}) {
  const revocations = postSnapshotRevocations || [];
  const allChecksOk = (checks || []).every(check => check.ok === true);

  return {
    generatedAt: Date.now(),
    // `ok` reports data-level verification only; the reconciliation gate is a
    // separate, always-present decision (see reconciliationExitCode).
    ok: allChecksOk,
    safeToServe: false,
    isolation: 'offline-by-default',
    reconciliation: classifyRevocationCoverage(revocations),
    checks: checks || [],
    durationsMs: durationsMs || {},
    postSnapshotRevocations: revocations,
    coveredObjects: COVERED_OBJECTS,
    manifest: {
      snapshotAt: manifest?.snapshotAt ?? null,
      snapshotWalLsn: manifest?.snapshotWalLsn ?? null,
      database: manifest?.database ?? null,
      dumpSha256: manifest?.dumpSha256 ?? null
    },
    target: target || {}
  };
}

function reconciliationExitCode(report, { reconciled = false } = {}) {
  if (report.checks.some(check => check.ok === false)) {
    return 1;
  }

  // Both reconciliation outcomes fail closed until the operator explicitly
  // acknowledges an owner review with --reconciled.
  if (!reconciled) {
    return 2;
  }

  return 0;
}

function auditProjection(rows) {
  return rows
    .map(row => JSON.stringify([row.action, row.page_id, row.details, row.ip, String(row.created_at)]))
    .sort();
}

function rowsEqual(leftRows, rightRows) {
  return JSON.stringify(leftRows) === JSON.stringify(rightRows);
}

/**
 * Plans and executes the password-side functional verification on restored
 * rows. Protected rows WITHOUT matching fixture material produce an explicit
 * incomplete-coverage issue instead of being silently skipped — the check
 * never reports success for rows it could not actually exercise.
 */
async function planCredentialVerification({ restoredPages, fixture, verifyHash, decrypt }) {
  const issues = [];
  const entriesById = new Map((fixture.protectedPages || []).map(entry => [entry.id, entry]));
  // Verification targets are rows the application treats as protected. Rows
  // WITHOUT the flag that still carry credential material are reported as a
  // restore anomaly by the loop below, not silently skipped.
  const protectedRows = restoredPages.filter(row => Number(row.is_protected) === 1);
  const protectedIds = new Set(protectedRows.map(row => row.id));
  let fixtureCovered = 0;

  for (const row of protectedRows) {
    const entry = entriesById.get(row.id);

    if (!entry) {
      issues.push({
        field: 'password',
        pageId: row.id,
        message: `protected page ${row.id}: incomplete fixture coverage; password verify/decrypt check was NOT performed for this row`
      });
      continue;
    }

    fixtureCovered += 1;

    if (!await verifyHash(entry.password, row.password_hash)) {
      issues.push({ field: 'password', pageId: row.id, message: `password hash does not verify for ${row.id} after restore` });
    }

    if (decrypt(row.encrypted_password) !== entry.password) {
      issues.push({
        field: 'password',
        pageId: row.id,
        message: `encrypted password does not decrypt for ${row.id} ` +
          '(dashboard display ability lost or SESSION_SECRET mismatch)'
      });
    }
  }

  for (const row of restoredPages) {
    if (protectedIds.has(row.id)) {
      continue;
    }

    if (row.password_hash !== null || row.encrypted_password !== null) {
      issues.push({
        field: 'password',
        pageId: row.id,
        message: `unprotected page ${row.id} carries credential material after restore`
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    details: { protectedPages: protectedRows.length, fixtureCovered }
  };
}

/**
 * API-key counterpart of planCredentialVerification: every restored managed
 * key must either be exercised against fixture material or reported as an
 * explicit coverage gap.
 */
async function planApiKeyVerification({ restoredKeys, fixture, verifyHash }) {
  const issues = [];
  const entriesById = new Map((fixture.apiKeys || []).map(entry => [entry.id, entry]));
  let fixtureCovered = 0;

  for (const key of restoredKeys) {
    const entry = entriesById.get(key.id);

    if (!entry) {
      issues.push({
        field: 'api_keys',
        keyId: key.id,
        message: `managed key ${key.id}: incomplete fixture coverage; secret verification was NOT performed for this row`
      });
      continue;
    }

    fixtureCovered += 1;

    if (!await verifyHash(entry.secret, key.key_hash)) {
      issues.push({ field: 'api_keys', keyId: key.id, message: `managed key ${key.id} secret does not verify after restore` });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    details: { keys: restoredKeys.length, fixtureCovered }
  };
}

/**
 * Live verification against two independent database connections.
 * `fixture` carries synthetic-only secrets: { apiKeys: [{id, secret}],
 * protectedPages: [{id, password}] }. SESSION_SECRET must already be set to
 * the synthetic fixture secret so decrypt/display ability can be exercised.
 */
async function runVerification({
  sourceUrl,
  restoreUrl,
  manifest,
  fixture = {},
  allowNonTest
}) {
  assertTestDatabaseUrl(sourceUrl, { allowNonTest });
  assertTestDatabaseUrl(restoreUrl, { allowNonTest });

  const sourcePool = createPostgresPool(sourceUrl, { env: localPoolEnv(sourceUrl), max: 2 });
  const restorePool = createPostgresPool(restoreUrl, { env: localPoolEnv(restoreUrl), max: 2 });
  const checks = [];
  const started = Date.now();

  try {
    // Two independent connections, queried concurrently.
    const [sourcePages, restorePages, sourceRevisions, restoreRevisions, sourceAudit, restoreAudit, sourceKeys, restoreKeys, sourceOperations, restoreOperations, sourceSettings, restoreSettings, sourceLedger, restoreLedger] =
      await Promise.all([
        sourcePool.query('SELECT * FROM pages ORDER BY id ASC'),
        restorePool.query('SELECT * FROM pages ORDER BY id ASC'),
        sourcePool.query(`SELECT ${REVISION_COMPARED_COLUMNS.join(', ')} FROM share_revisions ORDER BY share_id ASC, revision ASC`),
        restorePool.query(`SELECT ${REVISION_COMPARED_COLUMNS.join(', ')} FROM share_revisions ORDER BY share_id ASC, revision ASC`),
        sourcePool.query('SELECT action, page_id, details, ip, created_at FROM audit_logs ORDER BY id ASC'),
        restorePool.query('SELECT action, page_id, details, ip, created_at FROM audit_logs ORDER BY id ASC'),
        sourcePool.query(`SELECT ${API_KEY_COMPARED_COLUMNS.join(', ')} FROM api_keys ORDER BY id ASC`),
        restorePool.query(`SELECT ${API_KEY_COMPARED_COLUMNS.join(', ')} FROM api_keys ORDER BY id ASC`),
        sourcePool.query(`SELECT ${OPERATION_COMPARED_COLUMNS.join(', ')} FROM publish_operations ORDER BY actor_namespace ASC, request_id ASC`),
        restorePool.query(`SELECT ${OPERATION_COMPARED_COLUMNS.join(', ')} FROM publish_operations ORDER BY actor_namespace ASC, request_id ASC`),
        sourcePool.query('SELECT * FROM site_settings ORDER BY id ASC'),
        restorePool.query('SELECT * FROM site_settings ORDER BY id ASC'),
        sourcePool.query('SELECT version, name, checksum, applied_at FROM quickshare_schema_migrations ORDER BY version ASC'),
        restorePool.query('SELECT version, name, checksum, applied_at FROM quickshare_schema_migrations ORDER BY version ASC')
      ]);

    const inventory = comparePageInventory(sourcePages.rows, restorePages.rows);
    checks.push({
      name: 'pageInventory',
      ok: inventory.ok,
      issues: inventory.issues,
      details: {
        pageCount: sourcePages.rows.length,
        comparedColumns: inventory.comparedColumns,
        contentHashes: Object.fromEntries(inventory.contentHashes)
      }
    });

    // Immutable content snapshots restore exactly, and every page's current
    // pointer still names a snapshot identical to the materialized projection.
    // #34: purge tombstones are compared on identity/provenance columns, a
    // resurrected payload byte on a tombstone FAILS, and absent payloads are
    // never recomputed against live content hashes.
    const revisionsInventory = compareRevisionInventory(sourceRevisions.rows, restoreRevisions.rows);
    checks.push({
      name: 'shareRevisions',
      ok: revisionsInventory.ok,
      issues: revisionsInventory.issues,
      details: {
        snapshotCount: restoreRevisions.rows.length,
        tombstoneCount: revisionsInventory.details.tombstoneCount,
        liveCount: revisionsInventory.details.liveCount,
        comparedColumns: revisionsInventory.comparedColumns
      }
    });
    const checkRestoredPointers = verifyRevisionPointers(restorePages.rows);
    const restoredPointerCheck = checkRestoredPointers(restoreRevisions.rows);
    checks.push({
      name: 'revisionCurrentPointer',
      ok: restoredPointerCheck.ok,
      issues: restoredPointerCheck.issues,
      details: restoredPointerCheck.details
    });

    const localMigrations = loadMigrations();
    const ledger = verifyMigrationLedger(restoreLedger.rows, localMigrations);
    const ledgerParityIssues = rowsEqual(sourceLedger.rows, restoreLedger.rows)
      ? []
      : [{ field: 'ledger', message: 'migration ledger differs between source and restored databases' }];
    checks.push({
      name: 'migrationLedger',
      ok: ledger.ok && ledgerParityIssues.length === 0,
      issues: [...ledger.issues, ...ledgerParityIssues],
      details: { applied: restoreLedger.rows.map(row => row.version) }
    });

    const snapshotAt = manifest?.snapshotAt ?? 0;
    // The restore target mirrors the snapshot point, not the live source: source
    // rows recorded after the snapshot are excluded from parity and handled as
    // post-snapshot events below.
    const sourceAuditAtSnapshot = sourceAudit.rows.filter(row => Number(row.created_at) <= Number(snapshotAt));
    const sourceAuditAfterSnapshot = sourceAudit.rows.filter(row => Number(row.created_at) > Number(snapshotAt));

    const auditIssues = [];
    if (sourceAuditAtSnapshot.length !== restoreAudit.rows.length) {
      auditIssues.push({
        field: 'audit_logs',
        message: `audit log count drift at snapshot: source ${sourceAuditAtSnapshot.length}, restore ${restoreAudit.rows.length}`
      });
    } else if (JSON.stringify(auditProjection(sourceAuditAtSnapshot)) !== JSON.stringify(auditProjection(restoreAudit.rows))) {
      auditIssues.push({ field: 'audit_logs', message: 'audit log entries differ between snapshot state and restored database' });
    }
    checks.push({
      name: 'auditLogs',
      ok: auditIssues.length === 0,
      issues: auditIssues,
      details: { entries: restoreAudit.rows.length }
    });

    const keyRowIssues = rowsEqual(sourceKeys.rows, restoreKeys.rows)
      ? []
      : [{ field: 'api_keys', message: 'managed key rows differ between source and restored databases' }];
    const keyPlan = await planApiKeyVerification({
      restoredKeys: restoreKeys.rows,
      fixture,
      verifyHash: (secret, hash) => verifySecret(secret, hash)
    });
    checks.push({
      name: 'managedApiKeys',
      ok: keyRowIssues.length === 0 && keyPlan.ok,
      issues: [...keyRowIssues, ...keyPlan.issues],
      details: { ...keyPlan.details, comparedColumns: API_KEY_COMPARED_COLUMNS }
    });

    // Publish operation records and deletion tombstones (#32): full-row
    // parity including encrypted receipts; each side is reported per row so
    // a missing or altered operation names its (namespace, request id).
    const operationIssues = [];
    const sourceOperationsByKey = new Map(
      sourceOperations.rows.map(row => [`${row.actor_namespace}\u0000${row.request_id}`, row])
    );
    const restoreOperationsByKey = new Map(
      restoreOperations.rows.map(row => [`${row.actor_namespace}\u0000${row.request_id}`, row])
    );
    for (const [key, sourceRow] of sourceOperationsByKey) {
      const restoreRow = restoreOperationsByKey.get(key);
      if (!restoreRow) {
        operationIssues.push({ field: 'publish_operations', requestId: sourceRow.request_id, message: `operation ${key.replace('\u0000', '|')} missing on restore side` });
        continue;
      }
      for (const column of OPERATION_COMPARED_COLUMNS) {
        if (!valuesEqual(sourceRow[column], restoreRow[column])) {
          operationIssues.push({ field: 'publish_operations', requestId: sourceRow.request_id, message: `column ${column} differs for operation ${key.replace('\u0000', '|')}` });
        }
      }
    }
    for (const [key] of restoreOperationsByKey) {
      if (!sourceOperationsByKey.has(key)) {
        operationIssues.push({ field: 'publish_operations', message: `operation ${key.replace('\u0000', '|')} missing on source side` });
      }
    }
    checks.push({
      name: 'publishOperations',
      ok: operationIssues.length === 0,
      issues: operationIssues,
      details: {
        operationCount: restoreOperations.rows.length,
        tombstoneCount: restoreOperations.rows.filter(row => row.deleted_at !== null && row.deleted_at !== undefined).length,
        // #34: operations whose receipt was scrubbed by a revision purge.
        receiptPurgedCount: restoreOperations.rows.filter(row => row.purged_at !== null && row.purged_at !== undefined).length,
        comparedColumns: OPERATION_COMPARED_COLUMNS
      }
    });

    const settingsIssues = rowsEqual(sourceSettings.rows, restoreSettings.rows)
      ? []
      : [{ field: 'site_settings', message: 'site settings differ between source and restored databases' }];
    checks.push({
      name: 'siteSettings',
      ok: settingsIssues.length === 0,
      issues: settingsIssues,
      details: {
        rows: restoreSettings.rows.length,
        comparedColumns: [...new Set([...sourceSettings.fields, ...restoreSettings.fields].map(field => field.name))].sort()
      }
    });

    const restoreById = new Map(restorePages.rows.map(row => [row.id, row]));
    const normalizeTimestamp = value => (value === null || value === undefined) ? null : String(value);
    const expiryPairs = sourcePages.rows.map(row => ({
      id: row.id,
      sourceExpiresAt: normalizeTimestamp(row.expires_at),
      restoreExpiresAt: normalizeTimestamp(restoreById.get(row.id)?.expires_at)
    }));
    const expiryIssues = expiryPairs
      .filter(pair => pair.sourceExpiresAt !== pair.restoreExpiresAt)
      .map(pair => ({ field: 'expires_at', pageId: pair.id, message: `expiry drift for ${pair.id}` }));
    checks.push({
      name: 'expiry',
      ok: expiryIssues.length === 0,
      issues: expiryIssues,
      details: { expiring: expiryPairs.filter(pair => pair.sourceExpiresAt !== null).length }
    });

    const passwordPlan = await planCredentialVerification({
      restoredPages: restorePages.rows,
      fixture,
      verifyHash: (password, hash) => verifySecret(password, hash),
      decrypt: decryptSecret
    });
    checks.push({
      name: 'passwordVerifyAndDecrypt',
      ok: passwordPlan.ok,
      issues: passwordPlan.issues,
      details: passwordPlan.details
    });

    const durationsMs = { verifyMs: Date.now() - started };
    const postSnapshotRevocations = findPostSnapshotRevocations(sourceAuditAfterSnapshot, snapshotAt);

    return buildVerificationReport({
      checks,
      durationsMs,
      postSnapshotRevocations,
      manifest,
      target: {
        database: new URL(restoreUrl).pathname.replace(/^\//, ''),
        host: new URL(restoreUrl).hostname
      }
    });
  } finally {
    await Promise.allSettled([sourcePool.end(), restorePool.end()]);
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const sourceUrl = args.sourceUrl || process.env.BACKUP_DATABASE_URL;
  const restoreUrl = args.restoreUrl || process.env.RESTORE_DATABASE_URL;
  const sessionSecret = args.sessionSecret;

  if (!sourceUrl || !restoreUrl) {
    throw new Error('--source-url and --restore-url are required');
  }

  if (!args.manifest) {
    throw new Error('--manifest <backup manifest path> is required');
  }

  if (sessionSecret) {
    // Must be set before any encrypt/decrypt helper runs. Synthetic values only.
    process.env.SESSION_SECRET = sessionSecret;
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const fixture = args.fixture ? JSON.parse(fs.readFileSync(args.fixture, 'utf8')) : {};

  const report = await runVerification({
    sourceUrl,
    restoreUrl,
    manifest,
    fixture,
    allowNonTest: args.allowNonTest === true
  });

  const defaultOutput = args.manifest.endsWith('.manifest.json')
    ? args.manifest.replace(/\.manifest\.json$/, '.verification.json')
    : `${args.manifest}.verification.json`;
  const output = args.output || defaultOutput;
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`[verify:backup] checks: ${report.checks.map(check => `${check.name}=${check.ok ? 'ok' : 'FAIL'}`).join(', ')}`);
  console.log(`[verify:backup] reconciliation: ${report.reconciliation.status}`);
  console.log(`[verify:backup] safeToServe: ${report.safeToServe} (restored databases stay offline)`);
  console.log(`[verify:backup] durations: ${JSON.stringify(report.durationsMs)}`);
  console.log(`[verify:backup] report: ${output}`);

  process.exitCode = reconciliationExitCode(report, { reconciled: args.reconciled === true });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[verify:backup] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COVERED_OBJECTS,
  HARD_REVOCATION_AUDIT_ACTIONS,
  POLICY_FIELD_NAMES,
  REVISION_COMPARED_COLUMNS,
  POINTER_CONTENT_COLUMNS,
  buildVerificationReport,
  classifyRevocationCoverage,
  comparePageInventory,
  compareRevisionInventory,
  findPostSnapshotRevocations,
  planApiKeyVerification,
  planCredentialVerification,
  reconciliationExitCode,
  runVerification,
  sha256Hex,
  verifyMigrationLedger,
  verifyRevisionPointers
};
