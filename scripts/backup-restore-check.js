#!/usr/bin/env node
'use strict';

/*
 * Repeatable native backup → restore → verify drill for QuickShare.
 *
 * Provisions two disposable PostgreSQL 17 containers bound to 127.0.0.1
 * (issue27-pg-src / issue27-pg-restore), creates the `issue27_*_test`
 * databases, applies the real migrations, seeds a synthetic fixture, then
 * runs scripts/backup-db.js → scripts/restore-db.js → scripts/verify-backup.js
 * and reports actual snapshot point and timings.
 *
 * Only its own named containers are ever created or removed. Real secrets are
 * never used: the fixture derives password hashes and encrypted display
 * material from a synthetic session secret defined below.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostgresPool } = require('../models/postgres-config');
const { runMigrations } = require('../models/postgres-migrations');
const { encryptSecret, hashSecret } = require('../utils/security');

const {
  assertTestDatabaseUrl,
  localPoolEnv,
  parseCliArgs,
  parseConnectionStringParts,
  runCommand,
  samePostgresEndpoint,
  sanitizeChildEnv
} = require('./backup-db');

const FIXTURE = {
  sessionSecret: 'qs27-issue27-drill-session-secret-0123456789abcdef',
  image: 'postgres:17-alpine',
  password: 'issue27local',
  // Container names/ports are overridable per environment (Q27_DRILL_* env)
  // so an isolated run can use its OWN namespace without touching another
  // ticket's containers; the defaults stay the original #27 values.
  srcContainer: process.env.Q27_DRILL_SRC_CONTAINER ?? 'issue27-pg-src',
  restoreContainer: process.env.Q27_DRILL_RESTORE_CONTAINER ?? 'issue27-pg-restore',
  srcPort: process.env.Q27_DRILL_SRC_PORT === undefined ? 5541 : Number(process.env.Q27_DRILL_SRC_PORT),
  restorePort: process.env.Q27_DRILL_RESTORE_PORT === undefined ? 5542 : Number(process.env.Q27_DRILL_RESTORE_PORT),
  // Database names are overridable for the same reason: an isolated run can
  // keep its whole drill (containers AND databases) inside its own namespace.
  sourceDatabase: process.env.Q27_DRILL_SRC_DATABASE ?? 'issue27_src_test',
  restoreDatabase: process.env.Q27_DRILL_RESTORE_DATABASE ?? 'issue27_restore_test',
  pages: {
    publicHtml: 'issue27pub0010',
    markdownThemed: 'issue27md00010',
    protectedPage: 'issue27prot0001',
    expiredPage: 'issue27exp00010',
    bigRevision: 'issue27big00001'
  },
  apiKey: {
    id: 'issue27key00001',
    name: 'backup-drill-key',
    secret: 'qs27-drill-api-key-1234567890'
  },
  protectedPassword: 'Drill!Pass1'
};

// Access Revision fixture gate (sibling #25 compatibility). When the source
// schema carries `pages.access_revision` (migration 004 from #25), the drill
// seeds this value — a decimal string beyond Number.MAX_SAFE_INTEGER — on the
// protected Share so dump→restore exact preservation and explicit column
// comparison are provable. On a 001–003 base the column is absent and the
// fixture stays honest: the gate is reported as not exercised, never claimed.
const ACCESS_REVISION_DRILL_VALUE = '9007199254740993';

// Content Revision fixture gate (#30). When the source schema carries the
// `share_revisions` table and `pages.current_revision`/`published` (migration
// 007), the drill seeds real snapshot rows — including a pointer beyond
// 2^53 — so exact snapshot restore, pointer consistency and non-default
// `published` are provable. On a 001–006 base the gate reports honestly.
const REVISION_DRILL_VALUE = '9007199254740993';

// Publish-operation fixture (#32 migration 008): one committed creation with
// an encrypted receipt and one deletion tombstone (receipt cleared). #33 adds
// dashboard restore/content-update rows; #37 adds a managed-Key content
// update receipt; #38 adds a Key-driven restore receipt; #39 adds a managed-Key
// publish-state result on a Share already unpublished by #35. The full-row
// verifier covers every operation byte by name.
const OPERATION_FIXTURE = {
  namespace: 'managed-key:issue27key00001',
  requestId: 'issue32-op-000000000001',
  tombstoneRequestId: 'issue32-op-000000000002',
  restoreRequestId: 'issue33-op-000000000003',
  contentUpdateRequestId: 'issue33-op-000000000004',
  apiContentUpdateRequestId: 'issue37-op-000000000007',
  purgedReceiptRequestId: 'issue34-op-000000000005',
  apiRestoreRequestId: 'issue38-op-000000000008',
  apiPublishRequestId: 'issue39-op-000000000009'
};

// Publication-state fixture gate (#35). When migration 007's `published`
// column exists, the drill seeds the REAL end state of an owner unpublish on
// the themed Share: published = FALSE AND a bumped access_revision — the
// exact pair the #35 transition commits in one transaction. The value is the
// access-revision drill value advanced by exactly one bump, still beyond
// 2^53, so dump→restore proves the transition state survives byte-exactly.
const UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE = '9007199254740994';

async function probePublishOperationsTable(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'publish_operations'
     ) AS present`
  );

  return result.rows[0].present === true;
}

async function probeAccessRevisionColumn(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pages'
         AND column_name = 'access_revision'
     ) AS present`
  );

  return result.rows[0].present === true;
}

async function probeShareRevisionsTable(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'share_revisions'
     ) AS present`
  );

  return result.rows[0].present === true;
}

// #34 purge-tombstone fixture gate: true only when migration 009 has added
// the purged_at columns. On a 001–008 base the tombstone branch is skipped
// and reported honestly, never claimed.
async function probePurgeColumns(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS present
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'purged_at'
       AND table_name IN ('share_revisions', 'publish_operations')`
  );

  return result.rows[0].present === 2;
}

// #36 Key-scope fixture gate: true only when migration 010 added the scope
// columns. On a 001–009 base the scope branch is skipped and reported
// honestly, never claimed.
async function probeApiKeyScopesColumn(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS present
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'api_keys'
       AND column_name IN ('scopes', 'auto_grant_new_share_edit')`
  );

  return result.rows[0].present === 2;
}

// #36 share-grants fixture gate: true only when migration 010 created the
// table.
async function probeShareGrantsTable(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'share_grants'
     ) AS present`
  );

  return result.rows[0].present === true;
}

function sourceUrlFor() {
  return `postgresql://postgres:${FIXTURE.password}@127.0.0.1:${FIXTURE.srcPort}/${FIXTURE.sourceDatabase}`;
}

function restoreUrlFor() {
  return `postgresql://postgres:${FIXTURE.password}@127.0.0.1:${FIXTURE.restorePort}/${FIXTURE.restoreDatabase}`;
}

function assertSqlDatabaseIdentifier(database, label) {
  if (typeof database !== 'string'
      || Buffer.byteLength(database, 'utf8') > 63
      || !/^[a-z_][a-z0-9_]*$/.test(database)
      || !database.endsWith('_test')) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier of at most 63 ASCII characters ending in _test`);
  }
  return database;
}

function validateDrillTargets({ sourceUrl, restoreUrl, sourceDatabase, restoreDatabase }) {
  // Keep this gate before every Docker, Pool, or SQL operation. Do not pass
  // allowNonTest: this destructive fixture drill has no production bypass.
  assertSqlDatabaseIdentifier(sourceDatabase, 'Source database');
  assertSqlDatabaseIdentifier(restoreDatabase, 'Restore database');
  assertTestDatabaseUrl(sourceUrl);
  assertTestDatabaseUrl(restoreUrl);

  const source = parseConnectionStringParts(sourceUrl);
  const restore = parseConnectionStringParts(restoreUrl);
  if (source.database !== sourceDatabase || restore.database !== restoreDatabase) {
    throw new Error('Drill URL database names must match the validated SQL identifiers');
  }
  if (samePostgresEndpoint(source, restore)) {
    throw new Error('Drill source and restore must use distinct effective PostgreSQL endpoints');
  }
  return { source, restore };
}

function validateContainerName(name, label) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error(`${label} must be a valid Docker container name`);
  }
  return name;
}

function validatePort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function ensureFreshPrivateOutputDir(outputDir) {
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'qs27-backup-check-'));
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(dir).length > 0) {
      throw new Error('Drill output path must be an empty, real directory');
    }
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Seeds the deterministic synthetic fixture. Requires process.env.SESSION_SECRET
 * to be set to FIXTURE.sessionSecret before calling (hash/encrypt derive from it).
 */
