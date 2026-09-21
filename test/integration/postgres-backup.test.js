const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { sanitizeChildEnv } = require('../../scripts/backup-db');

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
  FIXTURE,
  seedFixture
} = require('../../scripts/backup-restore-check');

const poolEnv = { POSTGRES_SSL: 'false' };
const srcDocker = process.env.QS27_BACKUP_DOCKER_SRC || null;
const restoreDocker = process.env.QS27_BACKUP_DOCKER_RESTORE || null;

// Access Revision fixture gate state, resolved in test.before(). False on a
// schema 001–003 base: the access_revision branch is then EXPLICITLY skipped
// with a message naming the integrator's post-#25-merge obligation — it is
// never silently claimed.
let hasAccessRevision = false;

const childEnv = sanitizeChildEnv(process.env, { SESSION_SECRET: FIXTURE.sessionSecret });

let tmpDir;

function runStep(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.writeFileSync(
        path.join(tmpDir, `log-${args.filter(a => a.startsWith('--')).join('') || command}.log`).replace(/--/g, ''),
        `exit=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`
      );
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
  // tmpDir under os.tmpdir() is private disposable evidence; keep it for review.
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
  assert.equal(JSON.stringify(manifest).includes('issue27local'), false);
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
    'password-verify-and-decrypt',
    'expiry',
    'managed-api-keys',
    'audit-logs',
    'site-settings',
    'migration-ledger'
  ]);
  assert.ok(Number.isFinite(report.durationsMs.verifyMs));

  const settingsCheck = report.checks.find(check => check.name === 'siteSettings');
  assert.equal(settingsCheck.details.comparedColumns.includes('publishing_writes_paused'), true);
  const pageCheck = report.checks.find(check => check.name === 'pageInventory');
  assert.equal(pageCheck.details.pageCount, 4);
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

  const passwordCheck = report.checks.find(check => check.name === 'passwordVerifyAndDecrypt');
  assert.deepEqual(passwordCheck.details, { protectedPages: 1, fixtureCovered: 1 });
  const keyCheck = report.checks.find(check => check.name === 'managedApiKeys');
  assert.deepEqual(keyCheck.details, { keys: 1, fixtureCovered: 1 });
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
  assert.deepEqual(keyCheck.details, { keys: 1, fixtureCovered: 0 });
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
    assert.equal(report.checks.find(check => check.name === 'managedApiKeys').ok, false);
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
