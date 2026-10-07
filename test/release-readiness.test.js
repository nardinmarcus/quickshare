'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const {
  validateCanonicalPostgresSuiteUrl,
  validateClientCandidate,
  validatePostgresTestUrl,
  validateTapSummary
} = require('../scripts/release-readiness-check');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts/release-readiness-check.js');
const PINNED_CLIENT_ROOT = '/Users/dapeng/projects/quickshare-client-worktrees/integration';
const INTEGRATION_TEST = path.join(ROOT, 'test/integration/postgres-release-readiness.test.js');
const PUBLISH_STATE_TEST = path.join(ROOT, 'test/integration/postgres-api-publish-state.test.js');
const MIGRATIONS_TEST = path.join(ROOT, 'test/integration/postgres-migrations.test.js');
const BACKUP_TEST = path.join(ROOT, 'test/integration/postgres-backup.test.js');
const POSTGRES_ENTRIES = [
  'postgres-api-keys.test.js',
  'postgres-api-publish-state.test.js',
  'postgres-api-revisions.test.js',
  'postgres-backup.test.js',
  'postgres-grants.test.js',
  'postgres-history.test.js',
  'postgres-maintenance.test.js',
  'postgres-migrations.test.js',
  'postgres-operations.test.js',
  'postgres-purge.test.js',
  'postgres-release-readiness.test.js',
  'postgres-revisions.test.js',
  'postgres-update-grants.test.js'
].map(name => path.join(ROOT, 'test/integration', name));
const CONNECTION_OVERRIDES = [
  ['host', 'host=203.0.113.8'],
  ['socket', 'host=%2Fvar%2Frun%2Fpostgresql'],
  ['hostaddr', 'hostaddr=203.0.113.8'],
  ['port', 'port=5432'],
  ['database', 'database=issue43_override_test']
];
const ENTRY_PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickshare-43-entry-probe-'));
const ENTRY_PROBE_PRELOAD = path.join(ENTRY_PROBE_DIR, 'forbid-postgres-io.cjs');
fs.writeFileSync(ENTRY_PROBE_PRELOAD, `
'use strict';
const fs = require('node:fs');
const pg = require(process.env.ISSUE43_PG_MODULE);
const net = require('node:net');
const childProcess = require('node:child_process');
const marker = process.env.ISSUE43_DB_IO_MARKER;
function blocked(kind) {
  if (marker) fs.appendFileSync(marker, kind + '\\n');
  throw new Error('ISSUE43_POSTGRES_IO_BLOCKED_' + kind);
}
const Pool = pg.Pool;
Pool.prototype.connect = function () { return blocked('pool-connect'); };
Pool.prototype.query = function () { return blocked('pool-query'); };
pg.Pool = new Proxy(Pool, { construct() { return blocked('pool-constructor'); } });
pg.Client.prototype.connect = function () { return blocked('client-connect'); };
pg.Client.prototype.query = function () { return blocked('client-query'); };
net.Socket.prototype.connect = function () { return blocked('socket-connect'); };
if (process.env.ISSUE43_BLOCK_CHILD_LAUNCH === '1') {
  childProcess.spawn = function () { return blocked('child-spawn'); };
}
`);
let entryProbeNumber = 0;
const VALID_URL = 'postgresql://synthetic:secret@127.0.0.1:55443/issue43_test?sslmode=disable';

const COMPLETE_TAP = `TAP version 13
1..3
ok 1 - first
ok 2 - second
ok 3 - third
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

test('release TAP summary requires exact pass count and zero TODO, cancelled, skipped, or failed tests', () => {
  assert.equal(validateTapSummary(COMPLETE_TAP, 3), true);
  for (const unsafe of [
    COMPLETE_TAP.replace('# todo 0', '# todo 1'),
    COMPLETE_TAP.replace('# cancelled 0', '# cancelled 1'),
    COMPLETE_TAP.replace('# skipped 0', '# skipped 1'),
    COMPLETE_TAP.replace('# fail 0', '# fail 1'),
    COMPLETE_TAP.replace('# pass 3', '# pass 2'),
    COMPLETE_TAP.replace('# tests 3\n', ''),
    COMPLETE_TAP.replace('1..3', '1..2'),
    `${COMPLETE_TAP}# todo 0\n`
  ]) {
    assert.equal(validateTapSummary(unsafe, 3), false, unsafe);
  }
});

test.after(() => fs.rmSync(ENTRY_PROBE_DIR, { recursive: true, force: true }));

