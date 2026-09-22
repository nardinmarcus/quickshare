const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { sanitizeChildEnv, redactCommandArgs } = require('../../scripts/backup-db');

const sourceUrl = process.env.POSTGRES_BACKUP_TEST_SRC_URL;
const restoreUrl = process.env.POSTGRES_BACKUP_TEST_RESTORE_URL;

if (!sourceUrl || !restoreUrl) {
  throw new Error(
    'POSTGRES_BACKUP_TEST_SRC_URL and POSTGRES_BACKUP_TEST_RESTORE_URL are required ' +
    '(localhost PostgreSQL 17 databases ending in _test with matching pg tools via docker)'
  );
}

for (const [label, value] of [['source', sourceUrl], ['restore', restoreUrl]]) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !database.endsWith('_test')) {
    throw new Error(`${label} backup test URL must use localhost and a database ending in _test`);
  }
}

const {
  ACCESS_REVISION_DRILL_VALUE,
  REVISION_DRILL_VALUE,
  UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE,
  OPERATION_FIXTURE,
  FIXTURE,
  seedFixture
} = require('../../scripts/backup-restore-check');

const poolEnv = { POSTGRES_SSL: 'false' };
const expectedKeyComparedColumns = [
  'id', 'name', 'key_hash', 'key_prefix', 'created_at', 'last_used_at', 'credential_version'
];
const srcDocker = process.env.QS27_BACKUP_DOCKER_SRC || null;
const restoreDocker = process.env.QS27_BACKUP_DOCKER_RESTORE || null;

// Access Revision fixture gate state, resolved in test.before(). False on a
// schema 001–003 base: the access_revision branch is then EXPLICITLY skipped
// with a message naming the integrator's post-#25-merge obligation — it is
// never silently claimed.
let hasAccessRevision = false;
// Content Revision fixture gate (#30): false on a 001–006 base, where the
// share_revisions branches are explicitly skipped, never silently claimed.
let hasRevisions = false;
// Publish-operation fixture gate (#32): false on a 001–007 base.
let hasOperations = false;
// #34 purge fixture gate: false on a 001–008 base (no purged_at columns).
let hasPurgeColumns = false;

const childEnv = sanitizeChildEnv(process.env, { SESSION_SECRET: FIXTURE.sessionSecret });

let tmpDir;

let stepNumber = 0;
function runStep(command, args) {
  return new Promise((resolve, reject) => {
    const prefix = path.join(tmpDir, `step-${String(++stepNumber).padStart(3, '0')}`);
    fs.writeFileSync(`${prefix}.cmd`, JSON.stringify(redactCommandArgs([command, ...args])) + '\n');
    const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.writeFileSync(`${prefix}.exit`, String(code) + '\n');
      fs.writeFileSync(`${prefix}.raw.log`, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
      resolve({ code, stdout, stderr });
    });
  });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue29-backup-'));

  const sourcePool = createPostgresPool(sourceUrl, { env: poolEnv, max: 1 });
  const restoreTarget = new URL(restoreUrl);
  const restoreDatabase = decodeURIComponent(restoreTarget.pathname.slice(1));
  restoreTarget.pathname = '/postgres';
  const restoreControl = createPostgresPool(restoreTarget.href, {
    env: poolEnv,
    max: 1
  });

  try {
    // Fresh source database at a known migration state with a synthetic fixture.
    await sourcePool.query('DROP SCHEMA public CASCADE');
    await sourcePool.query('CREATE SCHEMA public');
    await runMigrations(sourcePool, { logger: { info() {} } });

    process.env.SESSION_SECRET = FIXTURE.sessionSecret;
    const seedResult = await seedFixture(sourcePool);
    hasAccessRevision = seedResult.accessRevisionSeeded === true;
    hasRevisions = seedResult.revisionsSeeded === true;
    hasOperations = seedResult.operationsSeeded === true;
    hasPurgeColumns = seedResult.purgeSeeded === true;

    // Recreate the restore database from scratch so the drill proves a full restore.
    const quotedDatabase = `"${restoreDatabase.replace(/"/g, '""')}"`;
    await restoreControl.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
    await restoreControl.query(`CREATE DATABASE ${quotedDatabase}`);
  } finally {
    await Promise.allSettled([sourcePool.end(), restoreControl.end()]);
  }

  fs.writeFileSync(path.join(tmpDir, 'fixture.json'), JSON.stringify({
    apiKeys: [{ id: FIXTURE.apiKey.id, secret: FIXTURE.apiKey.secret }],
    protectedPages: [{ id: FIXTURE.pages.protectedPage, password: FIXTURE.protectedPassword }]
  }, null, 2));
});

test.after(() => {
  // Keep all raw evidence, but fail if any newly persisted command leaks a
  // credential supplied to this run (including encoded URL-password forms).
  const secrets = new Set([FIXTURE.sessionSecret]);
  for (const value of [sourceUrl, restoreUrl]) {
    const url = new URL(value);
    if (url.password) {
      secrets.add(url.password);
      secrets.add(decodeURIComponent(url.password));
    }
    for (const [key, secret] of url.searchParams) {
      if (/(?:password|secret|token|api[-_]?key)$/i.test(key) && secret) {
        secrets.add(secret);
        secrets.add(encodeURIComponent(secret));
      }
    }
  }
  const commands = fs.readdirSync(tmpDir).filter(name => name.endsWith('.cmd'));
  assert.ok(commands.length > 0, 'command evidence must be present');
  for (const name of commands) {
    const recorded = fs.readFileSync(path.join(tmpDir, name), 'utf8');
    for (const secret of secrets) {
      assert.equal(recorded.includes(secret), false, `${name} must redact supplied credentials`);
      assert.equal(recorded.includes(JSON.stringify(secret).slice(1, -1)), false, `${name} must redact JSON-escaped credentials`);
    }
  }
});

