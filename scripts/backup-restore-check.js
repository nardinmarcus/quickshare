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
  localPoolEnv,
  parseCliArgs,
  runCommand,
  sanitizeChildEnv
} = require('./backup-db');

const FIXTURE = {
  sessionSecret: 'qs27-issue27-drill-session-secret-0123456789abcdef',
  image: 'postgres:17-alpine',
  password: 'issue27local',
  srcContainer: 'issue27-pg-src',
  restoreContainer: 'issue27-pg-restore',
  srcPort: 5541,
  restorePort: 5542,
  sourceDatabase: 'issue27_src_test',
  restoreDatabase: 'issue27_restore_test',
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

function sourceUrlFor() {
  return `postgresql://postgres:${FIXTURE.password}@127.0.0.1:${FIXTURE.srcPort}/${FIXTURE.sourceDatabase}`;
}

function restoreUrlFor() {
  return `postgresql://postgres:${FIXTURE.password}@127.0.0.1:${FIXTURE.restorePort}/${FIXTURE.restoreDatabase}`;
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
    // A second revision on the themed Share proves multi-revision restore and
    // pointer movement; the materialized projection moves with it exactly as
    // a real content save would commit them together. Its restored_from is a
    // SYNTHETIC non-null value (there is no restore entry point in this
    // milestone); restore must preserve it exactly.
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
       VALUES ($1, 2, $2, $3, $4, $5, $6, $7, $8, 'dashboard-edit', 'owner-dashboard', 1)`,
      [v2.share_id, v2.html_content, v2.code_type, v2.title, v2.description,
       v2.markdown_theme, v2.created_at, hashOf({ ...v2, revision: 2 })]
    );
    await pool.query(
      `UPDATE pages SET current_revision = 2, html_content = '# QS27 drill markdown v2',
         title = 'QS27 drill markdown v2', description = 'themed fixture v2'
       WHERE id = $1`,
      [pages.markdownThemed]
    );
    // Non-default published fixture: restore must preserve it exactly.
    await pool.query('UPDATE pages SET published = FALSE WHERE id = $1', [pages.protectedPage]);
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

  return { accessRevisionSeeded, revisionsSeeded };
}

async function ensureContainerRunning(name, port, image) {
  const inspect = await runCommand(['docker', 'inspect', '-f', '{{.State.Running}}', name]);

  if (inspect.code === 0) {
    if (inspect.stdout.trim() === 'true') {
      return { created: false, started: false };
    }

    const start = await runCommand(['docker', 'start', name]);
    if (start.code !== 0) {
      throw new Error(`docker start ${name} failed: ${start.stderr.trim().slice(0, 200)}`);
    }
    return { created: false, started: true };
  }

  const run = await runCommand([
    'docker', 'run', '-d', '--name', name,
    '-e', `POSTGRES_PASSWORD=${FIXTURE.password}`,
    '-p', `127.0.0.1:${port}:5432`,
    image
  ]);

  if (run.code !== 0) {
    throw new Error(`docker run ${name} failed: ${run.stderr.trim().slice(0, 200)}`);
  }

  return { created: true, started: true };
}

async function waitForPostgres(container, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await runCommand(['docker', 'exec', container, 'pg_isready', '-U', 'postgres']);
    if (ready.code === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Postgres in ${container} not ready after ${timeoutMs}ms`);
}