function probeEnvironment(url = VALID_URL, clientRoot) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_ENV: 'test',
    POSTGRES_TEST_URL: url,
    ...(clientRoot ? { QUICKSHARE_TEST_CLIENT_ROOT: clientRoot } : {})
  };
}

function runNode(args, env = probeEnvironment()) {
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
}

function runGuardProbe(command, args, url, clientRoot, { blockChildLaunch = false } = {}) {
  const marker = path.join(ENTRY_PROBE_DIR, `guard-io-${++entryProbeNumber}.txt`);
  const env = {
    ...probeEnvironment(url, clientRoot),
    NODE_OPTIONS: `--require=${ENTRY_PROBE_PRELOAD}`,
    ISSUE43_PG_MODULE: require.resolve('pg'),
    ISSUE43_DB_IO_MARKER: marker,
    ...(blockChildLaunch ? { ISSUE43_BLOCK_CHILD_LAUNCH: '1' } : {})
  };
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
  return { result, marker, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function runPostgresEntryProbe(entry, { testUrl, sourceUrl, restoreUrl, direct = false }) {
  const marker = path.join(ENTRY_PROBE_DIR, `io-${++entryProbeNumber}.txt`);
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_ENV: 'test',
    NODE_OPTIONS: `--require=${ENTRY_PROBE_PRELOAD}`,
    ISSUE43_PG_MODULE: require.resolve('pg'),
    ISSUE43_DB_IO_MARKER: marker,
    ...(testUrl ? { POSTGRES_TEST_URL: testUrl } : {}),
    ...(sourceUrl ? { POSTGRES_BACKUP_TEST_SRC_URL: sourceUrl } : {}),
    ...(restoreUrl ? { POSTGRES_BACKUP_TEST_RESTORE_URL: restoreUrl } : {})
  };
  const args = direct ? [entry] : ['--test', entry];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, env, encoding: 'utf8', timeout: 15000
  });
  return { result, marker, output: `${result.stdout || ''}${result.stderr || ''}` };
}

test('release-readiness guard checks node-postgres effective loopback host, port and database', () => {
  const normal = 'postgresql://synthetic:secret@127.0.0.1:55443/issue43_test?sslmode=disable';
  assert.equal(validatePostgresTestUrl(normal).pathname, '/issue43_test');
  assert.equal(validatePostgresTestUrl('postgres://synthetic:secret@[::1]:5432/issue43_test').hostname, '[::1]');

  const remoteOverride = 'postgresql://synthetic:secret@127.0.0.1:55443/issue43_test?host=203.0.113.8';
  assert.equal(new Client({ connectionString: remoteOverride }).connectionParameters.host, '203.0.113.8',
    'the regression probe confirms node-postgres gives the query host precedence over the localhost authority');

  for (const unsafe of [
    remoteOverride,
    'postgres://synthetic:secret@127.0.0.1/issue43_test?hostaddr=203.0.113.8',
    'postgres://synthetic:secret@127.0.0.1:55443/issue43_test?port=5432',
    'postgres://synthetic:secret@127.0.0.1/issue43_test?database=other_test',
    'postgres://synthetic:secret@127.0.0.1/issue43_test?host=%2Fvar%2Frun%2Fpostgresql',
    'postgres://synthetic:secret@127.0.0.1/issue43_test?sslmode=disable&host=203.0.113.8',
    'postgres://synthetic:secret@127.0.0.1/issue43_test?sslmode=disable&sslmode=verify-full',
    'postgres://synthetic:secret@127.0.0.1/issue43_test?ssl=1',
    'postgresql://synthetic:secret@[2001:db8::1]/issue43_test'
  ]) {
    assert.throws(() => validatePostgresTestUrl(unsafe), /localhost PostgreSQL URL for a _test database/);
  }
});

test('canonical suite validator pins the actor-owned database without restricting generic _test fixtures', () => {
  const canonicalUrl = 'postgresql://synthetic:secret@127.0.0.1:55443/issue39_api_publish_test?sslmode=disable';
  assert.equal(validateCanonicalPostgresSuiteUrl(canonicalUrl).pathname, '/issue39_api_publish_test');

  const independentlyOwnedBackupUrl = 'postgresql://synthetic:secret@127.0.0.1:55443/other_test?sslmode=disable';
  assert.equal(validatePostgresTestUrl(independentlyOwnedBackupUrl).pathname, '/other_test');
  assert.throws(() => validateCanonicalPostgresSuiteUrl(independentlyOwnedBackupUrl), /issue39_api_publish_test/);
});