async function seedFixture(pool) {
  const base = Date.now() - 60000;
  const pages = FIXTURE.pages;
  const passwordHash = await hashSecret(FIXTURE.protectedPassword);
  const encryptedPassword = encryptSecret(FIXTURE.protectedPassword);

  await pool.query(
    `INSERT INTO pages (id, html_content, created_at, password_hash, encrypted_password,
       is_protected, code_type, title, description, expires_at, markdown_theme, view_count, is_favorite)
     VALUES
       ($1, $2, $3, NULL, NULL, 0, 'html', 'QS27 drill public', NULL, NULL, NULL, 3, FALSE),
       ($4, $5, $6, NULL, NULL, 0, 'markdown', 'QS27 drill markdown', 'themed fixture', NULL, 'github', 7, TRUE),
       ($7, $8, $9, $10, $11, 1, 'html', 'QS27 drill protected', NULL, NULL, NULL, 1, FALSE),
       ($12, $13, $14, NULL, NULL, 0, 'html', 'QS27 drill expired', NULL, $15, NULL, 0, FALSE)`,
    [
      pages.publicHtml, '<h1>QS27 backup drill public</h1><!--drill-body-->', base,
      pages.markdownThemed, '# QS27 drill markdown', base + 1000,
      pages.protectedPage, '<p>QS27 drill secret</p>', base + 2000,
      passwordHash, encryptedPassword,
      pages.expiredPage, '<p>QS27 drill expired</p>', base + 3000, base - 1000
    ]
  );

  await pool.query(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, credential_version)
     VALUES ($1, $2, $3, $4, $5, $6, '9007199254740993')`,
    [
      FIXTURE.apiKey.id,
      FIXTURE.apiKey.name,
      await hashSecret(FIXTURE.apiKey.secret),
      FIXTURE.apiKey.secret.slice(0, 8),
      base,
      base + 500
    ]
  );

  await pool.query(
    `INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES
       ('page.create', $1, '{"drill":"public-html"}', '127.0.0.1', $5),
       ('page.create', $2, '{"drill":"markdown-themed"}', '127.0.0.1', $6),
       ('page.create', $3, '{"drill":"protected"}', '127.0.0.1', $7),
       ('page.create', $4, '{"drill":"expired"}', '127.0.0.1', $8),
       ('page.favorite.update', $2, '{"favorite":true}', '127.0.0.1', $9),
       ('api_key.create', NULL, '{"apiKeyId":"issue27key00001"}', '127.0.0.1', $10),
       ('admin.login', NULL, '{"drill":true}', '127.0.0.1', $11),
       ('page.delete', 'issue27gone0001', '{"drill":"pre-snapshot"}', '127.0.0.1', $12)`,
    [
      pages.publicHtml, pages.markdownThemed, pages.protectedPage, pages.expiredPage,
      base, base, base, base + 10, base + 20, base + 30, base + 40, base - 5000
    ]
  );

  await pool.query(
    'UPDATE site_settings SET homepage_password_required = FALSE, publishing_writes_paused = TRUE, updated_at = $1 WHERE id = 1',
    [base + 50]
  );

  const accessRevisionSeeded = await probeAccessRevisionColumn(pool);
  if (accessRevisionSeeded) {
    await pool.query(
      'UPDATE pages SET access_revision = $1 WHERE id = $2',
      [ACCESS_REVISION_DRILL_VALUE, FIXTURE.pages.protectedPage]
    );
  }

  const revisionsSeeded = await probeShareRevisionsTable(pool);
  if (revisionsSeeded) {
    // Snapshot provenance uses the real application vocabulary; hashes are
    // computed with the shared canonical digest so a tampered hash byte
    // fails the restore verification by field.
    const { contentSnapshotHash } = require('../utils/contentRevision');
    const hashOf = row => contentSnapshotHash({
      htmlContent: row.html_content,
      codeType: row.code_type,
      title: row.title,
      description: row.description,
      markdownTheme: row.markdown_theme
    });
    // Revision 1 baselines for every seeded Share, straight from the live
    // projection, exactly as the real baseline backfill would write them —
    // including the actual capture moment in created_at.
    const capturedAt = Date.now();
    const livePages = (await pool.query('SELECT id, html_content, code_type, title, description, markdown_theme, created_at FROM pages ORDER BY id ASC')).rows;
    for (const row of livePages) {
      const snapshot = {
        share_id: row.id,
        revision: 1,
        html_content: row.html_content,
        code_type: row.code_type || 'html',
        title: row.title,
        description: row.description,
        markdown_theme: row.markdown_theme,
        created_at: capturedAt
      };
      await pool.query(
        `INSERT INTO share_revisions (
           share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
           snapshot_hash, source, actor, restored_from
         )
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'baseline-backfill', 'maintenance:baseline-backfill', NULL)`,
        [snapshot.share_id, snapshot.html_content, snapshot.code_type, snapshot.title,
         snapshot.description, snapshot.markdown_theme, snapshot.created_at, hashOf(snapshot)]
      );
    }
    // Revision 2 models a managed-Key content update. Revision 3 then models
    // the real dashboard restore contract: it copies revision 1 byte-for-byte,
    // records restored_from=1 and becomes the materialized current pointer.
    const v2 = {
      share_id: pages.markdownThemed,
      html_content: '# QS27 drill markdown v2',
      code_type: 'markdown',
      title: 'QS27 drill markdown v2',
      description: 'themed fixture v2',
      markdown_theme: 'github',
      created_at: base + 1500
    };
    await pool.query(
      `INSERT INTO share_revisions (
         share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
         snapshot_hash, source, actor, restored_from
       )
       VALUES ($1, 2, $2, $3, $4, $5, $6, $7, $8, 'api-content-update', $9, NULL)`,
      [v2.share_id, v2.html_content, v2.code_type, v2.title, v2.description,
       v2.markdown_theme, v2.created_at, hashOf({ ...v2, revision: 2 }), `api-key:${FIXTURE.apiKey.id}`]
    );
    const restoreSource = (await pool.query(
      `SELECT html_content, code_type, title, description, markdown_theme, created_at
       FROM share_revisions WHERE share_id = $1 AND revision = 1`,
      [pages.markdownThemed]
    )).rows[0];
    const restoredV3 = { ...restoreSource, revision: 3, created_at: base + 1600 };
    await pool.query(
      `INSERT INTO share_revisions (
         share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
         snapshot_hash, source, actor, restored_from
       )
       VALUES ($1, 3, $2, $3, $4, $5, $6, $7, $8, 'dashboard-restore', 'owner-dashboard', 1)`,
      [pages.markdownThemed, restoredV3.html_content, restoredV3.code_type, restoredV3.title,
       restoredV3.description, restoredV3.markdown_theme, restoredV3.created_at, hashOf(restoredV3)]
    );
    await pool.query(
      `UPDATE pages SET current_revision = 3, html_content = $2, code_type = $3,
         title = $4, description = $5, markdown_theme = $6
       WHERE id = $1`,
      [pages.markdownThemed, restoredV3.html_content, restoredV3.code_type, restoredV3.title,
        restoredV3.description, restoredV3.markdown_theme]
    );
    // #35 publication-state fixture: the themed Share carries the exact end
    // state of a real owner unpublish — published FALSE and the bumped
    // access revision together, both non-default, both beyond float safety.
    // Restore must preserve the pair exactly; apps that ignore `published`
    // are NOT rollback candidates (see docs/deployment.md).
    await pool.query(
      'UPDATE pages SET published = FALSE, access_revision = $2::bigint WHERE id = $1',
      [pages.markdownThemed, UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE]
    );
    // A current pointer beyond 2^53 with real snapshot rows: BIGINT precision
    // must survive dump → restore without passing through a float.
    await pool.query(
      `INSERT INTO pages (id, html_content, created_at, code_type, title, current_revision)
       VALUES ($1, '<p>big revision body</p>', $2, 'html', 'QS27 big revision', $3)`,
      [pages.bigRevision, base + 4000, REVISION_DRILL_VALUE]
    );
    const bigSnapshot = {
      share_id: pages.bigRevision,
      html_content: '<p>big revision body</p>',
      code_type: 'html',
      title: 'QS27 big revision',
      description: null,
      markdown_theme: null,
      created_at: base + 4000
    };
    await pool.query(
      `INSERT INTO share_revisions (
         share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
         snapshot_hash, source, actor, restored_from
       )
       VALUES
         ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'baseline-backfill', 'maintenance:baseline-backfill', NULL),
         ($1, $9, $2, $3, $4, $5, $6, $7, $8, 'baseline-backfill', 'maintenance:baseline-backfill', NULL)`,
      [bigSnapshot.share_id, bigSnapshot.html_content, bigSnapshot.code_type, bigSnapshot.title,
       bigSnapshot.description, bigSnapshot.markdown_theme, bigSnapshot.created_at,
       hashOf(bigSnapshot), REVISION_DRILL_VALUE]
    );
  }

  const operationsSeeded = await probePublishOperationsTable(pool);
  if (operationsSeeded) {
    const receipt = encryptSecret(JSON.stringify({ password: '654321', isProtected: true }));
    // #33 restore/content-update receipts mirror the committed response
    // surface (no secrets): changed flag, source revision, policy display.
    const restoreReceipt = encryptSecret(JSON.stringify({ changed: true, sourceRevision: '1', isProtected: false, expiresAt: null }));
    const apiRestoreReceipt = encryptSecret(JSON.stringify({ changed: false, sourceRevision: '1' }));
    const updateReceipt = encryptSecret(JSON.stringify({ changed: true, isProtected: true, expiresAt: null }));
    // A Key-driven content-update receipt is intentionally bounded to the
    // changed result flag; it never persists content or policy metadata.
    await pool.query(
      `INSERT INTO publish_operations (
         actor_namespace, request_id, action, request_digest, target_id,
         result_share_id, result_revision, result_access_revision, receipt_encrypted, created_at, deleted_at
       )
       VALUES ($1, $2, 'create', $3, NULL, $4, '1', $5, $6, $7, NULL),
              ($1, $8, 'create', $9, NULL, $10, '1', $5, NULL, $7, $11),
              ($24, $12, 'restore', $13, $14, $14, '3', '1', $15, $7, NULL),
              ($1, $16, 'content-update', $17, $18, $18, '2', '1', $19, $7, NULL),
              ($1, $20, 'unpublish', $21, $14, $14, '3', $22, $23, $7, NULL),
              ($28, $25, 'restore', $26, $14, $14, '3', $22, $27, $7, NULL)`,
      [
        OPERATION_FIXTURE.namespace,
        OPERATION_FIXTURE.requestId,
        'd'.repeat(64),
        pages.publicHtml,
        ACCESS_REVISION_DRILL_VALUE,
        receipt,
        base + 60,
        OPERATION_FIXTURE.tombstoneRequestId,
        'e'.repeat(64),
        pages.expiredPage,
        base + 70,
        OPERATION_FIXTURE.restoreRequestId,
        'f'.repeat(64),
        pages.markdownThemed,
        restoreReceipt,
        OPERATION_FIXTURE.contentUpdateRequestId,
        '0'.repeat(64),
        pages.protectedPage,
        updateReceipt,
        OPERATION_FIXTURE.apiPublishRequestId,
        '3'.repeat(64),
        UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE,
        encryptSecret(JSON.stringify({ changed: false, published: false })),
        'dashboard-session:issue27-drill-session',
        OPERATION_FIXTURE.apiRestoreRequestId,
        '8'.repeat(64),
        apiRestoreReceipt,
        `managed-key:${FIXTURE.apiKey.id}`
      ]
    );
    await pool.query(
      `INSERT INTO publish_operations (
         actor_namespace, request_id, action, request_digest, target_id,
         result_share_id, result_revision, result_access_revision, receipt_encrypted, created_at, deleted_at
       )
       VALUES ($1, $2, 'content-update', $3, $4, $4, '2', '1', $5, $6, NULL)`,
      [OPERATION_FIXTURE.namespace, OPERATION_FIXTURE.apiContentUpdateRequestId,
        '7'.repeat(64), pages.markdownThemed,
        encryptSecret(JSON.stringify({ changed: true })), base + 80]
    );
  }

  // #34 purge fixture: one REAL tombstone revision (payload + hash NULL,
  // purged_at set) and one receipt-scrubbed operation whose committed result
  // was that revision. The verifier compares tombstones on identity and
  // provenance only and fails if any payload byte resurrects.
  const purgeSeeded = await probePurgeColumns(pool);
  if (purgeSeeded && revisionsSeeded && operationsSeeded) {
    const tombstoned = {
      share_id: pages.publicHtml,
      revision: 2,
      html_content: null,
      code_type: 'html',
      title: null,
      description: null,
      markdown_theme: null,
      created_at: base + 800,
      snapshot_hash: null,
      source: 'dashboard-edit',
      actor: 'owner-dashboard',
      restored_from: null,
      purged_at: base + 900
    };
    await pool.query(
      `INSERT INTO share_revisions (
         share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
         snapshot_hash, source, actor, restored_from, purged_at
       )
       VALUES ($1, 2, NULL, $2, NULL, NULL, NULL, $3, NULL, $4, $5, NULL, $6)`,
      [tombstoned.share_id, tombstoned.code_type, tombstoned.created_at,
       tombstoned.source, tombstoned.actor, tombstoned.purged_at]
    );
    await pool.query(
      `INSERT INTO publish_operations (
         actor_namespace, request_id, action, request_digest, target_id,
         result_share_id, result_revision, result_access_revision, receipt_encrypted, created_at, deleted_at, purged_at
       )
       VALUES ($1, $2, 'restore', $3, $4, $4, '2', $5, NULL, $6, NULL, $7)`,
      [
        OPERATION_FIXTURE.namespace,
        OPERATION_FIXTURE.purgedReceiptRequestId,
        '9'.repeat(64),
        pages.publicHtml,
        ACCESS_REVISION_DRILL_VALUE,
        base + 850,
        base + 900
      ]
    );
  }

  // #36/#37 grants fixture: one REAL read+edit grant from the fixture Key to
  // the themed Share. This is also rotation-survival evidence — the Key row
  // carries credential_version 9007199254740993 while both permissions remain
  // bound to the same logical key id. The auto-grant flag is intentionally on.
  const scopesSeeded = await probeApiKeyScopesColumn(pool);
  if (scopesSeeded) {
    await pool.query(
      'UPDATE api_keys SET scopes = $2::jsonb, auto_grant_new_share_edit = TRUE WHERE id = $1',
      [FIXTURE.apiKey.id, JSON.stringify(['share:create', 'share:read', 'share:update', 'share:publish'])]
    );
  }

  const grantsSeeded = await probeShareGrantsTable(pool);
  if (grantsSeeded) {
    await pool.query(
      `INSERT INTO share_grants (api_key_id, share_id, can_read, can_update, can_publish, created_at)
       VALUES ($1, $2, TRUE, TRUE, TRUE, $3)`,
      [FIXTURE.apiKey.id, pages.markdownThemed, base + 110]
    );
  }

  return { accessRevisionSeeded, revisionsSeeded, operationsSeeded, purgeSeeded, scopesSeeded, grantsSeeded };
}

const DOCKER_ID = /^[a-f0-9]{64}$/i;

async function inspectContainer(target, commandRunner = runCommand) {
  const result = await commandRunner([
    'docker', 'inspect', '--format',
    '{{.Id}}@@QS@@{{.State.Running}}@@QS@@{{.Config.Image}}@@QS@@{{json .NetworkSettings.Ports}}',
    target
  ]);
  if (result.code !== 0) {
    if (/no such (?:object|container)/i.test(result.stderr || '')) return null;
    throw new Error(`docker inspect ${target} failed: ${(result.stderr || '').trim().slice(0, 200)}`);
  }
  const fields = String(result.stdout || '').trim().split('@@QS@@');
  const [rawId, running, image, rawPorts] = fields;
  const id = String(rawId || '').toLowerCase();
  let ports;
  try {
    ports = JSON.parse(rawPorts);
  } catch {
    throw new Error(`docker inspect ${target} did not return valid published-port data`);
  }
  if (fields.length !== 4 || !DOCKER_ID.test(id) || !['true', 'false'].includes(running)
      || typeof image !== 'string' || image.length === 0) {
    throw new Error(`docker inspect ${target} did not return a valid container identity and image`);
  }
  return { id, running: running === 'true', image, ports };
}

function assertContainerInspectionMatchesDrillTarget(inspection, {
  id,
  name,
  port,
  image,
  endpoint,
  database,
  label = name
}) {
  if (!inspection || inspection.id !== id) {
    throw new Error(`${label} container name/ID identity changed; refusing database access`);
  }
  if (!inspection.running) {
    throw new Error(`${label} container ${id} is not running`);
  }
  if (inspection.image !== image) {
    throw new Error(`${label} container ${id} image does not match the expected PostgreSQL image`);
  }

  const published = inspection.ports && typeof inspection.ports === 'object' && !Array.isArray(inspection.ports)
    ? Object.entries(inspection.ports).filter(([, bindings]) => bindings !== null && bindings !== undefined)
      .flatMap(([containerPort, bindings]) => {
        if (!Array.isArray(bindings)) return [{ containerPort, malformed: true }];
        return bindings.map(binding => ({ containerPort, binding }));
      })
    : [];
  const pgBindings = inspection.ports?.['5432/tcp'];
  if (published.length !== 1 || published[0].containerPort !== '5432/tcp'
      || published[0].malformed || !Array.isArray(pgBindings) || pgBindings.length !== 1) {
    throw new Error(`${label} container ${id} must publish only one exact 5432/tcp loopback binding`);
  }
  const binding = pgBindings[0];
  if (!binding || binding.HostIp !== '127.0.0.1' || String(binding.HostPort) !== String(port)) {
    throw new Error(`${label} container ${id} must publish 5432/tcp on 127.0.0.1:${port}`);
  }

  if (endpoint && (endpoint.host !== '127.0.0.1'
      || String(endpoint.port) !== String(port) || endpoint.database !== database)) {
    throw new Error(`${label} effective PostgreSQL URL endpoint does not match its inspected container binding`);
  }
  return true;
}

async function ensureContainerRunning(name, port, image, { outputDir, ownedContainers, commandRunner = runCommand } = {}) {
  validateContainerName(name, 'Drill container');
  validatePort(port, 'Drill container port');
  if (!outputDir || !Array.isArray(ownedContainers)) throw new Error('Container creation needs an output directory and ownership ledger');
  const existing = await inspectContainer(name, commandRunner);
  if (existing) {
    throw new Error(`Refusing to reuse pre-existing ${existing.running ? 'running' : 'stopped'} container ${name} (${existing.id})`);
  }

  const cidfile = path.join(outputDir, `${name}.container-id`);
  if (fs.existsSync(cidfile)) throw new Error(`Container identity file already exists: ${cidfile}`);
  const result = await commandRunner([
    'docker', 'run', '-d', '--cidfile', cidfile, '--name', name,
    '-e', `POSTGRES_PASSWORD=${FIXTURE.password}`,
    '-p', `127.0.0.1:${port}:5432`, image
  ]);
  const cid = fs.existsSync(cidfile) ? fs.readFileSync(cidfile, 'utf8').trim().toLowerCase() : '';
  const stdoutId = String(result.stdout || '').trim().toLowerCase();
  const id = DOCKER_ID.test(cid) ? cid : (DOCKER_ID.test(stdoutId) ? stdoutId : '');
  if (id) ownedContainers.push({ id, name, port, image, cidfile });
  if (result.code !== 0) throw new Error(`docker run ${name} failed: ${(result.stderr || '').trim().slice(0, 200)}`);
  if (!id || (DOCKER_ID.test(cid) && DOCKER_ID.test(stdoutId) && cid !== stdoutId)) {
    throw new Error(`docker run ${name} did not produce a consistent full container ID`);
  }

  await assertContainerNameStillMapsToId(
    { id, name }, commandRunner,
    { port, image, label: name }
  );
  return ownedContainers.find(container => container.id === id);
}

async function assertContainerNameStillMapsToId(container, commandRunner = runCommand, expected = null) {
  const byName = await inspectContainer(container.name, commandRunner);
  const byId = await inspectContainer(container.id, commandRunner);
  if (!byName || !byId || byName.id !== container.id || byId.id !== container.id) {
    throw new Error(`Container name ${container.name} no longer maps to its preflight ID`);
  }
  if (expected) {
    const target = { id: container.id, name: container.name, ...expected };
    assertContainerInspectionMatchesDrillTarget(byName, target);
    assertContainerInspectionMatchesDrillTarget(byId, target);
  }
  return true;
}

async function waitForPostgres(containerId, timeoutMs = 60000, commandRunner = runCommand) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await commandRunner(['docker', 'exec', containerId, 'pg_isready', '-U', 'postgres'])).code === 0) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Postgres in container ${containerId} not ready after ${timeoutMs}ms`);
}

