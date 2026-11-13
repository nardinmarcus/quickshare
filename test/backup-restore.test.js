const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertIsolatedDatabaseUrl,
  buildManifest,
  buildSection,
  compareSnapshots,
  detectAccessRevocations,
  parseArgs,
  rowDigest
} = require('../scripts/backup-lib');

const CLI_SPEC = {
  databaseUrl: { type: 'string', required: true },
  outputDir: { type: 'string' },
  allowNonTest: { type: 'boolean' }
};

test('argument parser: bare boolean flags never swallow the next option', () => {
  const options = parseArgs(
    ['--allow-non-test', '--database-url', 'postgres://127.0.0.1:5432/quickshare_test', '--output-dir', 'out'],
    { ...CLI_SPEC, outputDir: { type: 'string', required: true } }
  );

  assert.equal(options.allowNonTest, true);
  assert.equal(options.databaseUrl, 'postgres://127.0.0.1:5432/quickshare_test');
  assert.equal(options.outputDir, 'out');
});

test('argument parser: the allow-non-test key is consumed identically in every position', () => {
  const withEquals = parseArgs(
    ['--database-url=postgres://127.0.0.1:5432/prod', '--allow-non-test'],
    CLI_SPEC
  );
  const withSeparateValue = parseArgs(
    ['--allow-non-test', '--database-url', 'postgres://127.0.0.1:5432/prod'],
    CLI_SPEC
  );

  assert.equal(withEquals.allowNonTest, true);
  assert.equal(withSeparateValue.allowNonTest, true);
  assert.equal(withEquals.databaseUrl, withSeparateValue.databaseUrl);
});

test('argument parser: rejects unknown options, missing values and duplicates', () => {
  assert.throws(() => parseArgs(['--nope', 'x'], CLI_SPEC), /Unknown option/);
  assert.throws(() => parseArgs(['--database-url'], CLI_SPEC), /requires a value/);
  assert.throws(
    () => parseArgs(['--database-url', '--allow-non-test'], CLI_SPEC),
    /requires a value/
  );
  assert.throws(
    () => parseArgs(['--database-url', 'a', '--database-url', 'b'], CLI_SPEC),
    /may only be given once/
  );
  assert.throws(() => parseArgs(['--allow-non-test=true', '--database-url', 'a'], CLI_SPEC), /boolean flag/);
  assert.throws(() => parseArgs([], CLI_SPEC), /Missing required option/);
});

test('database guard: only localhost, _test names unless explicitly allowed', () => {
  assert.equal(
    assertIsolatedDatabaseUrl('postgres://u:p@127.0.0.1:5432/quickshare_test').database,
    'quickshare_test'
  );
  assert.throws(
    () => assertIsolatedDatabaseUrl('postgres://u:p@db.example.com:5432/quickshare_test'),
    /localhost/
  );
  assert.throws(
    () => assertIsolatedDatabaseUrl('postgres://u:p@localhost:5432/quickshare_prod'),
    /_test/
  );
  assert.equal(
    assertIsolatedDatabaseUrl(
      'postgres://u:p@localhost:5432/quickshare_prod',
      { allowNonTest: true }
    ).database,
    'quickshare_prod'
  );
  assert.throws(() => assertIsolatedDatabaseUrl('mysql://u:p@localhost:3306/x_test'), /postgres/);
});

test('revocation detector: page.update only counts when access policy fields change', () => {
  const events = detectAccessRevocations([
    { id: 1, action: 'page.update', page_id: 'a', details: JSON.stringify({ fields: ['passwordHash'] }), created_at: 100 },
    { id: 2, action: 'page.update', page_id: 'b', details: JSON.stringify({ fields: ['title', 'description'] }), created_at: 101 },
    { id: 3, action: 'page.update', page_id: 'c', details: JSON.stringify({ fields: ['isProtected', 'expiresAt'] }), created_at: 102 },
    { id: 4, action: 'page.update', page_id: 'd', details: 'not-json', created_at: 103 },
    { id: 5, action: 'page.access.revoke', page_id: 'e', details: JSON.stringify({ accessRevision: '3' }), created_at: 104 },
    { id: 6, action: 'page.delete', page_id: 'f', details: '{}', created_at: 105 },
    { id: 7, action: 'page.delete.batch', page_id: null, details: JSON.stringify({ count: 2, ids: ['g', 'h'] }), created_at: 106 },
    { id: 8, action: 'page.create', page_id: 'i', details: '{}', created_at: 107 },
    { id: 9, action: 'page.favorite.update', page_id: 'a', details: '{}', created_at: 108 }
  ]);

  assert.deepEqual(
    events.map(event => `${event.pageId}:${event.type}`),
    ['a:access-policy-change', 'c:access-policy-change', 'e:access-revoke', 'f:page-delete', 'null:page-delete-batch']
  );
  assert.deepEqual(events[0].fields, ['passwordHash']);
  assert.deepEqual(events[1].fields, ['isProtected', 'expiresAt']);
  assert.deepEqual(events[4].pageIds, ['g', 'h']);
});

