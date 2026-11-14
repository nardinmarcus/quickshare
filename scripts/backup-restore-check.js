#!/usr/bin/env node
'use strict';

// Repeatable backup/restore drill (T03, issue #27). Builds two synthetic
// localhost databases whose names end in _test, seeds known fixtures, then
// runs the real backup -> restore -> verify scripts as subprocesses and
// asserts the outcome, including:
//   - full row-level equivalence after restore (via verify-backup)
//   - password verify + echo capability for protected fixtures
//   - exact restore of a non-default BIGINT access_revision such as
//     9007199254740993 when migration 004 is present (explicitly skipped on
//     a legacy 001-003 schema, where the column does not exist)
//   - a restored-only tamper of access_revision is rejected by verify
//   - the restored database reports safeToServe: false
//   - the write-maintenance switch (migration 005, T04) round-trips: the
//     full-schema fixture is seeded with publishing_writes_paused = true
//     and the restored database must still be paused (explicitly skipped
//     on a legacy 001-003 schema, where the column does not exist)
//   - the managed Key credential_version (migration 006, T05) round-trips
//     exactly (fixture Key is seeded with a non-default version) and a
//     restored-only tamper of it is rejected by verify (explicitly
//     skipped on a legacy 001-003 schema, where the column does not exist)
//   - content Revision state (migration 007, T06) round-trips: the pages
//     current_revision pointers (including an exact 64-bit value) and the
//     immutable share_revisions snapshots (a two-Revision history on one
//     fixture), and restored-only tampering with either a snapshot row or
//     a current_revision pointer is rejected by verify (explicitly
//     skipped on a legacy 001-003 schema, where neither exists)
//   - publish operation records (migration 008, T08) round-trip: the
//     seeded committed operation (request HMAC, result identifiers,
//     encrypted receipt) restores exactly, and a restored-only tamper
//     that flips it to a tombstone is rejected by verify (explicitly
//     skipped on a legacy 001-003 schema, where the table does not exist)
//   - publish state (T11) round-trips: an unpublished fixture Share
//     stays unpublished across backup and restore, and a restored-only
//     flip of its published flag is rejected by verify as a named
//     "published drift" failure (explicitly skipped on a legacy 001-003
//     schema, where the column does not exist)
//   - Key scopes and per-Share grants (migration 010, T12) round-trip:
//     the fixture Key carries a non-default scope list and two read
//     grants, all restored exactly; a restored-only narrowing of the
//     scopes is rejected as a named "scopes differ" failure and a
//     restored-only grant flip is rejected by name (explicitly skipped
//     on a legacy 001-003 schema, where neither exists)
//   - granted content update state (T13) round-trips: the fixture Key
//     also carries the update scope, the auto-edit opt-in switched ON,
//     one read+update grant, and a committed share.content.update
//     operation record with its encrypted receipt, all restored
//     exactly; a restored-only flip of the grant's can_update flag is
//     rejected by name
//   - granted history restore state (T14) round-trips: a third
//     committed operation record — a share.restore in the fixture
//     Key's managed namespace (never the dashboard namespace) with
//     its restore-shaped encrypted receipt — restores exactly
//
// No production data is involved; both fixture databases are dropped at the
// end unless --keep is passed.
//
// Usage:
//   POSTGRES_TEST_URL=postgres://user:pass@127.0.0.1:5432/quickshare_test \
//   QS_PG_BIN_DIR=/path/to/pg/bin \
//   node scripts/backup-restore-check.js [--schema full|legacy] [--keep]

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPostgresPool } = require('../models/postgres-config');
const { runMigrations } = require('../models/postgres-migrations');
const { hashSecret, encryptSecret } = require('../utils/security');
const { computeSnapshotHash } = require('../utils/contentRevision');
const { parseArgs, runCommand } = require('./backup-lib');

const SOURCE_DB = 'qs_backup_src_test';
const RESTORE_DB = 'qs_backup_restore_test';
const FIXTURE_PASSWORD = 'drill-fixture-password';
const BIG_ACCESS_REVISION = '9007199254740993';
const BIG_CONTENT_REVISION = '9007199254740993';
const BASE_TIME = 1760000000000;

const log = (message) => process.stderr.write(`[backup-check] ${message}\n`);

function serverBaseUrl(databaseUrl, database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function runScript(scriptName, args, env) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = await runCommand(process.execPath, [scriptPath, ...args], { env });
  return result;
}

function parseStdoutJson(result, label) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`${label} did not produce JSON output: ${result.stdout} ${result.stderr}`);
  }
}