test('native backup captures a consistent snapshot with matched tooling', async () => {
  const result = await runStep(process.execPath, [
    'scripts/backup-db.js',
    '--url', sourceUrl,
    '--output-dir', tmpDir,
    ...(srcDocker ? ['--docker', srcDocker] : [])
  ]);

  assert.equal(result.code, 0, `backup-db failed: ${result.stderr}`);

  const manifestPath = fs.readdirSync(tmpDir).find(name => name.endsWith('.manifest.json') && name.includes('quickshare-backup'));
  assert.ok(manifestPath, 'backup manifest written');

  const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, manifestPath), 'utf8'));
  assert.equal(manifest.kind, 'quickshare-native-consistent-backup');
  assert.equal(manifest.database, decodeURIComponent(new URL(sourceUrl).pathname.slice(1)));
  assert.equal(manifest.host, '127.0.0.1');
  assert.equal(manifest.format, 'custom');
  assert.match(manifest.dumpSha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.snapshotWalLsn, 'snapshot WAL LSN recorded');
  assert.ok(manifest.snapshotAt > 0, 'snapshot point recorded');
  assert.match(manifest.serverVersion, /^17\./);
  assert.ok(manifest.serverVersionNum >= 170000 && manifest.serverVersionNum < 180000);
  assert.match(manifest.toolVersion, /\(PostgreSQL\) 17/);
  assert.ok(Number.isFinite(manifest.durationsMs.dumpMs));
  assert.equal(manifest.testGuardBypassed, false);
  // The manifest must never carry the credentials of the connection actually
  // used for this run (the URL passwords), redacted or not.
  const connectionPasswords = [sourceUrl, restoreUrl]
    .map(value => { try { return decodeURIComponent(new URL(value).password); } catch { return ''; } })
    .filter(value => value.length > 0);
  for (const password of connectionPasswords) {
    assert.equal(JSON.stringify(manifest).includes(password), false, 'connection credentials never enter manifests');
  }
});