async function ensureDatabase(container, database) {
  const check = await runCommand([
    'docker', 'exec', container, 'psql', '-U', 'postgres', '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${database}'`
  ]);

  if (check.stdout.trim() !== '1') {
    await runCommand(['docker', 'exec', container, 'psql', '-U', 'postgres', '-c', `CREATE DATABASE ${database}`]);
  }
}

async function resetSourceDatabase(url) {
  const pool = createPostgresPool(url, { env: localPoolEnv(url), max: 1 });

  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool, { logger: { info() {} } });
    return await seedFixture(pool);
  } finally {
    await pool.end();
  }
}

async function recreateRestoreDatabase(restoreUrl) {
  const controlUrl = restoreUrl.replace(/\/[^/]+$/, '/postgres');
  const pool = createPostgresPool(controlUrl, { env: localPoolEnv(controlUrl), max: 1 });

  try {
    await pool.query(`DROP DATABASE IF EXISTS ${FIXTURE.restoreDatabase} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${FIXTURE.restoreDatabase}`);
  } finally {
    await pool.end();
  }
}

async function runStep(command, args, label, env = process.env) {
  const started = Date.now();
  const result = await runCommand([command, ...args], { env });
  return { ...result, ms: Date.now() - started, label };
}

async function runDrill({ keepContainers = false, skipContainerSetup = false, outputDir } = {}) {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = FIXTURE.sessionSecret;

  const sourceUrl = sourceUrlFor();
  const restoreUrl = restoreUrlFor();
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'qs27-backup-check-'));

  try {
    if (!skipContainerSetup) {
      await ensureContainerRunning(FIXTURE.srcContainer, FIXTURE.srcPort, FIXTURE.image);
      await ensureContainerRunning(FIXTURE.restoreContainer, FIXTURE.restorePort, FIXTURE.image);
      await waitForPostgres(FIXTURE.srcContainer);
      await waitForPostgres(FIXTURE.restoreContainer);
    }

    await ensureDatabase(FIXTURE.srcContainer, FIXTURE.sourceDatabase);
    const seedResult = await resetSourceDatabase(sourceUrl);
    await recreateRestoreDatabase(restoreUrl);

    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({
      apiKeys: [{ id: FIXTURE.apiKey.id, secret: FIXTURE.apiKey.secret }],
      protectedPages: [{ id: FIXTURE.pages.protectedPage, password: FIXTURE.protectedPassword }]
    }, null, 2));

    const childEnv = sanitizeChildEnv(process.env, { SESSION_SECRET: FIXTURE.sessionSecret });
    const spawnOptions = { env: childEnv };
    const scriptsDir = __dirname;

    const backupRun = await runStep(process.execPath, [
      path.join(scriptsDir, 'backup-db.js'),
      '--url', sourceUrl,
      '--output-dir', dir,
      '--docker', FIXTURE.srcContainer
    ], 'backup', childEnv);
    if (backupRun.code !== 0) {
      throw new Error(`backup failed: ${backupRun.stderr.trim().slice(0, 400)}`);
    }

    const manifestFile = fs.readdirSync(dir)
      .find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'));
    const manifestPath = path.join(dir, manifestFile);

    const restoreRun = await runStep(process.execPath, [
      path.join(scriptsDir, 'restore-db.js'),
      '--manifest', manifestPath,
      '--target-url', restoreUrl,
      '--docker', FIXTURE.restoreContainer,
      '--output', path.join(dir, 'restore-manifest.json')
    ], 'restore', childEnv);
    if (restoreRun.code !== 0) {
      throw new Error(`restore failed: ${restoreRun.stderr.trim().slice(0, 400)}`);
    }

    const verifyRun = await runStep(process.execPath, [
      path.join(scriptsDir, 'verify-backup.js'),
      '--source-url', sourceUrl,
      '--restore-url', restoreUrl,
      '--manifest', manifestPath,
      '--fixture', path.join(dir, 'fixture.json'),
      '--session-secret', FIXTURE.sessionSecret,
      '--output', path.join(dir, 'verification.json'),
      // The drill's fixture is fully synthetic and its history is known, so
      // the drill itself provides the owner acknowledgment that real restores
      // require from a human. Without this flag verification fails closed.
      '--reconciled'
    ], 'verify', childEnv);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const verification = verifyRun.code === 0
      ? JSON.parse(fs.readFileSync(path.join(dir, 'verification.json'), 'utf8'))
      : null;
    const summary = {
      ok: verifyRun.code === 0,
      snapshotAt: new Date(manifest.snapshotAt).toISOString(),
      snapshotWalLsn: manifest.snapshotWalLsn,
      // Explicit coverage marker: 'exercised' only when the source schema
      // actually carries pages.access_revision (#25 migration 004). A 001–003
      // base must never claim schema004 coverage from this drill.
      accessRevision: seedResult.accessRevisionSeeded ? 'exercised' : 'absent-schema001-003',
      // Content-revision coverage (#30 migration 007): snapshots seeded, big
      // pointer exercised and non-default published preserved.
      revisions: seedResult.revisionsSeeded ? 'exercised' : 'absent-schema001-006',
      revisionCurrentPointer: seedResult.revisionsSeeded ? REVISION_DRILL_VALUE : null,
      publishedFixture: seedResult.revisionsSeeded ? 'non-default-false-exercised' : 'absent-schema001-006',
      reconciliation: verification ? verification.reconciliation.status : 'not-available',
      safeToServe: false,
      durationsMs: {
        backupMs: manifest.durationsMs.dumpMs + manifest.durationsMs.snapshotMs,
        restoreMs: JSON.parse(fs.readFileSync(path.join(dir, 'restore-manifest.json'), 'utf8')).durationsMs.restoreMs,
        verifyMs: verification ? verification.durationsMs.verifyMs : null
      },
      artifacts: {
        dump: manifest.dumpFile,
        manifest: manifestPath,
        restoreManifest: path.join(dir, 'restore-manifest.json'),
        verification: path.join(dir, 'verification.json')
      }
    };

    if (verifyRun.code !== 0) {
      summary.verificationOutput = verifyRun.stdout.trim().slice(0, 800);
    }

    return summary;
  } finally {
    process.env.SESSION_SECRET = previousSecret;

    if (!keepContainers) {
      // Only ever removes its own disposable drill containers.
      await runCommand(['docker', 'rm', '-f', FIXTURE.srcContainer]);
      await runCommand(['docker', 'rm', '-f', FIXTURE.restoreContainer]);
    }
  }
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
    process.exitCode = 1;
  });
}

module.exports = {
  ACCESS_REVISION_DRILL_VALUE,
  REVISION_DRILL_VALUE,
  FIXTURE,
  probeAccessRevisionColumn,
  probeShareRevisionsTable,
  recreateRestoreDatabase,
  resetSourceDatabase,
  restoreUrlFor,
  runDrill,
  seedFixture,
  sourceUrlFor
};