async function seedFixtures(pool, { hasAccessRevision }) {
  const passwordHash = await hashSecret(FIXTURE_PASSWORD);
  const encryptedPassword = encryptSecret(FIXTURE_PASSWORD);
  const revisionColumn = hasAccessRevision ? ', access_revision' : '';
  // The full schema flag also covers migration 007: pages gain their
  // current_revision pointer and published flag here.
  const contentColumns = hasAccessRevision ? ', current_revision, published' : '';

  const insertPage = `
    INSERT INTO public.pages (
      id, html_content, created_at, password_hash, encrypted_password,
      is_protected, code_type, title, description, expires_at,
      markdown_theme, view_count, is_favorite${revisionColumn}${contentColumns}
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13${hasAccessRevision ? ', $14, $15, $16' : ''})
  `;

  const pageParams = (row, revision, currentRevision) => {
    const params = [
      row.id, row.htmlContent, row.createdAt, row.passwordHash || null,
      row.encryptedPassword || null, row.isProtected || 0, row.codeType || 'html',
      row.title || null, row.description || null, row.expiresAt || null,
      row.markdownTheme || null, row.viewCount || 0, row.isFavorite || false
    ];

    if (hasAccessRevision) {
      params.push(revision);
      params.push(currentRevision || null);
      params.push(row.published !== false);
    }

    return params;
  };

  await pool.query(insertPage, pageParams({
    id: 'drill-public',
    htmlContent: '# Drill public body',
    createdAt: BASE_TIME + 1,
    codeType: 'markdown',
    title: 'Drill public',
    description: 'Public drill fixture',
    markdownTheme: 'github',
    viewCount: 42,
    isFavorite: true
  }, '1', '1'));

  await pool.query(insertPage, pageParams({
    id: 'drill-protected',
    htmlContent: '<p>Drill protected body</p>',
    createdAt: BASE_TIME + 2,
    passwordHash,
    encryptedPassword,
    isProtected: 1,
    title: 'Drill protected',
    description: 'Protected drill fixture',
    expiresAt: BASE_TIME + 86400000
  }, BIG_ACCESS_REVISION, BIG_CONTENT_REVISION));

  await pool.query(insertPage, pageParams({
    id: 'drill-revoked',
    htmlContent: '<p>Drill revoked body</p>',
    createdAt: BASE_TIME + 3,
    passwordHash,
    encryptedPassword,
    isProtected: 1,
    title: 'Drill revoked'
  }, '7', '2'));

  await pool.query(insertPage, pageParams({
    id: 'drill-expired',
    htmlContent: '<p>Drill expired body</p>',
    createdAt: BASE_TIME + 4,
    title: 'Drill expired',
    expiresAt: BASE_TIME - 1000
  }, '1', '1'));

  await pool.query(insertPage, pageParams({
    id: 'drill-unpublished',
    htmlContent: '<p>Drill unpublished body</p>',
    createdAt: BASE_TIME + 6,
    title: 'Drill unpublished',
    description: 'Unpublished drill fixture',
    published: false
  }, '3', '1'));

  if (hasAccessRevision) {
    // Full schema includes migration 007: every fixture Share gets its
    // immutable snapshots — drill-revoked carries a two-Revision history
    // and drill-protected points at an exact 64-bit current_revision.
    // Hashes are computed with the real snapshot-hash function so the
    // restored data must also pass verify's semantic integrity checks.
    const snapshots = [
      {
        shareId: 'drill-public', revision: '1',
        htmlContent: '# Drill public body', codeType: 'markdown',
        title: 'Drill public', description: 'Public drill fixture', markdownTheme: 'github',
        source: 'baseline', createdAt: BASE_TIME + 1000
      },
      {
        shareId: 'drill-protected', revision: BIG_CONTENT_REVISION,
        htmlContent: '<p>Drill protected body</p>', codeType: 'html',
        title: 'Drill protected', description: 'Protected drill fixture', markdownTheme: null,
        source: 'admin-edit', createdAt: BASE_TIME + 2000
      },
      {
        // A purged tombstone (T10): drill-revoked's first Revision was
        // permanently cleared by the owner. The row keeps only its
        // metadata — no body, title, description, theme or hash — so
        // the drill proves a purge survives backup/restore still
        // purged, and that verification detects any resurrection.
        shareId: 'drill-revoked', revision: '1',
        htmlContent: null, codeType: 'html',
        title: null, description: null, markdownTheme: null,
        source: 'baseline', createdAt: BASE_TIME + 3000,
        purgedAt: BASE_TIME + 3500
      },
      {
        shareId: 'drill-revoked', revision: '2',
        htmlContent: '<p>Drill revoked body</p>', codeType: 'html',
        title: 'Drill revoked', description: null, markdownTheme: null,
        source: 'admin-edit', createdAt: BASE_TIME + 4000
      },
      {
        shareId: 'drill-expired', revision: '1',
        htmlContent: '<p>Drill expired body</p>', codeType: 'html',
        title: 'Drill expired', description: null, markdownTheme: null,
        source: 'baseline', createdAt: BASE_TIME + 5000
      },
      {
        shareId: 'drill-unpublished', revision: '1',
        htmlContent: '<p>Drill unpublished body</p>', codeType: 'html',
        title: 'Drill unpublished', description: 'Unpublished drill fixture', markdownTheme: null,
        source: 'baseline', createdAt: BASE_TIME + 6000
      }
    ];

    for (const snapshot of snapshots) {
      const snapshotHash = snapshot.purgedAt
        ? null
        : computeSnapshotHash(snapshot.shareId, snapshot.revision, snapshot);

      await pool.query(
        `INSERT INTO public.share_revisions (
           share_id, revision, html_content, code_type, title, description,
           markdown_theme, snapshot_hash, source, actor_type, actor_id,
           restored_from_revision, created_at, purged_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'owner', NULL, NULL, $10, $11)`,
        [
          snapshot.shareId, snapshot.revision, snapshot.htmlContent, snapshot.codeType,
          snapshot.title, snapshot.description, snapshot.markdownTheme, snapshotHash,
          snapshot.source, snapshot.createdAt, snapshot.purgedAt ?? null
        ]
      );
    }
  }

  if (hasAccessRevision) {
    // Full schema includes migration 006: seed a non-default credential
    // version so the drill proves the version itself is backed up and
    // restored, not silently reset to 1. Migration 010 (T12) adds a
    // non-default scope list for the same reason: the restored Key must
    // come back with exactly the scopes it had, no wider and no
    // narrower.
    await pool.query(
      `INSERT INTO public.api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, credential_version, scopes, auto_grant_new_share_edit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['drillkey1', 'Drill key', await hashSecret('drill-api-secret'), 'qs_drill', BASE_TIME + 5, null, 7, '["share:create","share:read","share:update"]', true]
    );

    // Per-Share grants for the fixture Key (T12, update grant added by
    // T13): authorization state is part of the backup, so the drill
    // proves the grant rows themselves round-trip exactly — drill-public
    // read-only, drill-protected read+update. The fixture Key's
    // auto-edit opt-in is also ON (above) so its non-default value is
    // part of what restore must reproduce.
    await pool.query(
      `INSERT INTO public.share_grants (api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at)
       VALUES ($1, $2, true, false, false, $3, $3), ($1, $4, true, true, false, $5, $5)`,
      ['drillkey1', 'drill-public', BASE_TIME + 40, 'drill-protected', BASE_TIME + 41]
    );
  } else {
    await pool.query(
      `INSERT INTO public.api_keys (id, name, key_hash, key_prefix, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['drillkey1', 'Drill key', await hashSecret('drill-api-secret'), 'qs_drill', BASE_TIME + 5, null]
    );
  }

  const audit = async (action, pageId, details, offset) => {
    await pool.query(
      `INSERT INTO public.audit_logs (action, page_id, details, ip, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [action, pageId, JSON.stringify(details), '127.0.0.1', BASE_TIME + offset]
    );
  };

  if (hasAccessRevision) {
    // Full schema includes migration 008: seed a committed publish
    // operation so the drill proves the record — request HMAC, result
    // identifiers, version pointers and the encrypted receipt — is
    // backed up and restored exactly (T08). The receipt is real
    // ciphertext of a create receipt, never plaintext.
    const receipt = encryptSecret(JSON.stringify({
      kind: 'share.create',
      shareId: 'drill-public',
      password: null,
      isProtected: false,
      codeType: 'markdown',
      title: 'Drill public',
      description: 'Public drill fixture',
      expiresAt: null,
      markdownTheme: 'github',
      contentRevision: '1',
      contentEtag: 'drill-etag'
    }));

    await pool.query(
      `INSERT INTO public.publish_operations (
         actor_namespace, request_id, action, target_id, request_hmac,
         result_share_id, result_revision, result_access_revision,
         receipt_encrypted, result_state, created_at
       ) VALUES ($1, $2, 'share.create', NULL, $3, 'drill-public', 1, 1, $4, 'committed', $5)`,
      ['key:managed:drillkey1', 'drill-request-0001', 'a'.repeat(64), receipt, BASE_TIME + 30]
    );

    // A committed content-update operation by the same Key (T13): the
    // drill proves a share.content.update record — target, result
    // version pointers and its (body-free) encrypted receipt —
    // round-trips exactly like a create record.
    const updateReceipt = encryptSecret(JSON.stringify({
      kind: 'share.content.update',
      shareId: 'drill-protected',
      contentChanged: true,
      contentRevision: BIG_CONTENT_REVISION,
      accessRevision: BIG_ACCESS_REVISION
    }));

    await pool.query(
      `INSERT INTO public.publish_operations (
         actor_namespace, request_id, action, target_id, request_hmac,
         result_share_id, result_revision, result_access_revision,
         receipt_encrypted, result_state, created_at
       ) VALUES ($1, $2, 'share.content.update', $3, $4, $3, $5::bigint, $6::bigint, $7, 'committed', $8)`,
      ['key:managed:drillkey1', 'drill-request-0002', 'drill-protected', 'b'.repeat(64), BIG_CONTENT_REVISION, BIG_ACCESS_REVISION, updateReceipt, BASE_TIME + 31]
    );

    // A committed history-restore operation by the same Key (T14):
    // the record lives in the MANAGED-KEY namespace — a Key restore
    // never writes under the dashboard namespace — and its receipt is
    // the restore shape (source and previous Revisions, resulting
    // content Revision, no body). The drill proves it round-trips
    // exactly like the create and update records.
    const restoreReceipt = encryptSecret(JSON.stringify({
      kind: 'share.restore',
      shareId: 'drill-protected',
      sourceRevision: '1',
      previousRevision: '9007199254740992',
      contentRevision: BIG_CONTENT_REVISION,
      contentChanged: true
    }));

    await pool.query(
      `INSERT INTO public.publish_operations (
         actor_namespace, request_id, action, target_id, request_hmac,
         result_share_id, result_revision, result_access_revision,
         receipt_encrypted, result_state, created_at
       ) VALUES ($1, $2, 'share.restore', $3, $4, $3, $5::bigint, $6::bigint, $7, 'committed', $8)`,
      ['key:managed:drillkey1', 'drill-request-0003', 'drill-protected', 'c'.repeat(64), BIG_CONTENT_REVISION, BIG_ACCESS_REVISION, restoreReceipt, BASE_TIME + 32]
    );
  }

  await audit('page.create', 'drill-public', {}, 10);
  await audit('page.create', 'drill-protected', {}, 11);
  await audit('page.update', 'drill-protected', { fields: ['passwordHash', 'isProtected'] }, 12);
  await audit('page.access.revoke', 'drill-revoked', { accessRevision: '7' }, 13);
  await audit('page.favorite.update', 'drill-public', { isFavorite: true }, 14);
  await audit('page.revision.purge', 'drill-revoked', { revision: '1', purgedAt: BASE_TIME + 3500 }, 15);
  await audit('page.publish.update', 'drill-unpublished', { from: true, to: false, accessRevision: '3' }, 16);

  if (hasAccessRevision) {
    // Grant history (T12): two live grants plus one grant that was
    // granted and revoked again before the backup — the revocation is
    // exactly the evidence the verify report's detector must surface,
    // because restoring an older backup would revive that grant.
    await audit('api_key.grant', 'drill-public', { apiKeyId: 'drillkey1', shareId: 'drill-public', permissions: { read: true, update: false, publish: false } }, 42);
    await audit('api_key.grant', 'drill-protected', { apiKeyId: 'drillkey1', shareId: 'drill-protected', permissions: { read: true, update: true, publish: false } }, 43);
    await audit('api_key.auto_grant', null, { apiKeyId: 'drillkey1', enabled: true }, 45);
    await audit('api_key.grant_revoke', 'drill-expired', { apiKeyId: 'drillkey1', shareId: 'drill-expired' }, 44);
  }

  await pool.query(
    'UPDATE public.site_settings SET homepage_password_required = false, updated_at = $1 WHERE id = 1',
    [BASE_TIME + 20]
  );

  if (hasAccessRevision) {
    // Full schema includes migration 005: seed the instance mid-maintenance
    // so the drill proves the pause switch itself is backed up and restored
    // (a restored instance must not silently resume serving writes).
    await pool.query(
      'UPDATE public.site_settings SET publishing_writes_paused = true WHERE id = 1'
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    databaseUrl: { type: 'string', default: process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL },
    pgBinDir: { type: 'string' },
    schema: { type: 'string', default: 'full' },
    keep: { type: 'boolean' }
  });

  if (!options.databaseUrl) {
    throw new Error('Missing --database-url (or POSTGRES_TEST_URL env) pointing at the test Postgres server');
  }

  if (!['full', 'legacy'].includes(options.schema)) {
    throw new Error(`--schema must be "full" or "legacy" (got "${options.schema}")`);
  }

  const hasAccessRevision = options.schema === 'full';
  const skipped = [];

  if (!hasAccessRevision) {
    skipped.push('access_revision assertions skipped: schema 004 absent (legacy 001-003 fixture)');
    log('SKIP access_revision assertions: schema 004 absent (legacy 001-003 fixture)');
    skipped.push('publishing_writes_paused assertions skipped: schema 005 absent (legacy 001-003 fixture)');
    log('SKIP publishing_writes_paused assertions: schema 005 absent (legacy 001-003 fixture)');
    skipped.push('credential_version assertions skipped: schema 006 absent (legacy 001-003 fixture)');
    log('SKIP credential_version assertions: schema 006 absent (legacy 001-003 fixture)');
    skipped.push('content Revision assertions skipped: schema 007 absent (legacy 001-003 fixture)');
    log('SKIP content Revision assertions: schema 007 absent (legacy 001-003 fixture)');
    skipped.push('publish-state assertions skipped: schema 007 absent (legacy 001-003 fixture)');
    log('SKIP publish-state assertions: schema 007 absent (legacy 001-003 fixture)');
    skipped.push('grant assertions skipped: schema 010 absent (legacy 001-003 fixture)');
    log('SKIP grant assertions: schema 010 absent (legacy 001-003 fixture)');
  }

  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'backup-restore-drill-synthetic-secret-0123456789';
    log('SESSION_SECRET not set; using a synthetic drill-only secret for password echo fixtures');
  }

  const childEnv = { ...process.env };

  if (!childEnv.POSTGRES_SSL) {
    childEnv.POSTGRES_SSL = 'false';
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickshare-backup-check-'));
  const backupDir = path.join(workDir, 'backup');
  const passwordsPath = path.join(workDir, 'passwords.json');
  const steps = {};
  const failures = [];

  const check = (label, condition) => {
    if (condition) {
      log(`ok - ${label}`);
    } else {
      failures.push(label);
      log(`FAIL - ${label}`);
    }
  };

  const adminPool = createPostgresPool(serverBaseUrl(options.databaseUrl, 'postgres'), { max: 1 });
  const sourceUrl = serverBaseUrl(options.databaseUrl, SOURCE_DB);
  const restoreUrl = serverBaseUrl(options.databaseUrl, RESTORE_DB);
  let sourcePool = null;
  let restorePool = null;

  try {
    for (const database of [SOURCE_DB, RESTORE_DB]) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
      await adminPool.query(`CREATE DATABASE ${database}`);
    }

    sourcePool = createPostgresPool(sourceUrl, { max: 1 });

    if (hasAccessRevision) {
      await runMigrations(sourcePool, { logger: { info() {} } });
    } else {
      const legacyDir = path.join(workDir, 'legacy-migrations');
      fs.mkdirSync(legacyDir);

      for (const file of ['001_baseline.sql', '002_site_settings.sql', '003_page_favorites.sql']) {
        fs.copyFileSync(path.join(__dirname, '..', 'db', 'migrations', file), path.join(legacyDir, file));
      }

      await runMigrations(sourcePool, { migrationsDir: legacyDir, logger: { info() {} } });
    }

    await seedFixtures(sourcePool, { hasAccessRevision });
    log(`seeded ${SOURCE_DB} (${options.schema} schema)`);

    const toolArgs = options.pgBinDir ? ['--pg-bin-dir', options.pgBinDir] : [];

    let startedAt = Date.now();
    const backupResult = await runScript('backup-db.js', [
      '--database-url', sourceUrl,
      '--output-dir', backupDir,
      ...toolArgs
    ], childEnv);
    steps.backupMs = Date.now() - startedAt;

    if (backupResult.code !== 0) {
      throw new Error(`backup-db.js failed: ${backupResult.stderr.trim()}`);
    }

    const backupSummary = parseStdoutJson(backupResult, 'backup-db.js');
    check('backup produced a manifest and dump', backupSummary.ok === true);
    steps.backupDurationMs = backupSummary.backupDurationMs;

    startedAt = Date.now();
    const restoreResult = await runScript('restore-db.js', [
      '--input-dir', backupDir,
      '--database-url', restoreUrl,
      ...toolArgs
    ], childEnv);
    steps.restoreMs = Date.now() - startedAt;

    if (restoreResult.code !== 0) {
      throw new Error(`restore-db.js failed: ${restoreResult.stderr.trim()}`);
    }

    const restoreSummary = parseStdoutJson(restoreResult, 'restore-db.js');
    check('restore completed with safeToServe false', restoreSummary.ok === true
      && restoreSummary.receipt.safeToServe === false);
    steps.restoreDurationMs = restoreSummary.receipt.restoreDurationMs;

    fs.writeFileSync(passwordsPath, JSON.stringify({
      'drill-protected': FIXTURE_PASSWORD,
      'drill-revoked': FIXTURE_PASSWORD
    }));

    const verifyArgs = [
      '--input-dir', backupDir,
      '--database-url', restoreUrl,
      '--passwords', passwordsPath
    ];

    startedAt = Date.now();
    const verifyResult = await runScript('verify-backup.js', verifyArgs, childEnv);
    steps.verifyMs = Date.now() - startedAt;

    if (verifyResult.code !== 0) {
      throw new Error(`verify-backup.js failed on a clean restore: ${verifyResult.stdout} ${verifyResult.stderr}`);
    }

    const report = parseStdoutJson(verifyResult, 'verify-backup.js');
    check('verify passes on the clean restore', report.ok === true);
    check('verify reports backup and restore durations', typeof report.backupDurationMs === 'number'
      && typeof report.restoreDurationMs === 'number');
    check('password capability fully verified for protected fixtures', report.passwordCapability.status === 'verified'
      && report.passwordCapability.plaintextVerified === 2);
    check('restored database stays safeToServe false', report.safeToServe === false);

    const detectedTypes = (report.revocations.detected || []).map(event => `${event.pageId}:${event.type}`);
    check('revocation detector sees the policy change for drill-protected', detectedTypes.includes('drill-protected:access-policy-change'));
    check('revocation detector sees the access revoke for drill-revoked', detectedTypes.includes('drill-revoked:access-revoke'));
    check('revocation detector sees the publish-state change for drill-unpublished', detectedTypes.includes('drill-unpublished:publish-state-change'));
    check('revocation detector sees the grant revocation for drill-expired', !hasAccessRevision
      || detectedTypes.includes('drill-expired:grant-revoke'));
    check('verify report accounts for the 2 seeded Share grants', !hasAccessRevision
      || (report.shareGrants !== undefined
        && report.shareGrants.tracked === true
        && report.shareGrants.grants === 2));

    restorePool = createPostgresPool(restoreUrl, { max: 1 });

    if (hasAccessRevision) {
      const pausedResult = await restorePool.query(
        'SELECT publishing_writes_paused FROM public.site_settings WHERE id = 1'
      );
      check(
        'restored database keeps publishing writes paused (migration 005 switch round-trips)',
        pausedResult.rows[0].publishing_writes_paused === true
      );
    }

    if (hasAccessRevision) {
      const revisionResult = await restorePool.query(
        "SELECT access_revision::text AS revision FROM public.pages WHERE id = 'drill-protected'"
      );
      check(
        `non-default access_revision ${BIG_ACCESS_REVISION} restored exactly`,
        revisionResult.rows[0].revision === BIG_ACCESS_REVISION
      );

      await restorePool.query(
        "UPDATE public.pages SET access_revision = access_revision + 1 WHERE id = 'drill-protected'"
      );
    } else {
      await restorePool.query(
        "UPDATE public.pages SET view_count = view_count + 1 WHERE id = 'drill-public'"
      );
    }

    const tamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
    let tamperReport = null;

    try {
      tamperReport = parseStdoutJson(tamperResult, 'verify-backup.js (tampered)');
    } catch (error) {
      // handled by the checks below
    }

    check('verify rejects the restored-only tamper', tamperResult.code !== 0
      && tamperReport !== null
      && tamperReport.ok === false
      && tamperReport.failures.some(failure => failure.includes('drill-')));

    if (hasAccessRevision) {
      const versionResult = await restorePool.query(
        "SELECT credential_version::text AS version FROM public.api_keys WHERE id = 'drillkey1'"
      );
      check(
        'non-default credential_version 7 restored exactly',
        versionResult.rows[0].version === '7'
      );

      await restorePool.query(
        "UPDATE public.api_keys SET credential_version = credential_version + 1 WHERE id = 'drillkey1'"
      );

      const versionTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let versionTamperReport = null;

      try {
        versionTamperReport = parseStdoutJson(versionTamperResult, 'verify-backup.js (credential tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only credential_version tamper', versionTamperResult.code !== 0
        && versionTamperReport !== null
        && versionTamperReport.ok === false
        && versionTamperReport.failures.some(failure => failure.includes('credential_version')));
    }

    if (hasAccessRevision) {
      const currentResult = await restorePool.query(
        "SELECT current_revision::text AS revision FROM public.pages WHERE id = 'drill-protected'"
      );
      check(
        `non-default current_revision ${BIG_CONTENT_REVISION} restored exactly`,
        currentResult.rows[0].revision === BIG_CONTENT_REVISION
      );
      check('verify report accounts for the 6 Revision snapshots on 5 Shares',
        report.contentRevisions !== undefined
        && report.contentRevisions.tracked === true
        && report.contentRevisions.snapshots === 6
        && report.contentRevisions.purgedSnapshots === 1
        && report.contentRevisions.sharesWithBaseline === 5);

      const snapshotCount = await restorePool.query(
        'SELECT COUNT(*)::int AS count FROM public.share_revisions'
      );
      check('restored share_revisions carries all 6 seeded snapshots', snapshotCount.rows[0].count === 6);

      const unpublishedResult = await restorePool.query(
        "SELECT published FROM public.pages WHERE id = 'drill-unpublished'"
      );
      check('unpublished Share stays unpublished across backup and restore',
        unpublishedResult.rows[0].published === false);

      const tombstoneResult = await restorePool.query(
        `SELECT html_content, title, description, markdown_theme, snapshot_hash,
                purged_at::text AS purged_at
         FROM public.share_revisions
         WHERE share_id = 'drill-revoked' AND revision = 1`
      );
      check('purged Revision stays purged across backup and restore (tombstone only)', (() => {
        const row = tombstoneResult.rows[0];
        return Boolean(row)
          && row.html_content === null
          && row.title === null
          && row.description === null
          && row.markdown_theme === null
          && row.snapshot_hash === null
          && row.purged_at === String(BASE_TIME + 3500);
      })());

      await restorePool.query(
        "UPDATE public.share_revisions SET title = 'tampered snapshot title' WHERE share_id = 'drill-public' AND revision = 1"
      );

      const snapshotTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let snapshotTamperReport = null;

      try {
        snapshotTamperReport = parseStdoutJson(snapshotTamperResult, 'verify-backup.js (snapshot tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only Revision snapshot tamper', snapshotTamperResult.code !== 0
        && snapshotTamperReport !== null
        && snapshotTamperReport.ok === false
        && snapshotTamperReport.failures.some(failure => failure.includes('share_revisions')));

      await restorePool.query(
        "UPDATE public.pages SET current_revision = 424242 WHERE id = 'drill-public'"
      );

      const pointerTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let pointerTamperReport = null;

      try {
        pointerTamperReport = parseStdoutJson(pointerTamperResult, 'verify-backup.js (pointer tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only current_revision pointer tamper', pointerTamperResult.code !== 0
        && pointerTamperReport !== null
        && pointerTamperReport.ok === false
        && pointerTamperReport.failures.some(failure => failure.includes('current_revision')));

      await restorePool.query(
        "UPDATE public.share_revisions SET html_content = '<p>resurrected</p>' WHERE share_id = 'drill-revoked' AND revision = 1"
      );

      const resurrectResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let resurrectReport = null;

      try {
        resurrectReport = parseStdoutJson(resurrectResult, 'verify-backup.js (tombstone resurrected)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only tombstone resurrection', resurrectResult.code !== 0
        && resurrectReport !== null
        && resurrectReport.ok === false
        && resurrectReport.failures.some(failure => failure.includes('share_revisions')));

      const operationCount = await restorePool.query(
        'SELECT COUNT(*)::int AS count FROM public.publish_operations'
      );
      check('restored publish_operations carries all three seeded operation records',
        operationCount.rows[0].count === 3);

      await restorePool.query(
        "UPDATE public.publish_operations SET result_state = 'result_unavailable', receipt_encrypted = NULL WHERE request_id = 'drill-request-0001'"
      );

      const operationTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let operationTamperReport = null;

      try {
        operationTamperReport = parseStdoutJson(operationTamperResult, 'verify-backup.js (operation tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only publish_operations tamper', operationTamperResult.code !== 0
        && operationTamperReport !== null
        && operationTamperReport.ok === false
        && operationTamperReport.failures.some(failure => failure.includes('publish_operations')));

      await restorePool.query(
        "UPDATE public.pages SET published = TRUE WHERE id = 'drill-unpublished'"
      );

      const publishedTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let publishedTamperReport = null;

      try {
        publishedTamperReport = parseStdoutJson(publishedTamperResult, 'verify-backup.js (published tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only published drift', publishedTamperResult.code !== 0
        && publishedTamperReport !== null
        && publishedTamperReport.ok === false
        && publishedTamperReport.failures.some(failure => failure.includes('published drift')));

      const grantResult = await restorePool.query(
        `SELECT share_id, can_read, can_update, can_publish
         FROM public.share_grants
         WHERE api_key_id = 'drillkey1'
         ORDER BY share_id`
      );
      check('restored share_grants carries both seeded grants exactly', grantResult.rows.length === 2
        && grantResult.rows.every(row => row.can_read === true && row.can_publish === false)
        && grantResult.rows.find(row => row.share_id === 'drill-public')?.can_update === false
        && grantResult.rows.find(row => row.share_id === 'drill-protected')?.can_update === true
        && grantResult.rows.map(row => row.share_id).join(',') === 'drill-protected,drill-public');

      const scopesResult = await restorePool.query(
        "SELECT scopes, auto_grant_new_share_edit FROM public.api_keys WHERE id = 'drillkey1'"
      );
      check('non-default Key scopes restored exactly',
        scopesResult.rows[0].scopes === '["share:create","share:read","share:update"]');
      check('Key auto-edit opt-in restored exactly (T13)',
        scopesResult.rows[0].auto_grant_new_share_edit === true);

      await restorePool.query(
        "UPDATE public.share_grants SET can_update = FALSE WHERE api_key_id = 'drillkey1' AND share_id = 'drill-protected'"
      );

      const updateGrantTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let updateGrantTamperReport = null;

      try {
        updateGrantTamperReport = parseStdoutJson(updateGrantTamperResult, 'verify-backup.js (can_update tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only can_update tamper', updateGrantTamperResult.code !== 0
        && updateGrantTamperReport !== null
        && updateGrantTamperReport.ok === false
        && updateGrantTamperReport.failures.some(failure => failure.includes('share_grants')));

      await restorePool.query(
        "UPDATE public.share_grants SET can_update = TRUE WHERE api_key_id = 'drillkey1' AND share_id = 'drill-protected'"
      );

      await restorePool.query(
        "UPDATE public.share_grants SET can_read = FALSE WHERE api_key_id = 'drillkey1' AND share_id = 'drill-public'"
      );

      const grantTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let grantTamperReport = null;

      try {
        grantTamperReport = parseStdoutJson(grantTamperResult, 'verify-backup.js (grant tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only grant tamper', grantTamperResult.code !== 0
        && grantTamperReport !== null
        && grantTamperReport.ok === false
        && grantTamperReport.failures.some(failure => failure.includes('share_grants')));

      await restorePool.query(
        "UPDATE public.api_keys SET scopes = '[\"share:create\"]' WHERE id = 'drillkey1'"
      );

      const scopesTamperResult = await runScript('verify-backup.js', verifyArgs, childEnv);
      let scopesTamperReport = null;

      try {
        scopesTamperReport = parseStdoutJson(scopesTamperResult, 'verify-backup.js (scopes tampered)');
      } catch (error) {
        // handled by the check below
      }

      check('verify rejects a restored-only scopes tamper by name', scopesTamperResult.code !== 0
        && scopesTamperReport !== null
        && scopesTamperReport.ok === false
        && scopesTamperReport.failures.some(failure => failure.includes('scopes differ')));
    }

    const summary = {
      ok: failures.length === 0,
      schema: options.schema,
      publicationState: hasAccessRevision ? 'unpublished-exercised' : 'skipped-legacy-schema',
      grantState: hasAccessRevision ? 'grants-exercised' : 'skipped-legacy-schema',
      steps,
      skipped,
      failures
    };

    console.log(JSON.stringify(summary, null, 2));

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (sourcePool) await sourcePool.end().catch(() => {});
    if (restorePool) await restorePool.end().catch(() => {});

    if (!options.keep) {
      for (const database of [SOURCE_DB, RESTORE_DB]) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => {});
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      log(`--keep: fixture databases and artifacts retained (${workDir})`);
    }

    await adminPool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[db:backup-check] failed: ${error.message}`);
  process.exitCode = 1;
});