test('native restore rebuilds the database and passes full verification', async () => {
  const manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );

  const restoreResult = await runStep(process.execPath, [
    'scripts/restore-db.js',
    '--manifest', manifestPath,
    '--target-url', restoreUrl,
    ...(restoreDocker ? ['--docker', restoreDocker] : []),
    '--output', path.join(tmpDir, 'restore-manifest.json')
  ]);

  assert.equal(restoreResult.code, 0, `restore-db failed: ${restoreResult.stderr}`);

  const restoreManifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'restore-manifest.json'), 'utf8'));
  assert.equal(restoreManifest.kind, 'quickshare-native-restore');
  assert.equal(restoreManifest.isolation, 'offline-by-default');
  assert.equal(restoreManifest.sourceBackup.dumpSha256,
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dumpSha256);
  assert.ok(Number.isFinite(restoreManifest.durationsMs.restoreMs));

  const verifyResult = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--output', path.join(tmpDir, 'verification.json')
  ]);

  // Data checks all pass, but reconciliation is never 'not-required': even a
  // clean-looking audit history cannot prove the absence of policy changes.
  assert.equal(verifyResult.code, 2, 'clean data still requires owner reconciliation acknowledgment');

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification.json'), 'utf8'));
  assert.equal(report.ok, true, `verification issues: ${JSON.stringify(report.checks.flatMap(check => check.issues))}`);
  assert.equal(report.safeToServe, false);
  assert.equal(report.isolation, 'offline-by-default');
  assert.equal(report.reconciliation.status, 'owner-review-required');
  assert.match(report.reconciliation.reason, /owner review is required/i);

  const acknowledged = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--output', path.join(tmpDir, 'verification-acknowledged.json'),
    '--reconciled'
  ]);

  assert.equal(acknowledged.code, 0, 'bare --reconciled flag must work and acknowledge owner review');

  const acknowledgedReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-acknowledged.json'), 'utf8'));
  assert.equal(acknowledgedReport.reconciliation.status, 'owner-review-required');
  assert.equal(acknowledgedReport.ok, true);

  const checkNames = report.checks.map(check => check.name);
  for (const expected of [
    'pageInventory', 'migrationLedger', 'auditLogs', 'managedApiKeys',
    'siteSettings', 'expiry', 'passwordVerifyAndDecrypt'
  ]) {
    assert.ok(checkNames.includes(expected), `check ${expected} present`);
  }

  assert.deepEqual(report.coveredObjects, [
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
  ]);
  assert.ok(Number.isFinite(report.durationsMs.verifyMs));

  const settingsCheck = report.checks.find(check => check.name === 'siteSettings');
  assert.equal(settingsCheck.details.comparedColumns.includes('publishing_writes_paused'), true);
  const pageCheck = report.checks.find(check => check.name === 'pageInventory');
  assert.equal(pageCheck.details.pageCount, hasRevisions ? 5 : 4);
  assert.equal(pageCheck.details.comparedColumns.includes('markdown_theme'), true);
  assert.equal(pageCheck.details.comparedColumns.includes('is_favorite'), true);
  assert.equal(pageCheck.details.comparedColumns.includes('expires_at'), true);

  if (hasAccessRevision) {
    // Full-row verification must name the access_revision column explicitly
    // and the decimal string beyond the JS safe-integer range must survive
    // dump→restore exactly (pg returns int8 as a string; assert the string).
    assert.equal(pageCheck.details.comparedColumns.includes('access_revision'), true);
    const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
    try {
      const restored = await restorePool.query(
        'SELECT access_revision FROM pages WHERE id = $1',
        [FIXTURE.pages.protectedPage]
      );
      assert.equal(restored.rows[0].access_revision, ACCESS_REVISION_DRILL_VALUE);
      assert.equal(typeof restored.rows[0].access_revision, 'string');
      const restoredKey = await restorePool.query('SELECT credential_version FROM api_keys WHERE id = $1', [FIXTURE.apiKey.id]);
      assert.equal(restoredKey.rows[0].credential_version, '9007199254740993');
      assert.equal((await restorePool.query("SELECT version FROM quickshare_schema_migrations WHERE version = '006'")).rowCount, 1);
      const settings = await restorePool.query('SELECT publishing_writes_paused FROM site_settings WHERE id = 1');
      assert.equal(settings.rows[0].publishing_writes_paused, true, 'non-default maintenance setting survives native restore');
      const ledger = await restorePool.query("SELECT version FROM quickshare_schema_migrations WHERE version = '005'");
      assert.equal(ledger.rowCount, 1);
    } finally {
      await restorePool.end();
    }
  } else {
    // Schema 001–003 base: the column must NOT be claimed as covered.
    assert.equal(pageCheck.details.comparedColumns.includes('access_revision'), false);
  }

  if (hasRevisions) {
    // #30: the new revision object and current pointer are verified with
    // named columns and exact big-value preservation.
    assert.equal(pageCheck.details.comparedColumns.includes('current_revision'), true, 'current_revision must be a named compared column');
    assert.equal(pageCheck.details.comparedColumns.includes('published'), true, 'published must be a named compared column');
    const revisionsCheck = report.checks.find(check => check.name === 'shareRevisions');
    assert.equal(revisionsCheck.ok, true, `snapshot inventory issues: ${JSON.stringify(revisionsCheck.issues)}`);
    assert.deepEqual(revisionsCheck.details.comparedColumns, [
      'share_id', 'revision', 'html_content', 'code_type', 'title', 'description', 'markdown_theme', 'created_at',
      'snapshot_hash', 'source', 'actor', 'restored_from', ...(hasPurgeColumns ? ['purged_at'] : [])
    ]);
    if (hasPurgeColumns) {
      assert.ok(revisionsCheck.details.snapshotCount >= 8, 'baselines + v2 + big-pointer + #34 tombstone snapshots restored');
      assert.equal(revisionsCheck.details.tombstoneCount, 1,
        '#34: exactly one purge tombstone is inventoried, compared on identity/provenance only');
      const operationsCheck34 = report.checks.find(check => check.name === 'publishOperations');
      assert.equal(operationsCheck34.details.receiptPurgedCount, 1,
        '#34: the receipt-scrubbed operation is inventoried');
    } else {
      assert.ok(revisionsCheck.details.snapshotCount >= 7, 'baselines + v2 + big-pointer snapshots restored');
    }
    const pointerCheck = report.checks.find(check => check.name === 'revisionCurrentPointer');
    assert.equal(pointerCheck.ok, true, `pointer issues: ${JSON.stringify(pointerCheck.issues)}`);

    const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
    try {
      const restoredPointer = await restorePool.query(
        'SELECT current_revision, published FROM pages WHERE id = $1',
        [FIXTURE.pages.bigRevision]
      );
      assert.equal(restoredPointer.rows[0].current_revision, REVISION_DRILL_VALUE, 'big pointer stays an exact decimal string');
      assert.equal(typeof restoredPointer.rows[0].current_revision, 'string');
      assert.equal(restoredPointer.rows[0].published, true);
      const restoredSnapshot = await restorePool.query(
        'SELECT html_content, source, actor, restored_from FROM share_revisions WHERE share_id = $1 AND revision = $2',
        [FIXTURE.pages.bigRevision, REVISION_DRILL_VALUE]
      );
      assert.equal(restoredSnapshot.rowCount, 1);
      assert.equal(restoredSnapshot.rows[0].html_content, '<p>big revision body</p>');
      assert.equal(restoredSnapshot.rows[0].source, 'baseline-backfill', 'snapshot provenance restores with the payload');
      assert.equal(restoredSnapshot.rows[0].actor, 'maintenance:baseline-backfill');
      assert.equal(restoredSnapshot.rows[0].restored_from, null);
      const restoredV2 = await restorePool.query(
        'SELECT title, current_revision FROM pages WHERE id = $1',
        [FIXTURE.pages.markdownThemed]
      );
      assert.equal(restoredV2.rows[0].current_revision, '2', 'moved pointer restores exactly');
      const restoredV2Row = await restorePool.query(
        'SELECT snapshot_hash, source, actor, restored_from FROM share_revisions WHERE share_id = $1 AND revision = 2',
        [FIXTURE.pages.markdownThemed]
      );
      assert.equal(restoredV2Row.rows[0].source, 'dashboard-edit');
      assert.equal(restoredV2Row.rows[0].actor, 'owner-dashboard');
      assert.equal(restoredV2Row.rows[0].restored_from, '1', 'synthetic non-null restore origin survives byte-exact (BIGINT as decimal string)');
      assert.match(restoredV2Row.rows[0].snapshot_hash, /^[0-9a-f]{64}$/);
      const restoredPublished = await restorePool.query(
        'SELECT published, access_revision FROM pages WHERE id = $1',
        [FIXTURE.pages.markdownThemed]
      );
      // #35 publication-state coverage: the REAL owner-unpublish end state —
      // published FALSE and the bumped access revision TOGETHER — survives
      // restore byte-exactly. Losing either half must fail verification.
      assert.equal(restoredPublished.rows[0].published, false, 'the unpublish state survives restore');
      assert.equal(
        String(restoredPublished.rows[0].access_revision),
        UNPUBLISHED_ACCESS_REVISION_DRILL_VALUE,
        'the unpublish bump travels as an exact decimal string (beyond 2^53)'
      );
    } finally {
      await restorePool.end();
    }
  } else {
    // Schema 001–006 base: the revision objects must NOT be claimed covered.
    assert.equal(pageCheck.details.comparedColumns.includes('current_revision'), false);
    assert.equal(pageCheck.details.comparedColumns.includes('published'), false);
    assert.equal(report.checks.some(check => check.name === 'shareRevisions'), false);
  }

  const passwordCheck = report.checks.find(check => check.name === 'passwordVerifyAndDecrypt');
  assert.deepEqual(passwordCheck.details, { protectedPages: 1, fixtureCovered: 1 });
  const keyCheck = report.checks.find(check => check.name === 'managedApiKeys');
  assert.deepEqual(keyCheck.details, { keys: 1, fixtureCovered: 1, comparedColumns: expectedKeyComparedColumns });

  // #32/#33: publish-operation coverage in the main verification report.
  if (hasOperations) {
    const operationsCheck = report.checks.find(check => check.name === 'publishOperations');
    assert.ok(operationsCheck, 'the publishOperations check is always reported when the table exists');
    assert.equal(operationsCheck.ok, true, `operation issues: ${JSON.stringify(operationsCheck.issues)}`);
    assert.equal(operationsCheck.details.operationCount, hasPurgeColumns ? 6 : 5,
      'committed creation + tombstone + #33 restore + #33 content-update (+ #34 receipt-purged) + #35 unpublish restored');
    assert.equal(operationsCheck.details.tombstoneCount, 1, 'the deletion tombstone restores as a tombstone');
    if (hasPurgeColumns) {
      assert.equal(operationsCheck.details.receiptPurgedCount, 1,
        '#34: the receipt-scrubbed operation restores with its purged_at marker');
    }
    assert.deepEqual(operationsCheck.details.comparedColumns, [
      'actor_namespace', 'request_id', 'action', 'request_digest', 'target_id',
      'result_share_id', 'result_revision', 'result_access_revision',
      'receipt_encrypted', 'created_at', 'deleted_at',
      ...(hasPurgeColumns ? ['purged_at'] : [])
    ]);
    const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
    try {
      const restoredOps = await restorePool.query(
        'SELECT request_id, receipt_encrypted, deleted_at FROM publish_operations ORDER BY request_id ASC');
      assert.equal(restoredOps.rows[0].receipt_encrypted !== null, true, 'the encrypted receipt travels byte-identically');
      assert.equal(restoredOps.rows[1].receipt_encrypted, null, 'the tombstone carries no receipt');
      assert.notEqual(restoredOps.rows[1].deleted_at, null);
      // #33 rows restore with their non-secret receipts and provenance.
      const restoreRow = restoredOps.rows.find(row => row.request_id === OPERATION_FIXTURE.restoreRequestId);
      const updateRow = restoredOps.rows.find(row => row.request_id === OPERATION_FIXTURE.contentUpdateRequestId);
      assert.ok(restoreRow && restoreRow.receipt_encrypted, 'the #33 restore row carries its encrypted receipt');
      assert.ok(updateRow && updateRow.receipt_encrypted, 'the #33 content-update row carries its encrypted receipt');
      // #35: the unpublish ledger row travels with its receipt, proving the
      // publish-action history is part of every trustworthy backup.
      const unpublishRow = restoredOps.rows.find(row => row.request_id === OPERATION_FIXTURE.unpublishRequestId);
      assert.ok(unpublishRow && unpublishRow.receipt_encrypted, 'the #35 unpublish row carries its receipt');
    } finally {
      await restorePool.end();
    }
  } else {
    assert.equal(report.checks.some(check => check.name === 'publishOperations'), false);
  }
});