function fakeSnapshot(overrides = {}) {
  const pageRow = {
    id: 'page-1',
    html_content: '<p>body</p>',
    created_at: '1760000000000',
    password_hash: 'scrypt$secret-hash-value',
    encrypted_password: 'v1.encrypted-value',
    is_protected: 1,
    code_type: 'html',
    title: 'Title',
    description: 'Description',
    expires_at: null,
    markdown_theme: null,
    view_count: '3',
    is_favorite: false,
    access_revision: '9007199254740993'
  };
  const pageFields = Object.keys(pageRow);
  const pages = buildSection([pageRow], pageFields, 'id');
  pages.hasAccessRevision = true;
  pages.accessRevisions = { 'page-1': '9007199254740993' };

  const snapshot = {
    serverVersion: '18.6',
    serverMajor: 18,
    tables: ['api_keys', 'audit_logs', 'pages', 'quickshare_schema_migrations', 'site_settings'],
    columns: {
      pages: pageFields.sort(),
      api_keys: ['id'],
      audit_logs: ['id'],
      site_settings: ['id'],
      quickshare_schema_migrations: ['version']
    },
    counts: { pages: '1', api_keys: '0', audit_logs: '0', site_settings: '1', quickshare_schema_migrations: '4' },
    ledger: [
      { version: '001', name: '001_baseline.sql', checksum: 'aaa', appliedAt: '1' },
      { version: '004', name: '004_page_access_revision.sql', checksum: 'ddd', appliedAt: '4' }
    ],
    pages,
    apiKeys: buildSection([], ['id'], 'id'),
    audit: { ...buildSection([], ['id'], 'id'), highWaterId: null, highWaterCreatedAt: null },
    siteSettings: buildSection(
      [{ id: 1, homepage_password_required: true, updated_at: '1760000000000' }],
      ['id', 'homepage_password_required', 'updated_at'],
      'id'
    )
  };

  return { ...snapshot, ...overrides };
}

test('snapshot comparison: identical snapshots pass, tampering is reported', () => {
  assert.deepEqual(compareSnapshots(fakeSnapshot(), fakeSnapshot()), []);

  const tamperedPages = buildSection([{
    id: 'page-1',
    html_content: '<p>body</p>',
    created_at: '1760000000000',
    password_hash: 'scrypt$secret-hash-value',
    encrypted_password: 'v1.encrypted-value',
    is_protected: 1,
    code_type: 'html',
    title: 'Title',
    description: 'Description',
    expires_at: null,
    markdown_theme: null,
    view_count: '3',
    is_favorite: false,
    access_revision: '9007199254740994'
  }], [
    'id', 'html_content', 'created_at', 'password_hash', 'encrypted_password',
    'is_protected', 'code_type', 'title', 'description', 'expires_at',
    'markdown_theme', 'view_count', 'is_favorite', 'access_revision'
  ], 'id');
  tamperedPages.hasAccessRevision = true;
  tamperedPages.accessRevisions = { 'page-1': '9007199254740994' };

  const failures = compareSnapshots(fakeSnapshot(), fakeSnapshot({ pages: tamperedPages }));
  assert.ok(failures.some(failure => failure.includes('page-1') && failure.includes('access_revision')));
});

test('snapshot comparison: unaccounted tables and ledger drift fail loudly', () => {
  const withExtraTable = fakeSnapshot({
    tables: ['api_keys', 'audit_logs', 'pages', 'quickshare_schema_migrations', 'site_settings', 'future_table'],
    columns: { ...fakeSnapshot().columns, future_table: ['id'] },
    counts: { ...fakeSnapshot().counts, future_table: '0' }
  });
  assert.ok(
    compareSnapshots(fakeSnapshot(), withExtraTable)
      .some(failure => failure.includes('future_table'))
  );

  const ledgerDrift = fakeSnapshot({ ledger: [fakeSnapshot().ledger[0]] });
  assert.ok(
    compareSnapshots(fakeSnapshot(), ledgerDrift)
      .some(failure => failure.includes('migration ledger'))
  );
});

test('row digest: 64-bit access_revision values stay exact', () => {
  const fields = ['access_revision'];
  const digestA = rowDigest({ access_revision: '9007199254740993' }, fields);
  const digestB = rowDigest({ access_revision: '9007199254740992' }, fields);
  const digestNumeric = rowDigest({ access_revision: 9007199254740992 }, fields);

  assert.notEqual(digestA, digestB);
  // A float64 cannot distinguish ...993 from ...992; the string form must.
  assert.equal(digestB, digestNumeric);
  assert.notEqual(digestA, digestNumeric);
});

test('manifest never carries raw secret material', () => {
  const manifest = buildManifest({
    snapshot: fakeSnapshot(),
    source: { host: '127.0.0.1', port: 5432, database: 'quickshare_test' },
    dump: { file: 'quickshare-backup.dump', sha256: 'abc', bytes: 123 },
    restorePoint: { backedUpAt: 1, auditHighWaterId: null, auditHighWaterCreatedAt: null },
    backupDurationMs: 10,
    createdAt: 2
  });
  const serialized = JSON.stringify(manifest);

  assert.equal(manifest.containsSecrets, false);
  assert.ok(!serialized.includes('scrypt$secret-hash-value'));
  assert.ok(!serialized.includes('v1.encrypted-value'));
});
