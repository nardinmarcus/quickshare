const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const backupDb = require('../scripts/backup-db');
const restoreDb = require('../scripts/restore-db');
const verifyBackup = require('../scripts/verify-backup');

const TEST_URL_OK = 'postgresql://postgres:issue27local@127.0.0.1:5541/issue27_src_test';
const TEST_URL_RESTORE_OK = 'postgresql://postgres:issue27local@127.0.0.1:5542/issue27_restore_test';

test('database URL guard only accepts localhost databases ending in _test', () => {
  assert.equal(backupDb.assertTestDatabaseUrl(TEST_URL_OK), true);
  assert.equal(backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@localhost:5432/issue27_src_test'), true);
  assert.equal(backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@[::1]:5432/issue27_src_test'), true);

  assert.throws(() => backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/quickshare'), /_test/);
  assert.throws(() => backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@db.example.com:5432/issue27_src_test'), /localhost/);
  assert.throws(() => backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@10.0.0.5:5432/issue27_src_test'), /localhost/);
  assert.throws(() => backupDb.assertTestDatabaseUrl('not-a-url'), /URL/);

  // Explicit override is recorded, never silent. It remains an owner-run
  // escape hatch only; tests themselves always use synthetic localhost _test.
  const bypass = backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@db.example.com:5432/prod', { allowNonTest: true });
  assert.deepEqual(bypass, { allowed: true, testGuardBypassed: true });
  assert.throws(() => backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/prod'), /_test/);
});

test('connection URLs are redacted before they can reach manifests or logs', () => {
  assert.equal(backupDb.redactUrl(TEST_URL_OK), 'postgresql://postgres:***@127.0.0.1:5541/issue27_src_test');
  assert.equal(backupDb.redactUrl('postgresql://postgres@127.0.0.1:5432/x_test'), 'postgresql://postgres@127.0.0.1:5432/x_test');
});

test('parseCliArgs supports documented bare boolean flags regardless of position', () => {
  assert.deepEqual(backupDb.parseCliArgs(['--allow-non-test']), { allowNonTest: true });
  assert.deepEqual(backupDb.parseCliArgs(['--reconciled']), { reconciled: true });
  assert.deepEqual(backupDb.parseCliArgs(['--no-clean']), { noClean: true });
  assert.deepEqual(backupDb.parseCliArgs(['--keep-containers']), { keepContainers: true });
  assert.deepEqual(backupDb.parseCliArgs(['--skip-container-setup']), { skipContainerSetup: true });

  // Boolean flag followed by more options must not swallow them.
  assert.deepEqual(
    backupDb.parseCliArgs(['--reconciled', '--output', 'report.json']),
    { reconciled: true, output: 'report.json' }
  );
  // Options before the boolean flag: order independent.
  assert.deepEqual(
    backupDb.parseCliArgs(['--output', 'report.json', '--reconciled']),
    { output: 'report.json', reconciled: true }
  );
  // Boolean flag at end of argv.
  assert.deepEqual(
    backupDb.parseCliArgs(['--manifest', 'm.json', '--reconciled']),
    { manifest: 'm.json', reconciled: true }
  );
});

test('parseCliArgs camelCases valued options and rejects missing or flag-valued values', () => {
  assert.deepEqual(
    backupDb.parseCliArgs(['--url', 'postgresql://x/issue27_src_test', '--output-dir', '/tmp/x', '--tool-bin', '/bin/pg_dump']),
    { url: 'postgresql://x/issue27_src_test', outputDir: '/tmp/x', toolBin: '/bin/pg_dump' }
  );
  assert.deepEqual(
    backupDb.parseCliArgs(['--target-url', TEST_URL_RESTORE_OK]),
    { targetUrl: TEST_URL_RESTORE_OK }
  );

  assert.throws(() => backupDb.parseCliArgs(['--url']), /--url.*requires a value/i);
  assert.throws(() => backupDb.parseCliArgs(['--manifest']), /--manifest.*requires a value/i);
  assert.throws(() => backupDb.parseCliArgs(['--url', '--docker']), /--url.*requires a value/i);
  assert.throws(() => backupDb.parseCliArgs(['stray']), /unexpected argument/i);
});

test('Postgres major versions are parsed and mismatches fail closed', () => {
  assert.equal(backupDb.parsePostgresMajor('pg_dump (PostgreSQL) 17.6 (Homebrew)'), 17);
  assert.equal(backupDb.parsePostgresMajor('pg_restore (PostgreSQL) 16.4'), 16);
  assert.equal(backupDb.parsePostgresMajorFromServerVersionNum('170000'), 17);
  assert.equal(backupDb.parsePostgresMajorFromServerVersionNum('160008'), 16);
  assert.throws(() => backupDb.parsePostgresMajor('garbage output'), /version/);

  assert.throws(
    () => backupDb.assertToolMatchesServer({ toolName: 'pg_dump', toolMajor: 16, serverMajor: 17 }),
    /pg_dump.*major version mismatch.*16.*server.*17/i
  );
  assert.equal(
    backupDb.assertToolMatchesServer({ toolName: 'pg_dump', toolMajor: 17, serverMajor: 17 }),
    true
  );
});

test('tool command resolution prefers PATH binaries and falls back to docker exec', async () => {
  const dockerResolution = await backupDb.resolveToolCommand({
    tool: 'pg_dump',
    dockerContainer: 'issue27-pg-src',
    probe: async () => ({ code: 0, stdout: 'pg_dump (PostgreSQL) 17.2', stderr: '' })
  });

  assert.equal(dockerResolution.major, 17);
  assert.deepEqual(dockerResolution.execPrefix({ tool: 'pg_dump' }), ['docker', 'exec', 'issue27-pg-src', 'pg_dump']);

  const pathResolution = await backupDb.resolveToolCommand({
    tool: 'pg_dump',
    toolBin: '/usr/local/bin/pg_dump',
    probe: async () => ({ code: 0, stdout: 'pg_dump (PostgreSQL) 17.6', stderr: '' })
  });
  assert.equal(pathResolution.bin, '/usr/local/bin/pg_dump');
  assert.deepEqual(pathResolution.execPrefix({ tool: 'pg_dump' }), ['/usr/local/bin/pg_dump']);

  await assert.rejects(
    backupDb.resolveToolCommand({
      tool: 'pg_dump',
      probe: async () => ({ code: 1, stdout: '', stderr: 'command not found' })
    }),
    /pg_dump.*not available.*(PATH|docker)/i
  );
});

test('child environments drop inherited database URLs and session secrets', () => {
  const sanitized = backupDb.sanitizeChildEnv({
    DATABASE_URL: 'postgresql://leak@prod/x',
    POSTGRES_URL: 'postgresql://leak@prod/y',
    SESSION_SECRET: 'real-secret',
    SHARE_API_KEY: 'real-key',
    PATH: '/usr/bin',
    HOME: '/home/tester'
  }, { SESSION_SECRET: 'synthetic-only' });

  assert.equal(sanitized.DATABASE_URL, undefined);
  assert.equal(sanitized.POSTGRES_URL, undefined);
  assert.equal(sanitized.DATABASE_MIGRATION_URL, undefined);
  assert.equal(sanitized.SHARE_API_KEY, undefined);
  assert.equal(sanitized.SESSION_SECRET, 'synthetic-only');
  assert.equal(sanitized.PATH, '/usr/bin');
});

test('backup manifests are deterministic in shape and free of credentials', () => {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs27-manifest-'));
  const dumpPath = path.join(dumpDir, 'backup.dump');
  fs.writeFileSync(dumpPath, Buffer.from('fake dump bytes'));
  const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex');

  const manifest = backupDb.buildBackupManifest({
    url: TEST_URL_OK,
    outputDir: dumpDir,
    dumpFile: 'backup.dump',
    serverVersion: '17.2',
    serverVersionNum: 170002,
    toolVersion: 'pg_dump (PostgreSQL) 17.2',
    snapshotAt: 1758470000000,
    snapshotWalLsn: '0/5A000000',
    durationsMs: { snapshotMs: 4, dumpMs: 120 }
  });

  assert.equal(manifest.kind, 'quickshare-native-consistent-backup');
  assert.equal(manifest.format, 'custom');
  assert.equal(manifest.database, 'issue27_src_test');
  assert.equal(manifest.host, '127.0.0.1');
  assert.equal(manifest.snapshotAt, 1758470000000);
  assert.equal(manifest.snapshotWalLsn, '0/5A000000');
  assert.equal(manifest.serverVersionNum, 170002);
  assert.equal(manifest.dumpSha256, expectedSha);
  assert.equal(manifest.dumpBytes, Buffer.byteLength('fake dump bytes'));
  assert.deepEqual(manifest.durationsMs, { snapshotMs: 4, dumpMs: 120 });
  assert.equal(manifest.contentKind, 'restorable-content-and-configuration');
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('issue27local'), false);
  assert.equal(serialized.includes('postgres://'), false);
});

test('dump integrity is verified against the manifest digest before restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs27-sha-'));
  const dumpPath = path.join(dir, 'backup.dump');
  fs.writeFileSync(dumpPath, 'payload');
  const sha = crypto.createHash('sha256').update('payload').digest('hex');

  assert.equal(restoreDb.verifyDumpSha256(dumpPath, sha), true);
  assert.throws(() => restoreDb.verifyDumpSha256(dumpPath, '0'.repeat(64)), /digest mismatch/);
  assert.throws(() => restoreDb.verifyDumpSha256(path.join(dir, 'missing.dump'), sha), /not found/);
});

test('restore refuses to write into the database the backup was taken from', () => {
  const manifest = {
    kind: 'quickshare-native-consistent-backup',
    host: '127.0.0.1',
    port: '5541',
    database: 'issue27_src_test'
  };

  assert.throws(
    () => restoreDb.assertRestoreTargetDiffers(manifest, {
      host: '127.0.0.1',
      port: '5541',
      database: 'issue27_src_test'
    }),
    /restore target must differ/i
  );
  assert.equal(
    restoreDb.assertRestoreTargetDiffers(manifest, { host: '127.0.0.1', port: '5542', database: 'issue27_restore_test' }),
    true
  );
});

test('page inventory comparison reports every mismatched domain field explicitly', () => {
  const sourceRows = [
    {
      id: 'issue27pub0010', html_content: '<h1>one</h1>', created_at: '100',
      password_hash: null, encrypted_password: null, is_protected: 0, code_type: 'html',
      title: 'One', description: null, expires_at: null, markdown_theme: null,
      view_count: '3', is_favorite: false
    },
    {
      id: 'issue27md00010', html_content: '# md', created_at: '200',
      password_hash: null, encrypted_password: null, is_protected: 0, code_type: 'markdown',
      title: 'Markdown', description: 'desc', expires_at: null, markdown_theme: 'github',
      view_count: '0', is_favorite: true
    },
    {
      id: 'issue27exp00010', html_content: '<p>x</p>', created_at: '300',
      password_hash: null, encrypted_password: null, is_protected: 0, code_type: 'html',
      title: 'Expiring', description: null, expires_at: '999', markdown_theme: null,
      view_count: '9', is_favorite: false
    }
  ];

  const identical = verifyBackup.comparePageInventory(sourceRows, JSON.parse(JSON.stringify(sourceRows)));
  assert.deepEqual(identical.issues, []);
  assert.equal(identical.ok, true);
  assert.deepEqual([...identical.contentHashes.keys()].sort(), ['issue27exp00010', 'issue27md00010', 'issue27pub0010']);
  assert.deepEqual(identical.comparedColumns.sort(), [
    'code_type', 'created_at', 'description', 'encrypted_password', 'expires_at', 'html_content',
    'id', 'is_favorite', 'is_protected', 'markdown_theme', 'password_hash', 'title', 'view_count'
  ]);

  const restored = JSON.parse(JSON.stringify(sourceRows));
  restored[1].markdown_theme = 'notion';           // theme drift
  restored[1].is_favorite = false;                 // favorite drift
  restored[2].expires_at = '1000';                 // expiry drift
  restored[0].html_content = '<h1>mutated</h1>';   // content drift
  const drifted = verifyBackup.comparePageInventory(sourceRows, restored);

  assert.equal(drifted.ok, false);
  const messages = drifted.issues.map(issue => issue.message).join('\n');
  assert.match(messages, /markdown_theme drift for issue27md00010/);
  assert.match(messages, /is_favorite drift for issue27md00010/);
  assert.match(messages, /expires_at drift for issue27exp00010/);
  assert.match(messages, /html_content sha256 drift for issue27pub0010/);

  const withMissing = verifyBackup.comparePageInventory(sourceRows, sourceRows.slice(1));
  assert.match(withMissing.issues.map(i => i.message).join('\n'), /missing page.*issue27pub0010/i);

  const withExtra = verifyBackup.comparePageInventory(sourceRows.slice(1), sourceRows);
  assert.match(withExtra.issues.map(i => i.message).join('\n'), /unexpected page.*issue27pub0010/i);
});

test('migration ledger must match local migrations exactly on both sides', () => {
  const localMigrations = [
    { version: '001', name: '001_baseline.sql', checksum: 'aa11' },
    { version: '002', name: '002_site_settings.sql', checksum: 'bb22' },
    { version: '003', name: '003_page_favorites.sql', checksum: 'cc33' }
  ];
  const applied = [
    { version: '001', name: '001_baseline.sql', checksum: 'aa11' },
    { version: '002', name: '002_site_settings.sql', checksum: 'bb22' },
    { version: '003', name: '003_page_favorites.sql', checksum: 'cc33' }
  ];

  assert.deepEqual(verifyBackup.verifyMigrationLedger(applied, localMigrations), { ok: true, issues: [] });

  const tampered = [{ ...applied[2], checksum: 'wrong' }];
  const tamperedReport = verifyBackup.verifyMigrationLedger(tampered, localMigrations);
  assert.equal(tamperedReport.ok, false);
  assert.ok(tamperedReport.issues.some(issue => /checksum mismatch for migration 003/.test(issue.message)));
  assert.ok(tamperedReport.issues.some(issue => /missing migration 001/.test(issue.message)));

  const incomplete = applied.slice(0, 2);
  const incompleteReport = verifyBackup.verifyMigrationLedger(incomplete, localMigrations);
  assert.ok(incompleteReport.issues.some(issue => /missing migration 003/.test(issue.message)));

  const unknown = [...applied, { version: '004', name: '004_future.sql', checksum: 'dd44' }];
  const unknownReport = verifyBackup.verifyMigrationLedger(unknown, localMigrations);
  assert.equal(unknownReport.ok, false);
  assert.match(unknownReport.issues[0].message, /004/);
});

test('post-snapshot revocation detection uses the audit vocabulary the app actually emits', () => {
  const snapshotAt = 1758470000000;
  const auditRows = [
    // Real creation activity before the snapshot.
    { action: 'page.create', page_id: 'a', details: '{"drill":true}', created_at: String(snapshotAt - 5000) },
    // A real pre-snapshot purge: must not be flagged as post-snapshot.
    { action: 'page.delete', page_id: 'gone', details: null, created_at: String(snapshotAt - 1000) },
    // Post-snapshot policy update exactly as app.js emits it:
    // details = JSON.stringify({ fields: Object.keys(updateOptions) }).
    { action: 'page.update', page_id: 'a', details: '{"fields":["isProtected","passwordHash","encryptedPassword"]}', created_at: String(snapshotAt + 1000) },
    // Content-only update after the snapshot: not a revocation vector.
    { action: 'page.update', page_id: 'a', details: '{"fields":["title","htmlContent"]}', created_at: String(snapshotAt + 1500) },
    // Expiry change is a policy change too.
    { action: 'page.update', page_id: 'b', details: '{"fields":["expiresAt"]}', created_at: String(snapshotAt + 2000) },
    // Key revocation.
    { action: 'api_key.delete', page_id: null, details: '{"apiKeyId":"k1"}', created_at: String(snapshotAt + 2500) },
    // Hard purges.
    { action: 'page.delete', page_id: 'gone2', details: null, created_at: String(snapshotAt + 3000) },
    { action: 'page.delete.batch', page_id: null, details: '{"ids":["x"]}', created_at: String(snapshotAt + 3500) },
    // Benign post-snapshot management activity.
    { action: 'page.favorite.update', page_id: 'a', details: '{"from":false,"to":true}', created_at: String(snapshotAt + 4000) },
    { action: 'admin.login', page_id: null, details: null, created_at: String(snapshotAt + 4500) },
    // Malformed details must not crash detection.
    { action: 'page.update', page_id: 'c', details: 'not-json{', created_at: String(snapshotAt + 5000) }
  ];

  const events = verifyBackup.findPostSnapshotRevocations(auditRows, snapshotAt);
  assert.deepEqual(events.map(event => `${event.action}:${event.pageId}`), [
    'page.update:a',
    'page.update:b',
    'api_key.delete:null',
    'page.delete:gone2',
    'page.delete.batch:null'
  ]);
  assert.deepEqual(
    events.find(event => event.action === 'page.update' && event.pageId === 'a').fields,
    ['isProtected', 'passwordHash', 'encryptedPassword']
  );

  // Empty audit history must NOT be reported as proof that nothing happened.
  assert.deepEqual(verifyBackup.findPostSnapshotRevocations([], snapshotAt), []);
});

test('credential verification plans fail when fixture material does not cover restored rows', async () => {
  const restoredProtected = [
    { id: 'prot-covered', is_protected: 1, password_hash: 'scrypt$a$b', encrypted_password: 'secret-v1$x$y$z' },
    { id: 'prot-uncovered', is_protected: 1, password_hash: 'scrypt$c$d', encrypted_password: 'secret-v1$u$v$w' }
  ];
  const restUnprotected = [
    { id: 'plain', is_protected: 0, password_hash: null, encrypted_password: null },
    { id: 'leaky', is_protected: 0, password_hash: 'scrypt$e$f', encrypted_password: null }
  ];
  const rows = [...restoredProtected, ...restUnprotected];

  const fullPlan = await verifyBackup.planCredentialVerification({
    restoredPages: rows,
    fixture: { protectedPages: [{ id: 'prot-covered', password: 'Drill!Pass1' }] },
    verifyHash: async () => true,
    decrypt: () => 'Drill!Pass1'
  });
  assert.equal(fullPlan.ok, false);
  assert.ok(fullPlan.issues.some(issue => issue.pageId === 'prot-uncovered' && /incomplete fixture coverage/.test(issue.message)));
  assert.ok(fullPlan.issues.some(issue => issue.pageId === 'leaky' && /credential material/.test(issue.message)));
  assert.deepEqual(fullPlan.details, { protectedPages: 2, fixtureCovered: 1 });

  const nothingProtected = await verifyBackup.planCredentialVerification({
    restoredPages: [{ id: 'plain', is_protected: 0, password_hash: null, encrypted_password: null }],
    fixture: { protectedPages: [] },
    verifyHash: async () => true,
    decrypt: () => null
  });
  assert.equal(nothingProtected.ok, true);
  assert.deepEqual(nothingProtected.details, { protectedPages: 0, fixtureCovered: 0 });

  const keyPlan = await verifyBackup.planApiKeyVerification({
    restoredKeys: [
      { id: 'key-covered', key_hash: 'scrypt$a$b' },
      { id: 'key-uncovered', key_hash: 'scrypt$c$d' }
    ],
    fixture: { apiKeys: [{ id: 'key-covered', secret: 'qs27-drill-api-key-1234567890' }] },
    verifyHash: async () => true
  });
  assert.equal(keyPlan.ok, false);
  assert.ok(keyPlan.issues.some(issue => issue.keyId === 'key-uncovered' && /incomplete fixture coverage/.test(issue.message)));
  assert.deepEqual(keyPlan.details, { keys: 2, fixtureCovered: 1 });

  const failedVerify = await verifyBackup.planApiKeyVerification({
    restoredKeys: [{ id: 'key-covered', key_hash: 'scrypt$a$b' }],
    fixture: { apiKeys: [{ id: 'key-covered', secret: 'wrong' }] },
    verifyHash: async (secret) => secret === 'right'
  });
  assert.equal(failedVerify.ok, false);
  assert.ok(failedVerify.issues.some(issue => /does not verify/.test(issue.message)));
});

test('verification reports never claim reconciliation is not required', () => {
  const checks = [{ name: 'pageInventory', ok: true, issues: [] }];

  const clean = verifyBackup.buildVerificationReport({
    checks,
    durationsMs: { verifyMs: 25 },
    postSnapshotRevocations: [],
    manifest: { snapshotAt: 1758470000000, database: 'issue27_src_test' },
    target: { database: 'issue27_restore_test' }
  });

  // No detected events is not proof of absence: legacy policy routes emit no
  // audit records, so a clean-looking history still requires owner review.
  assert.equal(clean.ok, true);
  assert.equal(clean.reconciliation.status, 'owner-review-required');
  assert.match(clean.reconciliation.reason, /owner review/i);
  assert.equal(clean.safeToServe, false);
  assert.equal(clean.isolation, 'offline-by-default');
  assert.equal(verifyBackup.reconciliationExitCode(clean, { reconciled: false }), 2);
  assert.equal(verifyBackup.reconciliationExitCode(clean, { reconciled: true }), 0);

  const withEvents = verifyBackup.buildVerificationReport({
    checks: [{ name: 'pageInventory', ok: true, issues: [] }],
    durationsMs: { verifyMs: 5 },
    postSnapshotRevocations: [{ action: 'page.update', pageId: 'a', fields: ['isProtected'], createdAt: 1758470001000 }],
    manifest: { snapshotAt: 1758470000000, database: 'issue27_src_test' },
    target: { database: 'issue27_restore_test' }
  });

  assert.equal(withEvents.ok, true, 'detected events are a reconciliation matter, not a data mismatch');
  assert.equal(withEvents.reconciliation.status, 'unreconciled');
  assert.equal(verifyBackup.reconciliationExitCode(withEvents, { reconciled: false }), 2);
  assert.equal(verifyBackup.reconciliationExitCode(withEvents, { reconciled: true }), 0);

  const failing = verifyBackup.buildVerificationReport({
    checks: [{ name: 'pageInventory', ok: false, issues: [{ field: 'html_content', message: 'sha256 drift' }] }],
    durationsMs: { verifyMs: 5 },
    postSnapshotRevocations: [],
    manifest: { snapshotAt: 1758470000000, database: 'issue27_src_test' },
    target: { database: 'issue27_restore_test' }
  });
  assert.equal(failing.ok, false);
  assert.equal(verifyBackup.reconciliationExitCode(failing, { reconciled: true }), 1);

  assert.deepEqual(clean.coveredObjects, [
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
});