test('a tampered #33 restore operation receipt fails verification by its own request id', async (t) => {
  if (!hasOperations) {
    return t.skip('publish_operations absent on schema 001-007 base; integrator must exercise after merging #32');
  }

  // Fresh drill: the main manifest/restore pair was already tampered with by
  // an earlier test, so re-run the whole drill into a clean directory.
  const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue33-restore-drill-'));
  fs.writeFileSync(path.join(drillDir, 'fixture.json'), JSON.stringify({
    apiKeys: [{ id: FIXTURE.apiKey.id, secret: FIXTURE.apiKey.secret }],
    protectedPages: [{ id: FIXTURE.pages.protectedPage, password: FIXTURE.protectedPassword }]
  }, null, 2));
  const backup = await runStep(process.execPath, [
    'scripts/backup-db.js',
    '--url', sourceUrl, '--output-dir', drillDir,
    ...(srcDocker ? ['--docker', srcDocker] : [])
  ]);
  assert.equal(backup.code, 0, backup.stderr);
  const manifestPath = path.join(drillDir, fs.readdirSync(drillDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restore = await runStep(process.execPath, [
    'scripts/restore-db.js', '--manifest', manifestPath, '--target-url', restoreUrl,
    ...(restoreDocker ? ['--docker', restoreDocker] : [])
  ]);
  assert.equal(restore.code, 0, restore.stderr);

  // Named tamper: corrupt ONLY the #33 restore row's receipt on the restore
  // side. The verifier must fail and name that request id — never a vague
  // overall mismatch, and never a pass that waves the restore ledger through.
  const tamperPool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await tamperPool.query(
      'UPDATE publish_operations SET receipt_encrypted = $2 WHERE request_id = $1',
      [OPERATION_FIXTURE.restoreRequestId, 'secret-v1$tampered$tampered$tampered']
    );
  } finally {
    await tamperPool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(drillDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(drillDir, 'verification-restore-tamper.json')
  ]);
  assert.equal(result.code, 1);

  try {
    const report = JSON.parse(fs.readFileSync(path.join(drillDir, 'verification-restore-tamper.json'), 'utf8'));
    assert.equal(report.safeToServe, false);
    const operationsCheck = report.checks.find(check => check.name === 'publishOperations');
    assert.equal(operationsCheck.ok, false, 'the dedicated operations check must fail, not only the overall exit');
    assert.ok(operationsCheck.issues.some(issue =>
      issue.field === 'publish_operations'
      && issue.requestId === OPERATION_FIXTURE.restoreRequestId
      && issue.message.includes('receipt_encrypted')), `issues: ${JSON.stringify(operationsCheck.issues)}`);
  } finally {
    // Shared restore target: wipe the named tamper so later tests observe
    // the manifest-clean state they expect.
    const cleanup = await runStep(process.execPath, [
      'scripts/restore-db.js', '--manifest', manifestPath, '--target-url', restoreUrl,
      ...(restoreDocker ? ['--docker', restoreDocker] : [])
    ]);
    assert.equal(cleanup.code, 0, cleanup.stderr);
    // Keep the named tamper report and fixture beside the raw attempt logs.
  }
});

test('post-snapshot revocations in the real audit vocabulary fail closed', async () => {
  const manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );

  const sourcePool = createPostgresPool(sourceUrl, { env: poolEnv, max: 1 });
  try {
    // Exactly what app.js emits for a policy change via the dashboard edit
    // route: action 'page.update' with details { fields: [...] }.
    await sourcePool.query(
      'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['page.update', FIXTURE.pages.protectedPage,
        JSON.stringify({ fields: ['isProtected', 'passwordHash', 'encryptedPassword'] }), '127.0.0.1', Date.now()]
    );
    // And a purge + expiry change, also after the snapshot point.
    await sourcePool.query(
      'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['page.delete', FIXTURE.pages.publicHtml, JSON.stringify({ drill: true }), '127.0.0.1', Date.now()]
    );
    await sourcePool.query(
      'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['page.update', FIXTURE.pages.markdownThemed, JSON.stringify({ fields: ['expiresAt'] }), '127.0.0.1', Date.now()]
    );
  } finally {
    await sourcePool.end();
  }

  const blocked = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--output', path.join(tmpDir, 'verification-blocked.json')
  ]);

  assert.equal(blocked.code, 2, 'unreconciled post-snapshot revocations exit 2');

  const blockedReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-blocked.json'), 'utf8'));
  assert.equal(blockedReport.ok, true, 'data parity holds; the gate is reconciliation, not row drift');
  assert.equal(blockedReport.reconciliation.status, 'unreconciled');
  assert.equal(blockedReport.safeToServe, false);
  assert.deepEqual(blockedReport.postSnapshotRevocations.map(event => event.action),
    ['page.update', 'page.delete', 'page.update']);
  assert.deepEqual(
    blockedReport.postSnapshotRevocations.find(event => event.fields).fields,
    ['isProtected', 'passwordHash', 'encryptedPassword']
  );

  const reconciled = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--reconciled',
    '--output', path.join(tmpDir, 'verification-reconciled.json')
  ]);

  assert.equal(reconciled.code, 0, 'owner-acknowledged reconciliation passes data checks');
});

