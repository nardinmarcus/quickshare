const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const backupDb = require('../scripts/backup-db');
const restoreDb = require('../scripts/restore-db');
const verifyBackup = require('../scripts/verify-backup');
const backupRestoreCheck = require('../scripts/backup-restore-check');

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

test('backup and restore reject target overrides even when the non-test guard is bypassed', async () => {
  const invalidOverrides = [
    'host=203.0.113.8',
    'hostaddr=203.0.113.8',
    'port=5542',
    'database=other_test',
    'dbname=other_test',
    'host=%2Fvar%2Frun%2Fpostgresql',
    'socket=%2Fvar%2Frun%2Fpostgresql',
    'socketdir=%2Fvar%2Frun%2Fpostgresql'
  ];

  for (const override of invalidOverrides) {
    const local = `postgresql://postgres:pw@127.0.0.1:5541/issue27_src_test?${override}`;
    const remote = `postgresql://postgres:pw@db.example.com:5541/production?${override}`;
    assert.throws(() => backupDb.parseConnectionStringParts(local), /target override/i, override);
    assert.throws(
      () => backupDb.assertTestDatabaseUrl(remote, { allowNonTest: true }),
      /target override/i,
      `--allow-non-test must not permit ${override}`
    );
    await assert.rejects(
      backupDb.createBackup({ url: local, outputDir: '/tmp/issue43-no-backup' }),
      /target override/i,
      `backup must reject ${override} before pool creation or pg_dump`
    );
    await assert.rejects(
      restoreDb.restoreBackup({
        sourceUrl: TEST_URL_OK,
        targetUrl: remote,
        allowNonTest: true,
        manifest: { kind: 'quickshare-native-consistent-backup' },
        dumpPath: '/tmp/does-not-need-to-exist.dump'
      }),
      /target override/i,
      `restore must reject ${override} before pool creation or pg_restore`
    );
    await assert.rejects(
      verifyBackup.runVerification({
        sourceUrl: local,
        restoreUrl: TEST_URL_RESTORE_OK,
        allowNonTest: true,
        manifest: {}
      }),
      /target override/i,
      `verify must reject ${override} before either pool is constructed`
    );
  }

  assert.deepEqual(
    backupDb.assertTestDatabaseUrl(
      'postgresql://postgres:pw@db.example.com:5541/production?sslmode=disable&fallback_application_name=quickshare-backup',
      { allowNonTest: true }
    ),
    { allowed: true, testGuardBypassed: true },
    'explicit remote bypass retains ordinary non-target options'
  );
  assert.equal(
    backupDb.assertTestDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5541/issue27_src_test?sslmode=disable'),
    true,
    'normal loopback sslmode remains allowed'
  );
});

test('connection URLs are redacted before they can reach manifests or logs', () => {
  assert.equal(backupDb.redactUrl(TEST_URL_OK), 'postgresql://postgres:***@127.0.0.1:5541/issue27_src_test');
  assert.equal(backupDb.redactUrl('postgresql://postgres@127.0.0.1:5432/x_test'), 'postgresql://postgres@127.0.0.1:5432/x_test');

  const redactedArgs = backupDb.redactCommandArgs([
    '--source-url', TEST_URL_OK,
    `--source-url=${TEST_URL_OK}`
  ]);
  assert.ok(redactedArgs[1].includes('postgres:***@'), 'the separate --source-url value is redacted');
  assert.ok(redactedArgs[2].includes('postgres:***@'), 'the --source-url=value form is redacted');
  assert.equal(redactedArgs.join(' ').includes('issue27local'), false, 'source credentials never enter literal commands');
});