test('runner rejects remote URI overrides before client validation or test launch', () => {
  const result = runNode([RUNNER], probeEnvironment(
    'postgres://synthetic:secret@127.0.0.1/issue43_test?host=203.0.113.8'
  ));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /localhost PostgreSQL URL for a _test database/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TAP version/);
});

test('canonical PostgreSQL suite rejects unsafe targets before loading destructive test files', () => {
  const result = spawnSync('npm', ['run', 'test:postgres'], {
    cwd: ROOT,
    env: probeEnvironment('postgres://synthetic:secret@127.0.0.1/issue39_api_publish_test?host=203.0.113.8'),
    encoding: 'utf8',
    timeout: 15000
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /localhost PostgreSQL URL for a _test database/);
  assert.doesNotMatch(output, /TAP version|DROP SCHEMA/);
});

test('standalone release checker rejects wrong local _test before child launch or database I/O with the pinned client', () => {
  const wrongNameUrl = 'postgresql://synthetic:secret@127.0.0.1:55443/other_test?sslmode=disable';
  const { result, marker, output } = runGuardProbe(
    process.execPath, [RUNNER], wrongNameUrl, PINNED_CLIENT_ROOT, { blockChildLaunch: true }
  );
  assert.equal(result.status, 2, output);
  assert.match(output, /issue39_api_publish_test/);
  assert.doesNotMatch(output, /QUICKSHARE_TEST_CLIENT_ROOT must|TAP version|DROP SCHEMA/);
  assert.equal(fs.existsSync(marker), false,
    `standalone checker must reject before launching the pinned-client child or PostgreSQL I/O: ${output}`);
});

test('every direct canonical PostgreSQL entry rejects wrong local _test before TAP, pool construction, or DDL', () => {
  const wrongNameUrl = 'postgresql://synthetic:synthetic@127.0.0.1:55443/other_test?sslmode=disable';
  for (const entry of POSTGRES_ENTRIES.filter(candidate => candidate !== BACKUP_TEST)) {
    const { result, marker, output } = runPostgresEntryProbe(entry, { testUrl: wrongNameUrl, direct: true });
    assert.notEqual(result.status, 0, `${entry}: ${output}`);
    assert.match(output, /issue39_api_publish_test/, `${entry} must require the canonical actor-owned database`);
    assert.doesNotMatch(output, /TAP version|^ok \d|# Subtest:|DROP SCHEMA/m,
      `${entry} must reject before test registration or DDL`);
    assert.equal(fs.existsSync(marker), false,
      `${entry} must reject before Pool/Client connection, socket I/O or DDL: ${output}`);
  }
});

test('canonical suite and direct migrations entry reject wrong local _test before runner output or database I/O', () => {
  const wrongNameUrl = 'postgresql://synthetic:secret@127.0.0.1:55443/other_test?sslmode=disable';
  const canonical = runGuardProbe('npm', ['run', '--silent', 'test:postgres'], wrongNameUrl);
  assert.notEqual(canonical.result.status, 0, canonical.output);
  assert.match(canonical.output, /issue39_api_publish_test/);
  assert.doesNotMatch(canonical.output, /TAP version|DROP SCHEMA/);
  assert.equal(fs.existsSync(canonical.marker), false,
    `canonical preflight must reject before Pool/Client connection, network or DDL: ${canonical.output}`);

  const direct = runGuardProbe(process.execPath, [MIGRATIONS_TEST], wrongNameUrl);
  assert.notEqual(direct.result.status, 0, direct.output);
  assert.match(direct.output, /issue39_api_publish_test/);
  assert.doesNotMatch(direct.output, /TAP version|^ok \d|# Subtest:|DROP SCHEMA/m);
  assert.equal(fs.existsSync(direct.marker), false,
    `direct migrations guard must reject before Pool/Client connection, network or DDL: ${direct.output}`);
});

test('all PostgreSQL test entries reject target overrides before pool construction or DDL', () => {
  for (const entry of POSTGRES_ENTRIES.filter(candidate => candidate !== BACKUP_TEST)) {
    const database = entry === PUBLISH_STATE_TEST ? 'issue39_api_publish_test' : 'issue43_guard_test';
    const baseUrl = `postgresql://synthetic:synthetic@127.0.0.1:55443/${database}`;
    for (const [override, query] of CONNECTION_OVERRIDES) {
      const { result, marker, output } = runPostgresEntryProbe(entry, {
        testUrl: `${baseUrl}?${query}`
      });
      assert.notEqual(result.status, 0, `${entry} (${override}): ${output}`);
      assert.match(output, /POSTGRES_TEST_URL must be a localhost PostgreSQL URL for a _test database/,
        `${entry} (${override}) must fail in the shared URL preflight`);
      assert.equal(fs.existsSync(marker), false,
        `${entry} (${override}) must reject before a pool, client connection or query can run`);
    }
  }
});

test('backup entry validates both source and restore targets before pool construction or DDL', () => {
  const sourceBase = 'postgresql://synthetic:synthetic@127.0.0.1:55443/issue43_source_test';
  const restoreBase = 'postgresql://synthetic:synthetic@127.0.0.1:55443/issue43_restore_test';
  for (const [override, query] of CONNECTION_OVERRIDES) {
    for (const invalidSide of ['source', 'restore']) {
      const sourceUrl = invalidSide === 'source' ? `${sourceBase}?${query}` : sourceBase;
      const restoreUrl = invalidSide === 'restore' ? `${restoreBase}?${query}` : restoreBase;
      const { result, marker, output } = runPostgresEntryProbe(BACKUP_TEST, { sourceUrl, restoreUrl });
      assert.notEqual(result.status, 0, `${invalidSide} ${override}: ${output}`);
      assert.match(output, /POSTGRES_TEST_URL must be a localhost PostgreSQL URL for a _test database/,
        `${invalidSide} ${override} must fail in the shared URL preflight`);
      assert.equal(fs.existsSync(marker), false,
        `${invalidSide} ${override} must reject before a pool, client connection or query can run`);
    }
  }
});

test('backup preflight rejects all loopback alias collisions before pool construction', () => {
  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
  for (const sourceHost of loopbackHosts) {
    for (const restoreHost of loopbackHosts) {
      const sourceUrl = `postgresql://synthetic:synthetic@${sourceHost}:55443/issue43_collision_test`;
      const restoreUrl = `postgresql://synthetic:synthetic@${restoreHost}:55443/issue43_collision_test`;
      const { result, marker, output } = runPostgresEntryProbe(BACKUP_TEST, { sourceUrl, restoreUrl });
      assert.notEqual(result.status, 0, `${sourceHost} → ${restoreHost}: ${output}`);
      assert.match(output, /source and restore URLs must target distinct databases/);
      assert.equal(fs.existsSync(marker), false,
        `${sourceHost} → ${restoreHost} must reject before pool construction or DDL`);
    }
  }

  const differentDatabase = runPostgresEntryProbe(BACKUP_TEST, {
    sourceUrl: 'postgresql://synthetic:synthetic@127.0.0.1:55443/issue43_source_test',
    restoreUrl: 'postgresql://synthetic:synthetic@[::1]:55443/issue43_restore_test'
  });
  assert.equal(fs.existsSync(differentDatabase.marker), true,
    `distinct databases pass the collision preflight and reach the blocked pool-construction boundary: ${differentDatabase.output}`);
  assert.match(fs.readFileSync(differentDatabase.marker, 'utf8'), /pool-constructor/);
  assert.doesNotMatch(differentDatabase.output, /source and restore URLs must target distinct databases/);
});

test('backup package script invokes the direct entry protected by both URL preflights', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['test:postgres:backup'], /test\/integration\/postgres-backup\.test\.js/);
  const entry = fs.readFileSync(BACKUP_TEST, 'utf8');
  assert.match(entry, /validatePostgresTestUrl\(sourceUrl\)/);
  assert.match(entry, /validatePostgresTestUrl\(restoreUrl\)/);
});

test('release checker fails closed without the pinned client checkout', () => {
  assert.throws(() => validateClientCandidate(undefined), /QUICKSHARE_TEST_CLIENT_ROOT/);
  const result = runNode([RUNNER], probeEnvironment(
    'postgresql://synthetic:secret@127.0.0.1:1/issue39_api_publish_test?sslmode=disable'
  ));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /QUICKSHARE_TEST_CLIENT_ROOT/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TAP version/);
});

test('integration module loads without client opt-in while all tests are filtered before hooks or DDL', () => {
  const result = runNode([
    '--test', '--test-reporter=tap', '--test-name-pattern=^__issue43_no_test_matches__$', INTEGRATION_TEST
  ], probeEnvironment('postgresql://synthetic:secret@127.0.0.1:1/issue39_api_publish_test?sslmode=disable'));
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /# pass 1/);
  assert.doesNotMatch(output, /QUICKSHARE_TEST_CLIENT_ROOT must|ECONNREFUSED|DROP SCHEMA/);
});