test('verification catches content drift in the restored database', async () => {
  const manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });

  try {
    await restorePool.query('UPDATE pages SET html_content = $1 WHERE id = $2', [
      '<h1>mutated during drill</h1>',
      FIXTURE.pages.markdownThemed === 'issue27md00010' ? 'issue27pub0010' : FIXTURE.pages.publicHtml
    ]);
  } finally {
    await restorePool.end();
  }

  const drift = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--output', path.join(tmpDir, 'verification-drift.json')
  ]);

  assert.equal(drift.code, 1, 'content drift exits 1');

  const driftReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-drift.json'), 'utf8'));
  assert.equal(driftReport.ok, false);
  const driftPageCheck = driftReport.checks.find(check => check.name === 'pageInventory');
  assert.equal(driftPageCheck.ok, false);
  assert.ok(driftPageCheck.issues.some(issue => issue.field === 'html_content' && /sha256 drift/.test(issue.message)));
});

test('verification refuses to claim credential checks passed without fixture coverage', async () => {
  const manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );

  // An empty fixture cannot exercise any protected page or managed key: the
  // verifier must fail with explicit incomplete-coverage issues instead of
  // silently reporting those functional checks as verified.
  fs.writeFileSync(path.join(tmpDir, 'fixture-minimal.json'), JSON.stringify({ apiKeys: [], protectedPages: [] }));

  const uncovered = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture-minimal.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--reconciled',
    '--output', path.join(tmpDir, 'verification-uncovered.json')
  ]);

  assert.equal(uncovered.code, 1, 'missing fixture coverage exits 1');

  const uncoveredReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-uncovered.json'), 'utf8'));
  const passwordCheck = uncoveredReport.checks.find(check => check.name === 'passwordVerifyAndDecrypt');
  const keyCheck = uncoveredReport.checks.find(check => check.name === 'managedApiKeys');

  assert.equal(passwordCheck.ok, false);
  assert.ok(passwordCheck.issues.some(issue =>
    issue.pageId === FIXTURE.pages.protectedPage && /incomplete fixture coverage/.test(issue.message)));
  assert.deepEqual(passwordCheck.details, { protectedPages: 1, fixtureCovered: 0 });

  assert.equal(keyCheck.ok, false);
  assert.ok(keyCheck.issues.some(issue =>
    issue.keyId === FIXTURE.apiKey.id && /incomplete fixture coverage/.test(issue.message)));
  assert.deepEqual(keyCheck.details, { keys: 1, fixtureCovered: 0, comparedColumns: expectedKeyComparedColumns });
});