test('backup integration runStep redacts persisted argv while executing and returning the original values', async () => {
  const vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const source = fs.readFileSync(path.join(__dirname, 'integration/postgres-backup.test.js'), 'utf8');
  const runStepSource = source.slice(source.indexOf('let stepNumber = 0;'), source.indexOf('test.before(async () => {'));
  const marker = 'qs33-marker:/@+?';
  const encoded = encodeURIComponent(marker);
  const url = `postgresql://user:${encoded}@localhost:55535/issue33_src_test?sslmode=disable`;
  const queryUrl = `postgres://user@localhost:55536/issue33_restore_test?password=${encoded}&sslpassword=${encoded}`;
  const args = ['scripts/backup-db.js', '--url', url, '--target-url', queryUrl,
    `--source-url=${url}`, '--password', marker, `--session-secret=${marker}`, `PGPASSWORD=${marker}`, '--output-dir', '/tmp/synthetic-evidence'];
  const writes = new Map();
  let executed;
  const sandbox = {
    tmpDir: '/tmp/synthetic-evidence', path, childEnv: {},
    redactCommandArgs: backupDb.redactCommandArgs,
    fs: { writeFileSync(file, text) { writes.set(file, text); } },
    spawn(command, argv) {
      executed = { command, argv };
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', 'unchanged stdout');
        child.stderr.emit('data', 'unchanged stderr');
        child.emit('close', 7);
      });
      return child;
    }
  };
  vm.runInNewContext(runStepSource + '\nthis.runStep = runStep;', sandbox);
  const result = await sandbox.runStep(process.execPath, args);
  assert.equal(executed.command, process.execPath);
  assert.equal(executed.argv, args, 'the real spawn receives the original argv, not the logging copy');
  assert.equal(result.code, 7);
  assert.equal(result.stdout, 'unchanged stdout');
  assert.equal(result.stderr, 'unchanged stderr');
  const sourceFlag = backupDb.redactCommandArgs(['--source-url', url, `--source-url=${url}`]);
  assert.equal(sourceFlag.join(' ').includes(marker), false, 'literal --source-url commands redact URL credentials');
  assert.equal(sourceFlag.join(' ').includes(encoded), false, 'encoded source URL credentials are redacted too');
  const commandArtifacts = [...writes].filter(([name]) => name.endsWith('.cmd'));
  assert.equal(commandArtifacts.length, 1);
  for (const [, text] of commandArtifacts) {
    assert.equal(text.includes(marker), false, 'raw synthetic secret must not enter command artifacts');
    assert.equal(text.includes(encoded), false, 'percent-encoded secret must not enter command artifacts');
    const logged = JSON.parse(text);
    assert.ok(logged.some(value => value.includes('issue33_src_test')), 'retain non-secret command context');
    assert.ok(logged.includes('/tmp/synthetic-evidence'));
  }
  assert.equal(writes.get('/tmp/synthetic-evidence/step-001.raw.log'), '--- stdout ---\nunchanged stdout\n--- stderr ---\nunchanged stderr\n');
  assert.equal(writes.get('/tmp/synthetic-evidence/step-001.exit'), '7\n');
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
  assert.deepEqual(
    backupDb.parseCliArgs(['--source-url', TEST_URL_OK]),
    { sourceUrl: TEST_URL_OK }
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
  const defaultPortManifest = backupDb.buildBackupManifest({
    url: 'postgresql://postgres:pw@localhost/issue27_src_test',
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
  assert.equal(defaultPortManifest.port, '5432', 'generated manifests always include a complete effective port');
  assert.equal(manifest.format, 'custom');
  assert.equal(manifest.database, 'issue27_src_test');
  assert.equal(manifest.host, '127.0.0.1');
  assert.equal(manifest.port, '5541');
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

test('restore requires an independent source URL in the API and CLI', async () => {
  await assert.rejects(
    restoreDb.restoreBackup({ targetUrl: TEST_URL_RESTORE_OK, manifestPath: '/missing.manifest.json' }),
    /trusted backup source URL is required/
  );

  const cli = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/restore-db.js'),
    '--manifest', '/missing.manifest.json',
    '--target-url', TEST_URL_RESTORE_OK
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /trusted backup source URL is required/);
  assert.doesNotMatch(cli.stderr, /ENOENT|ECONNREFUSED/);
});

test('restore CLI requires --manifest and treats --dump only as an override', () => {
  const script = path.join(__dirname, '../scripts/restore-db.js');
  const standalone = spawnSync(process.execPath, [script, '--dump', '/tmp/qs43-standalone-override.dump'], {
    encoding: 'utf8'
  });
  assert.equal(standalone.status, 1);
  assert.match(standalone.stderr, /A backup manifest is required: pass --manifest/);
  assert.doesNotMatch(standalone.stderr, /ENOENT|ECONNREFUSED/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-restore-cli-manifest-'));
  const manifestPath = path.join(dir, 'backup.manifest.json');
  const overridePath = path.join(dir, 'override.dump');
  fs.writeFileSync(manifestPath, JSON.stringify({
    kind: 'quickshare-native-consistent-backup',
    host: '127.0.0.1',
    port: '5541',
    database: 'issue27_src_test',
    dumpFile: 'manifest-default.dump',
    dumpSha256: '0'.repeat(64)
  }));

  try {
    const override = spawnSync(process.execPath, [
      script,
      '--manifest', manifestPath,
      '--dump', overridePath,
      '--source-url', TEST_URL_OK,
      '--target-url', TEST_URL_RESTORE_OK
    ], { encoding: 'utf8' });
    assert.equal(override.status, 1);
    assert.ok(override.stderr.includes(`Dump file not found: ${overridePath}`), override.stderr);
    assert.doesNotMatch(override.stderr, /ECONNREFUSED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restore validates manifest source endpoint shape and provenance before dump or database access', async () => {
  const sourceParts = backupDb.parseConnectionStringParts(TEST_URL_OK);
  const baseline = {
    kind: 'quickshare-native-consistent-backup',
    host: '127.0.0.1',
    port: '5541',
    database: 'issue27_src_test',
    dumpSha256: '0'.repeat(64)
  };
  const malformed = [
    ['missing host', ({ host, ...rest }) => rest],
    ['missing port', ({ port, ...rest }) => rest],
    ['missing database', ({ database, ...rest }) => rest],
    ['malformed host', value => ({ ...value, host: 'localhost:5541' })],
    ['empty port', value => ({ ...value, port: '' })],
    ['invalid port', value => ({ ...value, port: '54x1' })],
    ['out-of-range port', value => ({ ...value, port: '65536' })],
    ['empty database', value => ({ ...value, database: '' })],
    ['tampered host', value => ({ ...value, host: '192.0.2.9' })],
    ['tampered port', value => ({ ...value, port: '5542' })],
    ['tampered database', value => ({ ...value, database: 'issue27_other_test' })]
  ];

  assert.equal(
    restoreDb.assertManifestSourceMatchesSourceUrl({ ...baseline, host: 'localhost' }, sourceParts),
    true,
    'the shared loopback alias policy accepts equivalent manifest/source hosts'
  );

  for (const [label, alter] of malformed) {
    const manifest = alter(baseline);
    await assert.rejects(
      restoreDb.restoreBackup({
        manifest,
        sourceUrl: TEST_URL_OK,
        targetUrl: TEST_URL_RESTORE_OK,
        dumpPath: '/definitely-not-read-before-source-validation.dump'
      }),
      /Backup manifest source endpoint|does not match the independently supplied --source-url/i,
      `${label} must fail before dump read, Pool construction, or pg_restore`
    );
  }

  await assert.rejects(
    restoreDb.restoreBackup({
      manifest: { ...baseline, host: '203.0.113.10', port: '6000', database: 'other_test' },
      sourceUrl: TEST_URL_OK,
      targetUrl: 'postgresql://postgres:pw@localhost:5541/issue27_src_test',
      dumpPath: '/must-not-be-read.dump'
    }),
    /Restore target must differ from the trusted source database/i,
    'source==target is rejected from the independent URL even when manifest endpoint fields are tampered'
  );
});

test('remote source and target remain available only with explicit non-test bypass', async () => {
  const sourceUrl = 'postgresql://postgres:pw@source.example.com:5432/production';
  const targetUrl = 'postgresql://postgres:pw@restore.example.com:5432/restore';
  const manifest = {
    kind: 'quickshare-native-consistent-backup',
    host: 'source.example.com',
    port: '5432',
    database: 'production',
    dumpSha256: '0'.repeat(64)
  };

  await assert.rejects(
    restoreDb.restoreBackup({
      manifest, sourceUrl, targetUrl, allowNonTest: true,
      dumpPath: '/missing-after-explicit-remote-guard.dump'
    }),
    /Dump file not found/,
    'explicit remote bypass passes source/target guards without making a network connection'
  );
});

test('restore fails closed for same-named databases across remote aliases and tunnels before dump, Pool, or pg_restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-remote-restore-alias-'));
  const dumpPath = path.join(dir, 'synthetic.dump');
  const dump = Buffer.from('synthetic dump bytes');
  fs.writeFileSync(dumpPath, dump);
  const digest = crypto.createHash('sha256').update(dump).digest('hex');
  const toolMarker = path.join(dir, 'pg-restore-invoked');
  const toolBin = path.join(dir, 'pg-restore-stub');
  fs.writeFileSync(toolBin, `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(toolMarker)}\nprintf 'pg_restore (PostgreSQL) 17.11\\n'\n`, { mode: 0o700 });
  fs.chmodSync(toolBin, 0o700);

  const postgresConfig = require('../models/postgres-config');
  const originalPoolFactory = postgresConfig.createPostgresPool;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const calls = { pool: 0, dumpExists: 0, dumpRead: 0 };
  postgresConfig.createPostgresPool = () => {
    calls.pool += 1;
    return {
      async query(sql) {
        return { rows: [{
          server_version_num: '170011',
          server_version: '17.11'
        }] };
      },
      async end() {}
    };
  };
  fs.existsSync = function (filePath) {
    if (filePath === dumpPath) calls.dumpExists += 1;
    return originalExistsSync.call(this, filePath);
  };
  fs.readFileSync = function (filePath, ...args) {
    if (filePath === dumpPath) calls.dumpRead += 1;
    return originalReadFileSync.call(this, filePath, ...args);
  };

  const scenarios = [
    {
      label: 'two remote DNS aliases',
      sourceUrl: 'postgresql://postgres:pw@source-db.example.com:5432/production',
      targetUrl: 'postgresql://postgres:pw@source-db-alias.example.net:6543/production',
      source: { host: 'source-db.example.com', port: '5432', database: 'production' }
    },
    {
      label: 'remote endpoint and loopback tunnel with different ports',
      sourceUrl: 'postgresql://postgres:pw@source-db.example.com:5432/production',
      targetUrl: 'postgresql://postgres:pw@localhost:5542/production',
      source: { host: 'source-db.example.com', port: '5432', database: 'production' }
    }
  ];

  try {
    for (const scenario of scenarios) {
      const expectedError = /same database name.*non-loopback.*aliases and tunnels.*distinct database name.*--allow-non-test does not override/i;
      assert.throws(
        () => restoreDb.assertRestoreTargetDiffers(
          backupDb.parseConnectionStringParts(scenario.sourceUrl),
          backupDb.parseConnectionStringParts(scenario.targetUrl)
        ),
        expectedError,
        `${scenario.label}: direct safety guard rejects the ambiguous target`
      );
      await assert.rejects(
        restoreDb.restoreBackup({
          sourceUrl: scenario.sourceUrl,
          targetUrl: scenario.targetUrl,
          allowNonTest: true,
          manifest: {
            kind: 'quickshare-native-consistent-backup',
            ...scenario.source,
            dumpSha256: digest
          },
          dumpPath,
          toolBin
        }),
        expectedError,
        `${scenario.label}: refusal precedes dump reads, Pool creation, and pg_restore`
      );
    }

    assert.deepEqual(calls, { pool: 0, dumpExists: 0, dumpRead: 0 });
    assert.equal(fs.existsSync(toolMarker), false, 'the pg_restore executable is never spawned');
  } finally {
    postgresConfig.createPostgresPool = originalPoolFactory;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreBackup blocks every same loopback alias collision before connecting or invoking pg_restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-restore-alias-'));
  const dumpPath = path.join(dir, 'synthetic.dump');
  const dump = Buffer.from('synthetic dump bytes');
  fs.writeFileSync(dumpPath, dump);
  const manifest = {
    kind: 'quickshare-native-consistent-backup',
    host: '127.0.0.1',
    port: '5541',
    database: 'issue27_src_test',
    dumpSha256: crypto.createHash('sha256').update(dump).digest('hex')
  };

  try {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const targetUrl = `postgresql://postgres:pw@${host}:5541/issue27_src_test`;
      await assert.rejects(
        restoreDb.restoreBackup({ manifest, dumpPath, sourceUrl: TEST_URL_OK, targetUrl }),
        /restore target must differ/i,
        `${host} alias must fail before target pool or pg_restore`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restore refuses every same loopback endpoint alias but accepts distinct targets', () => {
  const loopbackHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const source = { host: 'localhost', port: '5541', database: 'issue27_src_test' };

  for (const sourceHost of loopbackHosts) {
    for (const targetHost of loopbackHosts) {
      assert.throws(
        () => restoreDb.assertRestoreTargetDiffers(
          { ...source, host: sourceHost },
          { ...source, host: targetHost }
        ),
        /restore target must differ/i,
        `${sourceHost} and ${targetHost} are the same conservative loopback identity`
      );
    }
  }

  assert.equal(
    restoreDb.assertRestoreTargetDiffers(
      { ...source, host: '127.0.0.1' },
      { ...source, host: '::1', port: '5542' }
    ),
    true,
    'different port remains a distinct target even across loopback aliases'
  );
  assert.equal(
    restoreDb.assertRestoreTargetDiffers(
      { ...source, host: 'localhost' },
      { ...source, host: '127.0.0.1', database: 'issue27_restore_test' }
    ),
    true,
    'different database remains a distinct target even across loopback aliases'
  );
  assert.throws(
    () => restoreDb.assertRestoreTargetDiffers(
      { ...source, host: 'db-a.example.com' },
      { ...source, host: 'db-b.example.com' }
    ),
    /same database name.*non-loopback.*aliases and tunnels/i,
    'different remote authorities cannot prove distinct instances for the same database name'
  );
  assert.equal(
    restoreDb.assertRestoreTargetDiffers(
      { ...source, host: 'db-a.example.com' },
      { ...source, host: 'db-b.example.com', database: 'issue27_restore_test' }
    ),
    true,
    'a different remote database name remains an allowed explicit target'
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
    // Key rotation revokes the old secret too.
    { action: 'api_key.rotate', page_id: null, details: '{"apiKeyId":"k1","credentialVersion":"2"}', created_at: String(snapshotAt + 2400) },
    // Key revocation.
    { action: 'api_key.delete', page_id: null, details: '{"apiKeyId":"k1"}', created_at: String(snapshotAt + 2500) },
    // #36 read-grant revocation restores a dead authorization if replayed:
    // it must be named explicitly, not lost in generic owner review.
    { action: 'api_key.revoke', page_id: 'issue36share01', details: '{"apiKeyId":"k1","shareId":"issue36share01","grants":["read"]}', created_at: String(snapshotAt + 2600) },
    // #37 disabling future auto-edit grants is also a durable revocation.
    { action: 'api_key.auto_grant_new_share_edit.disable', page_id: null, details: '{"apiKeyId":"k1","enabled":false}', created_at: String(snapshotAt + 2700) },
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
    'api_key.rotate:null',
    'api_key.delete:null',
    'api_key.revoke:issue36share01',
    'api_key.auto_grant_new_share_edit.disable:null',
    'page.delete:gone2',
    'page.delete.batch:null'
  ]);
  assert.deepEqual(
    events.find(event => event.action === 'page.update' && event.pageId === 'a').fields,
    ['isProtected', 'passwordHash', 'encryptedPassword']
  );

  // Empty audit history must NOT be reported as proof that nothing happened.
  assert.deepEqual(verifyBackup.findPostSnapshotRevocations([], snapshotAt), []);

  // St1: the revoke action is a hard revocation by name.
  assert.ok(verifyBackup.HARD_REVOCATION_AUDIT_ACTIONS.has('api_key.revoke'), 'api_key.revoke is in the hard revocation vocabulary');
  assert.ok(verifyBackup.HARD_REVOCATION_AUDIT_ACTIONS.has('api_key.auto_grant_new_share_edit.disable'), 'disabling future edit grants is a named hard revocation');
});

test('managed key row comparison redacts credential material while naming the drift column (St2)', () => {
  const sourceHash = 'scrypt$N=16384$r=8$p=1$srcSalt$srcDigest';
  const restoreHash = 'scrypt$N=16384$r=8$p=1$restSalt$restDigest';
  const sourceRows = [{ id: 'k1', name: 'K', key_hash: sourceHash, key_prefix: 'qs.a', created_at: 1, last_used_at: null, credential_version: '1', scopes: ['share:create'], auto_grant_new_share_edit: false }];
  const restoreRows = [{ ...sourceRows[0], key_hash: restoreHash, name: 'K-renamed' }];

  const report = verifyBackup.compareApiKeyRows(sourceRows, restoreRows);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(issue => issue.column === 'key_hash'), 'the tampered column is named');
  assert.ok(report.issues.some(issue => issue.column === 'name'), 'ordinary columns keep their evidence');

  const serialized = JSON.stringify(report);
  const forms = [sourceHash, restoreHash,
    encodeURIComponent(sourceHash), encodeURIComponent(restoreHash),
    JSON.stringify(sourceHash).slice(1, -1), JSON.stringify(restoreHash).slice(1, -1)];
  for (const form of forms) {
    assert.ok(!serialized.includes(form), `no hash material leaks (${form.slice(0, 24)}...)`);
  }
  assert.match(report.issues.find(issue => issue.column === 'key_hash').message, /redacted/i);
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
    'share-revisions',
    'revision-purge-tombstones',
    'revision-current-pointer',
    'password-verify-and-decrypt',
    'expiry',
    'managed-api-keys',
    'api-key-scopes',
    'share-grants',
    'audit-logs',
    'publish-operations',
    'operation-receipt-purges',
    'site-settings',
    'migration-ledger'
  ]);
});

// #36: scope columns and per-Share grants are part of every trustworthy
// backup's explicit coverage; a verifier that cannot name them cannot be
// trusted to notice their loss.
test('backup coverage names the #36 scope and grant objects explicitly', () => {
  assert.ok(verifyBackup.COVERED_OBJECTS.includes('api-key-scopes'));
  assert.ok(verifyBackup.COVERED_OBJECTS.includes('share-grants'));
  assert.deepEqual(verifyBackup.SHARE_GRANT_COMPARED_COLUMNS, [
    'api_key_id', 'share_id', 'can_read', 'can_update', 'can_publish', 'created_at'
  ]);
  assert.deepEqual(verifyBackup.API_KEY_COMPARED_COLUMNS.slice(-2), ['scopes', 'auto_grant_new_share_edit']);
});

function dockerInspectResult({
  id,
  running = true,
  image = 'postgres:17-alpine',
  ports = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5541' }] }
}) {
  return {
    code: 0,
    stdout: `${id}@@QS@@${running}@@QS@@${image}@@QS@@${JSON.stringify(ports)}\n`,
    stderr: ''
  };
}

function dockerNotFound(target) {
  return { code: 1, stdout: '', stderr: `Error: No such object: ${target}` };
}

test('drill rejects missing, wrong, crossed, wildcard, foreign, and wrong-image container bindings before Pool or DDL', async () => {
  const src = backupRestoreCheck.FIXTURE;
  const sourceId = '6'.repeat(64);
  const restoreId = '7'.repeat(64);
  const goodSource = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(src.srcPort) }] };
  const goodRestore = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(src.restorePort) }] };
  const scenarios = [
    { name: 'wrong port', source: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '59991' }] }, error: /127\.0\.0\.1:/ },
    { name: 'missing mapping', source: { '5432/tcp': null }, error: /exact 5432\/tcp loopback binding/ },
    { name: 'crossed source and restore ports', source: goodRestore, restore: goodSource, error: /127\.0\.0\.1:/ },
    { name: 'wildcard host', source: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(src.srcPort) }] }, error: /127\.0\.0\.1:/ },
    { name: 'foreign published port', source: { ...goodSource, '5433/tcp': [{ HostIp: '127.0.0.1', HostPort: '59992' }] }, error: /only one exact 5432\/tcp/ },
    { name: 'wrong PostgreSQL image', image: 'postgres:16-alpine', error: /expected PostgreSQL image/ }
  ];

  for (const scenario of scenarios) {
    const calls = [];
    let pools = 0;
    let ddl = 0;
    const targets = new Map([
      [src.srcContainer, { id: sourceId, image: scenario.image, ports: scenario.source || goodSource }],
      [src.restoreContainer, { id: restoreId, image: 'postgres:17-alpine', ports: scenario.restore || goodRestore }]
    ]);
    const commandRunner = async argv => {
      calls.push(argv);
      const target = argv.at(-1);
      const entry = [...targets].find(([name, value]) => name === target || value.id === target);
      if (argv[1] === 'inspect' && entry) {
        return dockerInspectResult({ id: entry[1].id, image: entry[1].image, ports: entry[1].ports });
      }
      if (argv[1] === 'inspect') return dockerNotFound(target);
      return { code: 0, stdout: '', stderr: '' };
    };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-binding-'));

    try {
      await assert.rejects(backupRestoreCheck.runDrill({
        outputDir,
        skipContainerSetup: true,
        commandRunner,
        poolFactory: () => { pools += 1; throw new Error('Pool must not be constructed'); },
        migrationRunner: async () => { ddl += 1; }
      }), scenario.error, scenario.name);
      assert.equal(pools, 0, `${scenario.name}: no Pool construction`);
      assert.equal(ddl, 0, `${scenario.name}: no migration or SQL DDL`);
      assert.equal(calls.some(argv => ['exec', 'run', 'start', 'rm'].includes(argv[1])), false,
        `${scenario.name}: no database access or container mutation`);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('drill accepts distinct exact source and restore ports only when URLs match their checked container IDs', async () => {
  const src = backupRestoreCheck.FIXTURE;
  const entries = [
    {
      container: { id: '8'.repeat(64), name: src.srcContainer },
      expected: {
        port: src.srcPort, image: src.image,
        endpoint: { host: '127.0.0.1', port: String(src.srcPort), database: src.sourceDatabase },
        database: src.sourceDatabase, label: 'Source'
      }
    },
    {
      container: { id: '9'.repeat(64), name: src.restoreContainer },
      expected: {
        port: src.restorePort, image: src.image,
        endpoint: { host: '127.0.0.1', port: String(src.restorePort), database: src.restoreDatabase },
        database: src.restoreDatabase, label: 'Restore'
      }
    }
  ];
  const inspections = new Map(entries.map(({ container, expected }) => [container.name, {
    id: container.id,
    image: expected.image,
    ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(expected.port) }] }
  }]));
  const commandRunner = async argv => {
    const target = argv.at(-1);
    const entry = [...inspections].find(([name, item]) => name === target || item.id === target)?.[1];
    return entry
      ? dockerInspectResult(entry)
      : dockerNotFound(target);
  };

  assert.notEqual(src.srcPort, src.restorePort);
  for (const { container, expected } of entries) {
    assert.equal(await backupRestoreCheck.assertContainerNameStillMapsToId(container, commandRunner, expected), true);
  }
});