async function ensureDatabase(containerId, database, commandRunner = runCommand) {
  assertSqlDatabaseIdentifier(database, 'Database');
  const check = await commandRunner([
    'docker', 'exec', containerId, 'psql', '-XAt', '-U', 'postgres', '-c',
    `SELECT 1 FROM pg_database WHERE datname = '${database}'`
  ]);
  if (check.code !== 0) throw new Error(`Could not check database ${database}: ${(check.stderr || '').trim().slice(0, 200)}`);
  if (check.stdout.trim() !== '1') {
    const create = await commandRunner([
      'docker', 'exec', containerId, 'psql', '-XAt', '-U', 'postgres', '-c', `CREATE DATABASE ${database}`
    ]);
    if (create.code !== 0) throw new Error(`Could not create database ${database}: ${(create.stderr || '').trim().slice(0, 200)}`);
  }
}

async function cleanupOwnedContainer(container, commandRunner = runCommand) {
  if ((await inspectContainer(container.id, commandRunner))?.id !== container.id) {
    return { id: container.id, name: container.name, status: 'already-absent-or-identity-changed' };
  }
  // The exact ID is the ownership boundary: a same-name replacement can never
  // be selected by this command. --volumes removes only volumes attached to it.
  const removal = await commandRunner(['docker', 'rm', '--force', '--volumes', container.id]);
  if (removal.code !== 0) return { id: container.id, name: container.name, status: 'remove-failed' };
  const status = await inspectContainer(container.id, commandRunner) === null
    ? 'removed-exact-id' : 'removal-readback-failed';
  return { id: container.id, name: container.name, status };
}