test('maintenance setting drift fails the full-row backup verifier', async () => {
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query('UPDATE site_settings SET publishing_writes_paused = FALSE WHERE id = 1');
    const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
    const result = await runStep(process.execPath, [
      'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
      '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
      '--session-secret', FIXTURE.sessionSecret, '--reconciled',
      '--output', path.join(tmpDir, 'verification-maintenance-tamper.json')
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-maintenance-tamper.json')));
    assert.equal(report.safeToServe, false);
    assert.equal(report.checks.find(check => check.name === 'siteSettings').ok, false);
  } finally {
    await restorePool.query('UPDATE site_settings SET publishing_writes_paused = TRUE WHERE id = 1');
    await restorePool.end();
  }
});

test('credential_version drift alone fails native backup verification', async () => {
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query('UPDATE api_keys SET credential_version = credential_version + 1 WHERE id = $1', [FIXTURE.apiKey.id]);
    const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
    const result = await runStep(process.execPath, [
      'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
      '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
      '--session-secret', FIXTURE.sessionSecret, '--reconciled',
      '--output', path.join(tmpDir, 'verification-key-version-tamper.json')
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-key-version-tamper.json')));
    assert.equal(report.safeToServe, false);
    const keyCheck = report.checks.find(check => check.name === 'managedApiKeys');
    assert.equal(keyCheck.ok, false);
    assert.deepEqual(keyCheck.details, { keys: 1, fixtureCovered: 1, comparedColumns: expectedKeyComparedColumns });
  } finally {
    await restorePool.query("UPDATE api_keys SET credential_version = '9007199254740993' WHERE id = $1", [FIXTURE.apiKey.id]);
    await restorePool.end();
  }
});

test('access_revision tamper in the restored database fails verification', async (t) => {
  if (!hasAccessRevision) {
    // Honest skip on this worktree: schema 001–003 has no access_revision
    // column. The independent integrator MUST run this suite after merging
    // #25 (migration 004) so the seeded non-default value, exact decimal
    // string preservation and this tamper gate execute for real.
    return t.skip('access_revision absent on schema 001-003 base; integrator must exercise after merging #25');
  }

  const manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });

  try {
    // Restored-only tamper: source keeps the seeded value, the restored copy
    // drifts by one. The existing full-row verifier must reject it by name.
    await restorePool.query(
      'UPDATE pages SET access_revision = access_revision + 1 WHERE id = $1',
      [FIXTURE.pages.protectedPage]
    );
  } finally {
    await restorePool.end();
  }

  const tampered = await runStep(process.execPath, [
    'scripts/verify-backup.js',
    '--source-url', sourceUrl,
    '--restore-url', restoreUrl,
    '--manifest', manifestPath,
    '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret,
    '--reconciled',
    '--output', path.join(tmpDir, 'verification-access-revision-tamper.json')
  ]);

  assert.equal(tampered.code, 1, 'restored-only access_revision tamper exits 1');

  const tamperReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-access-revision-tamper.json'), 'utf8'));
  const tamperPageCheck = tamperReport.checks.find(check => check.name === 'pageInventory');
  assert.equal(tamperPageCheck.ok, false);
  assert.ok(tamperPageCheck.issues.some(issue =>
    issue.field === 'access_revision'
    && issue.message.includes(ACCESS_REVISION_DRILL_VALUE)
    && issue.message.includes('9007199254740994')));
});