test('default drill binding failure cleans only the exact newly-created ID before any Pool or DDL', async () => {
  const src = backupRestoreCheck.FIXTURE;
  const ownedId = 'a'.repeat(64);
  const calls = [];
  let created = false;
  let removed = false;
  let pools = 0;
  let ddl = 0;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-created-binding-'));
  const commandRunner = async argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') {
      const target = argv.at(-1);
      if (target === src.srcContainer && !created) return dockerNotFound(target);
      if (target === src.restoreContainer) return dockerNotFound(target);
      if (target === ownedId) return removed ? dockerNotFound(target)
        : dockerInspectResult({ id: ownedId, ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '59993' }] } });
      if (target === src.srcContainer && created) {
        return dockerInspectResult({ id: ownedId, ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '59993' }] } });
      }
      return dockerNotFound(target);
    }
    if (argv[1] === 'run') {
      const cidfile = argv[argv.indexOf('--cidfile') + 1];
      fs.writeFileSync(cidfile, `${ownedId}\n`, { mode: 0o600 });
      created = true;
      return { code: 0, stdout: `${ownedId}\n`, stderr: '' };
    }
    if (argv[1] === 'rm') {
      assert.deepEqual(argv.slice(-1), [ownedId]);
      removed = true;
      return { code: 0, stdout: ownedId, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  try {
    await assert.rejects(backupRestoreCheck.runDrill({
      outputDir,
      commandRunner,
      poolFactory: () => { pools += 1; throw new Error('Pool must not be constructed'); },
      migrationRunner: async () => { ddl += 1; }
    }), /127\.0\.0\.1:/);
    assert.equal(pools, 0);
    assert.equal(ddl, 0);
    assert.equal(calls.some(argv => argv[1] === 'exec'), false);
    const removals = calls.filter(argv => argv[1] === 'rm');
    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0].slice(2), ['--force', '--volumes', ownedId]);
    assert.equal(calls.some(argv => argv[1] === 'rm' && argv.at(-1) !== ownedId), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('CLI failure reports full exact-ID cleanup status when removal fails without name-based cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-cleanup-cli-'));
  const binDir = path.join(dir, 'bin');
  const stateDir = path.join(dir, 'state');
  const outputDir = path.join(dir, 'artifacts');
  const fixture = backupRestoreCheck.FIXTURE;
  const ownedId = 'b'.repeat(64);
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  const dockerPath = path.join(binDir, 'docker');
  const dockerStub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_DOCKER_STATE;
const sourceName = ${JSON.stringify(fixture.srcContainer)};
const restoreName = ${JSON.stringify(fixture.restoreContainer)};
const sourceId = ${JSON.stringify(ownedId)};
if (args[0] === 'inspect') {
  const target = args.at(-1);
  if (fs.existsSync(path.join(state, 'source-created')) && (target === sourceName || target === sourceId)) {
    process.stdout.write([sourceId, 'true', ${JSON.stringify(fixture.image)}, JSON.stringify({'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':${JSON.stringify(String(fixture.srcPort))}}]})].join('@@QS@@') + '\\n');
    process.exit(0);
  }
  process.stderr.write('Error: No such object: ' + target + '\\n');
  process.exit(1);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  if (name === sourceName) {
    const cidfile = args[args.indexOf('--cidfile') + 1];
    fs.writeFileSync(cidfile, sourceId + '\\n', { mode: 0o600 });
    fs.writeFileSync(path.join(state, 'source-created'), 'owned');
    process.stdout.write(sourceId + '\\n');
    process.exit(0);
  }
  if (name === restoreName) {
    process.stderr.write('synthetic restore create failure\\n');
    process.exit(1);
  }
}
if (args[0] === 'rm') {
  fs.writeFileSync(path.join(state, 'rm-args'), args.slice(1).join(' '));
  process.stderr.write('synthetic remove failure\\n');
  process.exit(1);
}
process.stderr.write('unexpected docker invocation\\n');
process.exit(2);
`;

  try {
    fs.writeFileSync(dockerPath, dockerStub, { mode: 0o700 });
    fs.chmodSync(dockerPath, 0o700);
    const cli = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/backup-restore-check.js'), '--output-dir', outputDir
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_STATE: stateDir }
    });
    assert.equal(cli.status, 1, cli.stderr || cli.stdout);
    assert.match(cli.stderr, /\[backup:check\] failed: docker run issue27-pg-restore failed/);
    const cleanupLine = cli.stderr.split('\n').find(line => line.startsWith('[backup:check] cleanup: '));
    assert.ok(cleanupLine, cli.stderr);
    const cleanup = JSON.parse(cleanupLine.slice('[backup:check] cleanup: '.length));
    assert.deepEqual(cleanup, [{ id: ownedId, name: fixture.srcContainer, status: 'remove-failed' }]);
    assert.equal(cli.stderr.includes(fixture.password), false, 'cleanup diagnostics never include credentials');
    assert.equal(fs.readFileSync(path.join(stateDir, 'rm-args'), 'utf8'), `--force --volumes ${ownedId}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('drill URL validation rejects unsafe env overrides before Docker, Pool, or DDL, including skip-container mode', () => {
  const cases = [
    { env: { Q27_DRILL_SRC_DATABASE: 'production' }, skip: false, error: /_test/ },
    { env: { Q27_DRILL_RESTORE_DATABASE: 'x_test;DROP_DATABASE' }, skip: true, error: /SQL identifier/ },
    { env: { Q27_DRILL_RESTORE_PORT: '5541', Q27_DRILL_RESTORE_DATABASE: 'issue27_src_test' }, skip: true, error: /distinct effective PostgreSQL endpoints/ }
  ];

  for (const scenario of cases) {
    const source = `
      const drill = require('./scripts/backup-restore-check');
      const counts = { docker: 0, pool: 0, ddl: 0 };
      drill.runDrill({
        skipContainerSetup: ${scenario.skip},
        commandRunner: async () => { counts.docker += 1; return { code: 0, stdout: '', stderr: '' }; },
        poolFactory: () => { counts.pool += 1; return { query: async () => { counts.ddl += 1; }, end: async () => {} }; },
        migrationRunner: async () => { counts.ddl += 1; }
      }).then(() => process.exit(3)).catch(error => {
        console.log(JSON.stringify({ message: error.message, counts }));
        if (counts.docker || counts.pool || counts.ddl) process.exit(4);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', source], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, ...scenario.env, Q27_DRILL_ALLOW_NON_TEST: '1' }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.match(report.message, scenario.error);
    assert.deepEqual(report.counts, { docker: 0, pool: 0, ddl: 0 });
  }
});

test('drill target validator rejects IPv4/IPv6 effective endpoint aliases', () => {
  assert.throws(() => backupRestoreCheck.validateDrillTargets({
    sourceUrl: 'postgresql://postgres:pw@127.0.0.1:5541/source_test',
    restoreUrl: 'postgresql://postgres:pw@[::1]:5541/source_test',
    sourceDatabase: 'source_test',
    restoreDatabase: 'source_test'
  }), /distinct effective PostgreSQL endpoints/);
  assert.throws(() => backupRestoreCheck.assertSqlDatabaseIdentifier('x_test;DROP_DATABASE', 'Source database'), /SQL identifier/);
  assert.throws(() => backupRestoreCheck.assertSqlDatabaseIdentifier(`${'x'.repeat(60)}_test`, 'Source database'), /63 ASCII characters/);
});

test('drill rejects pre-existing running and stopped containers without creating or starting them', async () => {
  for (const running of [true, false]) {
    const id = (running ? 'c' : 'd').repeat(64);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-existing-'));
    const ownedContainers = [];
    const calls = [];
    const commandRunner = async argv => {
      calls.push(argv);
      if (argv[1] === 'inspect') return dockerInspectResult({ id, name: 'already-owned', running });
      return { code: 0, stdout: '', stderr: '' };
    };

    try {
      await assert.rejects(
        backupRestoreCheck.ensureContainerRunning('already-owned', 56431, 'postgres:17-alpine', {
          outputDir, ownedContainers, commandRunner
        }),
        /pre-existing (?:running|stopped) container/
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(ownedContainers, []);
      assert.equal(calls.some(argv => argv[1] === 'run' || argv[1] === 'start'), false);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('drill detects a same-name replacement after creation and cleanup remains pinned to the created ID', async () => {
  const ownedId = 'e'.repeat(64);
  const replacementId = 'f'.repeat(64);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-replacement-'));
  const ownedContainers = [];
  const calls = [];
  let removed = false;
  const commandRunner = async argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') {
      const target = argv.at(-1);
      if (target === 'r6-source' && ownedContainers.length === 0) return dockerNotFound(target);
      if (target === 'r6-source') return dockerInspectResult({ id: replacementId });
      if (target === ownedId) return removed ? dockerNotFound(target) : dockerInspectResult({ id: ownedId });
    }
    if (argv[1] === 'run') {
      fs.writeFileSync(argv[argv.indexOf('--cidfile') + 1], `${ownedId}\n`, { mode: 0o600 });
      ownedContainers.push({ id: ownedId, name: 'r6-source' });
      return { code: 0, stdout: `${ownedId}\n`, stderr: '' };
    }
    if (argv[1] === 'rm') {
      assert.deepEqual(argv.slice(-1), [ownedId]);
      removed = true;
      return { code: 0, stdout: ownedId, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  try {
    await assert.rejects(backupRestoreCheck.ensureContainerRunning('r6-source', 56441, 'postgres:17-alpine', {
      outputDir, ownedContainers, commandRunner
    }), /no longer maps to its preflight ID/);
    const result = await backupRestoreCheck.cleanupOwnedContainer(ownedContainers[0], commandRunner);
    assert.equal(result.status, 'removed-exact-id');
    const removal = calls.find(argv => argv[1] === 'rm');
    assert.deepEqual(removal.slice(2), ['--force', '--volumes', ownedId]);
    assert.equal(removal.includes(replacementId), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('drill exact-ID cleanup requests removal of only the owned container and its anonymous volumes', async () => {
  const ownedId = 'a'.repeat(64);
  let removed = false;
  const calls = [];
  const commandRunner = async argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') {
      const target = argv.at(-1);
      if (removed) return dockerNotFound(target);
      if (target === ownedId || target === 'r6-source') return dockerInspectResult({ id: ownedId });
    }
    if (argv[1] === 'rm') {
      assert.deepEqual(argv.slice(-1), [ownedId]);
      removed = true;
      return { code: 0, stdout: ownedId, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await backupRestoreCheck.cleanupOwnedContainer({ id: ownedId, name: 'r6-source' }, commandRunner);
  assert.equal(result.status, 'removed-exact-id');
  const removal = calls.find(argv => argv[1] === 'rm');
  assert.deepEqual(removal.slice(2), ['--force', '--volumes', ownedId]);
});

test('drill creation failure midway cleans only the exact ID created earlier in the run', async () => {
  const sourceId = '2'.repeat(64);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-mid-create-'));
  const calls = [];
  let sourceCreated = false;
  let sourceRemoved = false;
  const commandRunner = async argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') {
      const target = argv.at(-1);
      if (target === backupRestoreCheck.FIXTURE.srcContainer) {
        return !sourceCreated || sourceRemoved ? dockerNotFound(target) : dockerInspectResult({ id: sourceId });
      }
      if (target === backupRestoreCheck.FIXTURE.restoreContainer) return dockerNotFound(target);
      if (target === sourceId) {
        return !sourceCreated || sourceRemoved ? dockerNotFound(target) : dockerInspectResult({ id: sourceId });
      }
    }
    if (argv[1] === 'run') {
      const name = argv[argv.indexOf('--name') + 1];
      if (name === backupRestoreCheck.FIXTURE.srcContainer) {
        const cidfile = argv[argv.indexOf('--cidfile') + 1];
        fs.writeFileSync(cidfile, `${sourceId}\n`, { mode: 0o600 });
        sourceCreated = true;
        return { code: 0, stdout: `${sourceId}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'synthetic restore-container create failure' };
    }
    if (argv[1] === 'rm') {
      assert.deepEqual(argv.slice(-1), [sourceId]);
      sourceRemoved = true;
      return { code: 0, stdout: sourceId, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  try {
    let failure;
    try {
      await backupRestoreCheck.runDrill({
        outputDir,
        commandRunner,
        readinessTimeoutMs: 1,
        poolFactory: () => { throw new Error('Pool must not be reached'); },
        migrationRunner: async () => { throw new Error('DDL must not be reached'); }
      });
    } catch (error) {
      failure = error;
    }
    assert.match(failure.message, /docker run issue27-pg-restore failed/);
    const removal = calls.find(argv => argv[1] === 'rm');
    assert.deepEqual(removal.slice(2), ['--force', '--volumes', sourceId]);
    assert.equal(calls.some(argv => argv[1] === 'exec' || argv[1] === 'start'), false);
    assert.equal(failure.cleanup[0].id, sourceId);
    assert.equal(failure.cleanup[0].status, 'removed-exact-id');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('skip-container-setup never removes pre-existing containers, even when the drill aborts', async () => {
  const ids = {
    [backupRestoreCheck.FIXTURE.srcContainer]: '4'.repeat(64),
    [backupRestoreCheck.FIXTURE.restoreContainer]: '5'.repeat(64)
  };
  const calls = [];
  const commandRunner = async argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') {
      const target = argv.at(-1);
      const name = Object.keys(ids).find(candidate => candidate === target || ids[candidate] === target);
      const port = name === backupRestoreCheck.FIXTURE.srcContainer
        ? backupRestoreCheck.FIXTURE.srcPort : backupRestoreCheck.FIXTURE.restorePort;
      return name ? dockerInspectResult({
        id: ids[name], ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] }
      }) : dockerNotFound(target);
    }
    if (argv[1] === 'exec' && argv.includes('pg_isready')) return { code: 0, stdout: 'accepting connections', stderr: '' };
    if (argv[1] === 'exec' && argv.includes('psql')) return { code: 1, stdout: '', stderr: 'synthetic inventory read failure' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs43-drill-skip-'));

  try {
    let failure;
    try {
      await backupRestoreCheck.runDrill({
        outputDir,
        skipContainerSetup: true,
        commandRunner,
        poolFactory: () => { throw new Error('Pool must not be reached'); }
      });
    } catch (error) {
      failure = error;
    }
    assert.match(failure.message, /Could not check database/);
    assert.equal(calls.some(argv => argv[1] === 'rm' || argv[1] === 'start' || argv[1] === 'run'), false);
    assert.equal(calls.some(argv => argv[1] === 'exec' && argv.join(' ').includes('CREATE DATABASE')), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