async function resetSourceDatabase(url, { poolFactory = createPostgresPool, migrationRunner = runMigrations } = {}) {
  const pool = poolFactory(url, { env: localPoolEnv(url), max: 1 });

  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrationRunner(pool, { logger: { info() {} } });
    return await seedFixture(pool);
  } finally {
    await pool.end();
  }
}

async function recreateRestoreDatabase(restoreUrl, { poolFactory = createPostgresPool, restoreDatabase = FIXTURE.restoreDatabase } = {}) {
  assertSqlDatabaseIdentifier(restoreDatabase, 'Restore database');
  const controlUrl = restoreUrl.replace(/\/[^/]+$/, '/postgres');
  const pool = poolFactory(controlUrl, { env: localPoolEnv(controlUrl), max: 1 });

  try {
    await pool.query(`DROP DATABASE IF EXISTS ${restoreDatabase} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${restoreDatabase}`);
  } finally {
    await pool.end();
  }
}

async function runStep(command, args, label, env = process.env, commandRunner = runCommand) {
  const started = Date.now();
  const result = await commandRunner([command, ...args], { env });
  return { ...result, ms: Date.now() - started, label };
}

async function runDrill({
  keepContainers = false,
  skipContainerSetup = false,
  outputDir,
  commandRunner = runCommand,
  poolFactory = createPostgresPool,
  migrationRunner = runMigrations,
  readinessTimeoutMs = 60000
} = {}) {
  const sourceUrl = sourceUrlFor();
  const restoreUrl = restoreUrlFor();
  const targets = validateDrillTargets({
    sourceUrl, restoreUrl,
    sourceDatabase: FIXTURE.sourceDatabase,
    restoreDatabase: FIXTURE.restoreDatabase
  });
  validateContainerName(FIXTURE.srcContainer, 'Source container');
  validateContainerName(FIXTURE.restoreContainer, 'Restore container');
  validatePort(FIXTURE.srcPort, 'Source container port');
  validatePort(FIXTURE.restorePort, 'Restore container port');
  if (FIXTURE.srcContainer === FIXTURE.restoreContainer || FIXTURE.srcPort === FIXTURE.restorePort) {
    throw new Error('Drill source and restore containers must have distinct names and ports');
  }

  const dir = ensureFreshPrivateOutputDir(outputDir);
  const previousSecret = process.env.SESSION_SECRET;
  const ownedContainers = [];
  const shouldCleanup = !skipContainerSetup && !keepContainers;
  let sourceContainer;
  let restoreContainer;
  let summary;

  const cleanupCreated = async () => {
    const results = [];
    for (const container of [...ownedContainers].reverse()) {
      try { results.push(await cleanupOwnedContainer(container, commandRunner)); }
      catch { results.push({ id: container.id, name: container.name, status: 'cleanup-error' }); }
    }
    return results;
  };

  try {
    process.env.SESSION_SECRET = FIXTURE.sessionSecret;
    const sourceBefore = await inspectContainer(FIXTURE.srcContainer, commandRunner);
    const restoreBefore = await inspectContainer(FIXTURE.restoreContainer, commandRunner);
    if (skipContainerSetup) {
      if (!sourceBefore || !restoreBefore) throw new Error('--skip-container-setup requires both named containers to exist');
      sourceContainer = { id: sourceBefore.id, name: FIXTURE.srcContainer };
      restoreContainer = { id: restoreBefore.id, name: FIXTURE.restoreContainer };
    } else {
      if (sourceBefore) throw new Error(`Refusing to use pre-existing source container ${FIXTURE.srcContainer} (${sourceBefore.id})`);
      if (restoreBefore) throw new Error(`Refusing to use pre-existing restore container ${FIXTURE.restoreContainer} (${restoreBefore.id})`);
      sourceContainer = await ensureContainerRunning(FIXTURE.srcContainer, FIXTURE.srcPort, FIXTURE.image, {
        outputDir: dir, ownedContainers, commandRunner
      });
      restoreContainer = await ensureContainerRunning(FIXTURE.restoreContainer, FIXTURE.restorePort, FIXTURE.image, {
        outputDir: dir, ownedContainers, commandRunner
      });
    }

    await assertContainerNameStillMapsToId(sourceContainer, commandRunner, {
      port: FIXTURE.srcPort,
      image: FIXTURE.image,
      endpoint: targets.source,
      database: FIXTURE.sourceDatabase,
      label: 'Source'
    });
    await assertContainerNameStillMapsToId(restoreContainer, commandRunner, {
      port: FIXTURE.restorePort,
      image: FIXTURE.image,
      endpoint: targets.restore,
      database: FIXTURE.restoreDatabase,
      label: 'Restore'
    });
    await waitForPostgres(sourceContainer.id, readinessTimeoutMs, commandRunner);
    await waitForPostgres(restoreContainer.id, readinessTimeoutMs, commandRunner);
    await ensureDatabase(sourceContainer.id, FIXTURE.sourceDatabase, commandRunner);
    const seedResult = await resetSourceDatabase(sourceUrl, { poolFactory, migrationRunner });
    await recreateRestoreDatabase(restoreUrl, { poolFactory, restoreDatabase: FIXTURE.restoreDatabase });

    fs.writeFileSync(path.join(dir, 'fixture.json'), `${JSON.stringify({
      apiKeys: [{ id: FIXTURE.apiKey.id, secret: FIXTURE.apiKey.secret }],
      protectedPages: [{ id: FIXTURE.pages.protectedPage, password: FIXTURE.protectedPassword }]
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

    const childEnv = sanitizeChildEnv(process.env, { SESSION_SECRET: FIXTURE.sessionSecret });
    const backupRun = await runStep(process.execPath, [
      path.join(__dirname, 'backup-db.js'), '--url', sourceUrl, '--output-dir', dir, '--docker', sourceContainer.id
    ], 'backup', childEnv, commandRunner);
    if (backupRun.code !== 0) throw new Error(`backup failed: ${backupRun.stderr.trim().slice(0, 400)}`);

    const manifestFile = fs.readdirSync(dir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'));
    if (!manifestFile) throw new Error('Backup completed without producing its expected manifest');
    const manifestPath = path.join(dir, manifestFile);
    const restoreRun = await runStep(process.execPath, [
      path.join(__dirname, 'restore-db.js'), '--manifest', manifestPath,
      '--source-url', sourceUrl, '--target-url', restoreUrl,
      '--docker', restoreContainer.id, '--output', path.join(dir, 'restore-manifest.json')
    ], 'restore', childEnv, commandRunner);
    if (restoreRun.code !== 0) throw new Error(`restore failed: ${restoreRun.stderr.trim().slice(0, 400)}`);

    const verifyRun = await runStep(process.execPath, [
      path.join(__dirname, 'verify-backup.js'), '--source-url', sourceUrl, '--restore-url', restoreUrl,
      '--manifest', manifestPath, '--fixture', path.join(dir, 'fixture.json'),
      '--session-secret', FIXTURE.sessionSecret, '--output', path.join(dir, 'verification.json'), '--reconciled'
    ], 'verify', childEnv, commandRunner);
    if (verifyRun.code !== 0) throw new Error(`verification failed: ${verifyRun.stderr.trim().slice(0, 400)}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const restoreManifest = JSON.parse(fs.readFileSync(path.join(dir, 'restore-manifest.json'), 'utf8'));
    const verification = JSON.parse(fs.readFileSync(path.join(dir, 'verification.json'), 'utf8'));
    summary = {
      ok: true,
      snapshotAt: new Date(manifest.snapshotAt).toISOString(),
      snapshotWalLsn: manifest.snapshotWalLsn,
      accessRevision: seedResult.accessRevisionSeeded ? 'exercised' : 'absent-schema001-003',
      revisions: seedResult.revisionsSeeded ? 'exercised' : 'absent-schema001-006',
      operations: seedResult.operationsSeeded ? 'exercised' : 'absent-schema001-007',
      revisionPurgeTombstones: seedResult.purgeSeeded ? 'exercised' : 'absent-schema001-008',
      apiKeyScopes: seedResult.scopesSeeded ? 'exercised' : 'absent-schema001-009',
      shareGrants: seedResult.grantsSeeded ? 'exercised' : 'absent-schema001-009',
      reconciliation: verification.reconciliation.status,
      safeToServe: false,
      isolation: 'offline-by-default',
      postSnapshotRevocationOrPurgeMutations: false,
      durationsMs: {
        backupMs: manifest.durationsMs.dumpMs + manifest.durationsMs.snapshotMs,
        restoreMs: restoreManifest.durationsMs.restoreMs,
        verifyMs: verification.durationsMs.verifyMs
      },
      containers: {
        source: { id: sourceContainer.id, name: sourceContainer.name },
        restore: { id: restoreContainer.id, name: restoreContainer.name }
      },
      artifacts: {
        dump: path.join(dir, manifest.dumpFile), manifest: manifestPath,
        restoreManifest: path.join(dir, 'restore-manifest.json'),
        verification: path.join(dir, 'verification.json'), fixture: path.join(dir, 'fixture.json')
      }
    };
  } catch (error) {
    if (shouldCleanup) error.cleanup = await cleanupCreated();
    throw error;
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  if (shouldCleanup) {
    summary.cleanup = { status: 'exact-owned-id-cleanup', removed: await cleanupCreated() };
    if (summary.cleanup.removed.some(item => !['removed-exact-id', 'already-absent-or-identity-changed'].includes(item.status))) {
      throw new Error(`Exact-ID container cleanup did not fully verify: ${JSON.stringify(summary.cleanup.removed)}`);
    }
  } else {
    summary.cleanup = skipContainerSetup
      ? { status: 'skipped-existing-containers-never-cleaned', removed: [] }
      : { status: 'kept-created-containers', removed: [], retained: ownedContainers.map(({ id, name }) => ({ id, name })) };
  }
  return summary;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const summary = await runDrill({
    keepContainers: args.keepContainers === true,
    skipContainerSetup: args.skipContainerSetup === true,
    outputDir: args.outputDir || undefined
  });

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backup:check] failed: ${error.message}`);
    if (Array.isArray(error.cleanup)) {
      console.error(`[backup:check] cleanup: ${JSON.stringify(error.cleanup)}`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  ACCESS_REVISION_DRILL_VALUE,
  REVISION_DRILL_VALUE,
  UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE,
  OPERATION_FIXTURE,
  FIXTURE,
  assertSqlDatabaseIdentifier,
  assertContainerInspectionMatchesDrillTarget,
  assertContainerNameStillMapsToId,
  cleanupOwnedContainer,
  ensureContainerRunning,
  inspectContainer,
  probeAccessRevisionColumn,
  probeShareRevisionsTable,
  probePublishOperationsTable,
  probePurgeColumns,
  recreateRestoreDatabase,
  resetSourceDatabase,
  restoreUrlFor,
  runDrill,
  validateDrillTargets,
  seedFixture,
  sourceUrlFor
};