test('snapshot payload tamper fails the share-revisions check by field and key', async (t) => {
  if (!hasRevisions) {
    return t.skip('share_revisions absent on schema 001-006 base; integrator must exercise after merging #30');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      'UPDATE share_revisions SET html_content = $1 WHERE share_id = $2 AND revision = 2',
      ['<p>tampered snapshot payload</p>', FIXTURE.pages.markdownThemed]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-snapshot-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-snapshot-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const revisionsCheck = report.checks.find(check => check.name === 'shareRevisions');
  assert.equal(revisionsCheck.ok, false, 'the dedicated snapshot check must fail, not only the overall exit');
  assert.ok(revisionsCheck.issues.some(issue =>
    issue.field === 'html_content'
    && issue.shareId === FIXTURE.pages.markdownThemed
    && issue.revision === '2'
    && /tampered snapshot payload/.test(issue.message)), `issues: ${JSON.stringify(revisionsCheck.issues)}`);
});

test('current_revision pointer tamper fails the pointer-consistency check by name', async (t) => {
  if (!hasRevisions) {
    return t.skip('share_revisions absent on schema 001-006 base; integrator must exercise after merging #30');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      'UPDATE pages SET current_revision = 9 WHERE id = $1',
      [FIXTURE.pages.publicHtml]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-pointer-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-pointer-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const pointerCheck = report.checks.find(check => check.name === 'revisionCurrentPointer');
  assert.equal(pointerCheck.ok, false, 'the dedicated pointer check must fail, not only the overall exit');
  assert.ok(pointerCheck.issues.some(issue =>
    issue.field === 'current_revision'
    && issue.pageId === FIXTURE.pages.publicHtml
    && /has no snapshot row/.test(issue.message)), `issues: ${JSON.stringify(pointerCheck.issues)}`);
});

test('published tamper fails the full-row page inventory with a named field issue', async (t) => {
  if (!hasRevisions) {
    return t.skip('published absent on schema 001-006 base; integrator must exercise after merging #30');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    // The themed Share is the #35 unpublished fixture (published FALSE):
    // flipping it TRUE on the restore side must fail verification by name.
    await restorePool.query(
      'UPDATE pages SET published = TRUE WHERE id = $1',
      [FIXTURE.pages.markdownThemed]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-published-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-published-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const pageCheck = report.checks.find(check => check.name === 'pageInventory');
  assert.equal(pageCheck.ok, false);
  assert.ok(pageCheck.issues.some(issue =>
    issue.field === 'published'
    && issue.pageId === FIXTURE.pages.markdownThemed
    && /published/.test(issue.message)), `issues: ${JSON.stringify(pageCheck.issues)}`);
});

test('an unpublish-state tamper fails verification and reverting the restore returns to exit 0', async (t) => {
  if (!hasRevisions || !hasAccessRevision) {
    return t.skip('publication-state columns absent on this schema base; integrator must exercise after merging #35');
  }

  // Named tamper chain, part 1: on the restore side ONLY, resurrect the
  // unpublished Share by flipping published — the exact failure mode of a
  // rollback target that ignores `published`. The verifier must exit 1 and
  // name the page and field; it must never wave the restore through.
  let manifestPath = path.join(
    tmpDir,
    fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json'))
  );
  const tamperPool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await tamperPool.query(
      'UPDATE pages SET published = TRUE WHERE id = $1',
      [FIXTURE.pages.markdownThemed]
    );
  } finally {
    await tamperPool.end();
  }

  const tampered = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-unpublish-tamper.json')
  ]);
  assert.equal(tampered.code, 1, 'the resurrected unpublished Share fails verification (exit 1)');

  const tamperReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-unpublish-tamper.json'), 'utf8'));
  assert.equal(tamperReport.safeToServe, false, 'a resurrected Share is never safe to serve');
  const tamperPageCheck = tamperReport.checks.find(check => check.name === 'pageInventory');
  assert.equal(tamperPageCheck.ok, false);
  assert.ok(tamperPageCheck.issues.some(issue =>
    issue.field === 'published' && issue.pageId === FIXTURE.pages.markdownThemed),
    `issues: ${JSON.stringify(tamperPageCheck.issues)}`);

  // Named tamper chain, part 2: REVERT by re-restoring the SAME manifest
  // into the target, then verification returns to exit 0 — proving the
  // revert path (not a stale pass) restores a trustworthy state.
  const revert = await runStep(process.execPath, [
    'scripts/restore-db.js', '--manifest', manifestPath, '--target-url', restoreUrl,
    ...(restoreDocker ? ['--docker', restoreDocker] : [])
  ]);
  assert.equal(revert.code, 0, revert.stderr);

  const reverted = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-unpublish-reverted.json')
  ]);
  assert.equal(reverted.code, 0, 'after the revert the full verification passes again');

  const revertedReport = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-unpublish-reverted.json'), 'utf8'));
  assert.equal(revertedReport.safeToServe, false, 'even a clean verify stays fail-closed without owner reconciliation (--reconciled was given, safeToServe remains an operator decision)');
});

test('publish_operations receipt tamper fails the dedicated operations check by namespace and request id', async (t) => {
  if (!hasOperations) {
    return t.skip('publish_operations absent on schema 001-007 base; integrator must exercise after merging #32');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      'UPDATE publish_operations SET receipt_encrypted = $2 WHERE request_id = $1',
      [OPERATION_FIXTURE.requestId, 'secret-v1$tampered$tampered$tampered']
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-operations-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-operations-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const operationsCheck = report.checks.find(check => check.name === 'publishOperations');
  assert.equal(operationsCheck.ok, false, 'the dedicated operations check must fail, not only the overall exit');
  assert.ok(operationsCheck.issues.some(issue =>
    issue.field === 'publish_operations'
    && issue.requestId === OPERATION_FIXTURE.requestId
    && issue.message.includes('receipt_encrypted')), `issues: ${JSON.stringify(operationsCheck.issues)}`);
});

test('snapshot_hash tamper fails the share-revisions check by field and key', async (t) => {
  if (!hasRevisions) {
    return t.skip('share_revisions absent on schema 001-006 base; integrator must exercise after merging #30');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      `UPDATE share_revisions SET snapshot_hash = repeat('0', 64)
       WHERE share_id = $1 AND revision = 2`,
      [FIXTURE.pages.markdownThemed]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-snapshot-hash-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-snapshot-hash-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const revisionsCheck = report.checks.find(check => check.name === 'shareRevisions');
  assert.equal(revisionsCheck.ok, false, 'the hash column must be explicitly compared, not ignored');
  assert.ok(revisionsCheck.issues.some(issue =>
    issue.field === 'snapshot_hash'
    && issue.shareId === FIXTURE.pages.markdownThemed
    && issue.revision === '2'), `issues: ${JSON.stringify(revisionsCheck.issues)}`);
});

test('restored_from tamper fails the share-revisions check by field and key', async (t) => {
  if (!hasRevisions) {
    return t.skip('share_revisions absent on schema 001-006 base; integrator must exercise after merging #30');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      'UPDATE share_revisions SET restored_from = 9007199254740993 WHERE share_id = $1 AND revision = 2',
      [FIXTURE.pages.markdownThemed]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-restored-from-tamper.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-restored-from-tamper.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const revisionsCheck = report.checks.find(check => check.name === 'shareRevisions');
  assert.equal(revisionsCheck.ok, false);
  assert.ok(revisionsCheck.issues.some(issue =>
    issue.field === 'restored_from'
    && issue.shareId === FIXTURE.pages.markdownThemed
    && issue.revision === '2'
    && /9007199254740993/.test(issue.message)), `issues: ${JSON.stringify(revisionsCheck.issues)}`);
});

// #34: a purge tombstone that "regains" payload bytes during restore must
// fail the share-revisions check with a named field issue — tombstones are
// compared on identity/provenance only, and resurrection is a hard failure,
// never recomputed or tolerated against live content hashes.
test('purge tombstone payload resurrection fails the share-revisions check by name', async (t) => {
  if (!hasRevisions || !hasPurgeColumns) {
    return t.skip('share_revisions/purged_at absent on pre-009 base; integrator must exercise after merging #34');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      `UPDATE share_revisions SET html_content = $1
       WHERE share_id = $2 AND revision = 2 AND purged_at IS NOT NULL`,
      ['<p>resurrected payload</p>', FIXTURE.pages.publicHtml]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-tombstone-resurrect.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-tombstone-resurrect.json'), 'utf8'));
  assert.equal(report.safeToServe, false);
  const revisionsCheck = report.checks.find(check => check.name === 'shareRevisions');
  assert.equal(revisionsCheck.ok, false, 'the dedicated snapshot check must fail, not only the overall exit');
  assert.ok(revisionsCheck.issues.some(issue =>
    issue.field === 'html_content'
    && issue.shareId === FIXTURE.pages.publicHtml
    && issue.revision === '2'
    && /tombstone/.test(issue.message)), `issues: ${JSON.stringify(revisionsCheck.issues)}`);
});

// #34: a receipt that was scrubbed by a revision purge must stay scrubbed on
// restore; re-encrypting a receipt onto a purged operation fails by name.
test('operation receipt resurrection on a purged revision fails the operations check by name', async (t) => {
  if (!hasOperations || !hasPurgeColumns) {
    return t.skip('publish_operations/purged_at absent on pre-009 base; integrator must exercise after merging #34');
  }

  const manifestPath = path.join(tmpDir, fs.readdirSync(tmpDir).find(name => name.startsWith('quickshare-backup-') && name.endsWith('.manifest.json')));
  const restorePool = createPostgresPool(restoreUrl, { env: poolEnv, max: 1 });
  try {
    await restorePool.query(
      `UPDATE publish_operations SET receipt_encrypted = $1
       WHERE request_id = $2`,
      ['resurrected-receipt-ciphertext', OPERATION_FIXTURE.purgedReceiptRequestId]
    );
  } finally {
    await restorePool.end();
  }

  const result = await runStep(process.execPath, [
    'scripts/verify-backup.js', '--source-url', sourceUrl, '--restore-url', restoreUrl,
    '--manifest', manifestPath, '--fixture', path.join(tmpDir, 'fixture.json'),
    '--session-secret', FIXTURE.sessionSecret, '--reconciled',
    '--output', path.join(tmpDir, 'verification-receipt-resurrect.json')
  ]);
  assert.equal(result.code, 1);

  const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verification-receipt-resurrect.json'), 'utf8'));
  const operationsCheck = report.checks.find(check => check.name === 'publishOperations');
  assert.equal(operationsCheck.ok, false, 'the dedicated operations check must fail, not only the overall exit');
  assert.ok(operationsCheck.issues.some(issue =>
    issue.field === 'publish_operations'
    && issue.requestId === OPERATION_FIXTURE.purgedReceiptRequestId
    && /receipt_encrypted/.test(issue.message)), `issues: ${JSON.stringify(operationsCheck.issues)}`);
});
