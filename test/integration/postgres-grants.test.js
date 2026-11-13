const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { hashSecret } = require('../../utils/security');

// Per-Share grants against real Postgres (T12, issue #36). The
// guarantees that matter here rest on transaction row locks and the
// fixed lock order (publishing gate, then the Key row, then the Share
// row), so concurrency is proven with independent pooled connections:
// grant racing revoke, grant racing Key deletion, and two owners'
// operations interleaving on the same (Key, Share) pair must leave
// exactly one consistent grant state — never a half-written row and
// never an authorization that outlives its Key or Share.
//
// This file uses its own `quickshare_grants_test` database, created
// and dropped by the file itself.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.replace(/^\//, '');
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

const GRANTS_DB = 'quickshare_grants_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const grantsUrl = serverBaseUrl(GRANTS_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

let adminPool;
let repositoryA;
let repositoryB;

function secondRepository() {
  const repository = Object.create(PostgresPageRepository.prototype);
  repository.pool = repositoryB.pool;
  return repository;
}

async function resetState() {
  await repositoryA.pool.query('DELETE FROM public.share_grants');
  await repositoryA.pool.query('DELETE FROM public.pages');
  await repositoryA.pool.query('DELETE FROM public.audit_logs');
  await repositoryA.pool.query('DELETE FROM public.api_keys');
  await repositoryA.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

async function seedKey(id, scopes = ['share:create']) {
  await repositoryA.createApiKey({
    id,
    name: `Key ${id}`,
    keyHash: await hashSecret(`secret-${id}`),
    keyPrefix: `qs.${id.slice(0, 8)}…`,
    createdAt: Date.now()
  });

  if (scopes) {
    await repositoryA.updateApiKeyScopes(id, scopes);
  }
}

async function seedShare(id, createdAt = Date.now()) {
  await repositoryA.create({
    id,
    htmlContent: `<h1>body-${id}</h1>`,
    createdAt,
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: `title-${id}`,
    description: `description-${id}`,
    expiresAt: null,
    markdownTheme: null
  });
}

const READ = { read: true, update: false, publish: false };

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${GRANTS_DB}`);
  await adminPool.query(`CREATE DATABASE ${GRANTS_DB}`);

  repositoryA = new PostgresPageRepository(grantsUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  repositoryB = new PostgresPageRepository(grantsUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  await runMigrations(repositoryA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repositoryA.pool.end();
  await repositoryB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${GRANTS_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('migration 010 migrates existing Keys to create-only and defaults the auto-edit opt-in off', async () => {
  const ledger = await repositoryA.pool.query(
    'SELECT version FROM public.quickshare_schema_migrations ORDER BY version'
  );
  assert.deepEqual(
    ledger.rows.map(row => row.version),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']
  );

  await seedKey('pg-migrated-key', null);
  const row = await repositoryA.getApiKeyById('pg-migrated-key');
  assert.deepEqual(JSON.parse(row.scopes), ['share:create']);
  assert.equal(row.auto_grant_new_share_edit, false);
});

test('grant, read-back and revoke round-trip through the repository', async () => {
  await seedKey('pg-basic-key', ['share:create', 'share:read']);
  await seedShare('pg-basic-share');

  const granted = await repositoryA.grantShareAccess({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share', permissions: READ
  });
  assert.equal(granted.status, 'ok');
  assert.equal(granted.created, true);
  assert.deepEqual(granted.grant.permissions, READ);

  const content = await repositoryA.getGrantedShareContent({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share'
  });
  assert.equal(content.snapshot.htmlContent, '<h1>body-pg-basic-share</h1>');
  assert.equal(content.currentRevision, '1');

  const state = await repositoryA.getGrantedShareState({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share'
  });
  assert.deepEqual(state.share, {
    id: 'pg-basic-share',
    published: true,
    isProtected: false,
    expiresAt: null,
    accessRevision: '1'
  });
  assert.ok(!('title' in state.share));

  const updated = await repositoryA.grantShareAccess({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share',
    permissions: { read: false, update: false, publish: true }
  });
  assert.equal(updated.created, false);
  assert.deepEqual(updated.grant.permissions, { read: false, update: false, publish: true });
  assert.equal(updated.grant.createdAt, granted.grant.createdAt);

  const revoked = await repositoryA.revokeShareAccess({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share'
  });
  assert.equal(revoked.status, 'ok');
  assert.equal(await repositoryA.getShareGrant('pg-basic-key', 'pg-basic-share'), null);
  assert.equal(
    await repositoryA.getGrantedShareContent({ keyId: 'pg-basic-key', shareId: 'pg-basic-share' }),
    null
  );

  const revokeAgain = await repositoryA.revokeShareAccess({
    keyId: 'pg-basic-key', shareId: 'pg-basic-share'
  });
  assert.equal(revokeAgain.status, 'grant_not_found');

  assert.equal(
    (await repositoryA.grantShareAccess({ keyId: 'ghost', shareId: 'pg-basic-share', permissions: READ })).status,
    'key_not_found'
  );
  assert.equal(
    (await repositoryA.grantShareAccess({ keyId: 'pg-basic-key', shareId: 'ghost', permissions: READ })).status,
    'share_not_found'
  );
});

test('grants survive rotation and scope edits; cross-Key isolation holds at the database level', async () => {
  await seedKey('pg-rotate-key', ['share:read']);
  await seedKey('pg-other-key', ['share:read']);
  await seedShare('pg-rotate-share');

  await repositoryA.grantShareAccess({
    keyId: 'pg-rotate-key', shareId: 'pg-rotate-share', permissions: READ
  });

  const rotated = await repositoryA.rotateApiKey('pg-rotate-key', {
    keyHash: await hashSecret('rotated-secret'),
    keyPrefix: 'qs.pg-rotat…'
  });
  assert.equal(rotated.credential_version, '2');
  assert.deepEqual(JSON.parse(rotated.scopes), ['share:read']);

  const grant = await repositoryA.getShareGrant('pg-rotate-key', 'pg-rotate-share');
  assert.deepEqual(grant.permissions, READ);

  const list = await repositoryA.listGrantedShares({ keyId: 'pg-rotate-key', limit: 20 });
  assert.deepEqual(list.shares.map(share => share.id), ['pg-rotate-share']);

  const otherList = await repositoryA.listGrantedShares({ keyId: 'pg-other-key', limit: 20 });
  assert.deepEqual(otherList.shares, []);
  assert.equal(
    await repositoryA.getGrantedShareState({ keyId: 'pg-other-key', shareId: 'pg-rotate-share' }),
    null
  );
});

test('concurrent grant and revoke from two connections settle into exactly one state', async () => {
  await seedKey('pg-race-key', ['share:read']);
  await seedShare('pg-race-share');
  const other = secondRepository();

  for (let round = 0; round < 8; round += 1) {
    const [grantResult, revokeResult] = await Promise.allSettled([
      repositoryA.grantShareAccess({ keyId: 'pg-race-key', shareId: 'pg-race-share', permissions: READ }),
      other.revokeShareAccess({ keyId: 'pg-race-key', shareId: 'pg-race-share' })
    ]);

    assert.equal(grantResult.status, 'fulfilled', `round ${round}: grant must not fail`);
    assert.equal(revokeResult.status, 'fulfilled', `round ${round}: revoke must not fail`);

    // Whichever committed second defines the final state; both are
    // legitimate, a torn or duplicated row is not.
    const rows = await repositoryA.pool.query(
      'SELECT can_read FROM public.share_grants WHERE api_key_id = $1 AND share_id = $2',
      ['pg-race-key', 'pg-race-share']
    );
    assert.ok(rows.rows.length <= 1, `round ${round}: at most one grant row`);

    const grant = await repositoryA.getShareGrant('pg-race-key', 'pg-race-share');
    if (grant) {
      assert.deepEqual(grant.permissions, READ);
    }
  }
});

test('grant racing Key deletion never leaves a grant for a dead Key', async () => {
  const other = secondRepository();

  for (let round = 0; round < 6; round += 1) {
    const keyId = `pg-race-del-key-${round}`;
    await seedKey(keyId, ['share:read']);
    await seedShare(`pg-race-del-share-${round}`);

    const [grantResult, deleteResult] = await Promise.allSettled([
      repositoryA.grantShareAccess({ keyId, shareId: `pg-race-del-share-${round}`, permissions: READ }),
      other.deleteApiKey(keyId)
    ]);

    assert.equal(deleteResult.status, 'fulfilled', `round ${round}`);

    const orphanRows = await repositoryA.pool.query(
      'SELECT COUNT(*)::int AS count FROM public.share_grants WHERE api_key_id = $1',
      [keyId]
    );
    assert.equal(orphanRows.rows[0].count, 0, `round ${round}: no grant may outlive its Key`);

    const keyRow = await repositoryA.getApiKeyById(keyId);
    assert.equal(keyRow, null, `round ${round}: the Key itself is gone`);

    if (grantResult.status === 'fulfilled') {
      assert.ok(['ok', 'key_not_found'].includes(grantResult.value.status));
    }
  }
});

test('grant racing Share deletion never leaves a grant for a dead Share', async () => {
  const other = secondRepository();
  await seedKey('pg-race-del-share-key', ['share:read']);

  for (let round = 0; round < 6; round += 1) {
    const shareId = `pg-race-del-target-${round}`;
    await seedShare(shareId);

    const [grantResult, deleteResult] = await Promise.allSettled([
      repositoryA.grantShareAccess({ keyId: 'pg-race-del-share-key', shareId, permissions: READ }),
      other.deletePage(shareId)
    ]);

    assert.equal(deleteResult.status, 'fulfilled', `round ${round}`);
    assert.equal(deleteResult.value, true, `round ${round}: the Share is deleted`);

    const orphanRows = await repositoryA.pool.query(
      'SELECT COUNT(*)::int AS count FROM public.share_grants WHERE share_id = $1',
      [shareId]
    );
    assert.equal(orphanRows.rows[0].count, 0, `round ${round}: no grant may outlive its Share`);

    if (grantResult.status === 'fulfilled') {
      assert.ok(['ok', 'share_not_found'].includes(grantResult.value.status));
    }
  }
});

test('deleting a Share from a second connection removes its grants atomically', async () => {
  await seedKey('pg-del-share-key', ['share:read']);
  await seedShare('pg-del-share');
  await repositoryA.grantShareAccess({
    keyId: 'pg-del-share-key', shareId: 'pg-del-share', permissions: READ
  });

  const other = secondRepository();
  await other.deletePage('pg-del-share');

  assert.equal(await repositoryA.getShareGrant('pg-del-share-key', 'pg-del-share'), null);
  const list = await repositoryA.listGrantedShares({ keyId: 'pg-del-share-key', limit: 20 });
  assert.deepEqual(list.shares, []);
});

test('cursor pagination over same-timestamp mixed-case IDs loses and repeats nothing', async () => {
  await seedKey('pg-page-key', ['share:read']);
  const createdAt = 1760000000000;
  const ids = ['pgDelta', 'Pgalpha', 'pgcharlie', 'PgBravo', 'pgecho', 'PGfoxtrot', 'pgGolf'];

  for (const id of ids) {
    await seedShare(id, createdAt);
    await repositoryA.grantShareAccess({ keyId: 'pg-page-key', shareId: id, permissions: READ });
  }

  const expectedOrder = [...ids].sort((a, b) => (a < b ? -1 : 1));
  const seen = [];
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const result = await repositoryA.listGrantedShares({ keyId: 'pg-page-key', limit: 3, cursor });
    seen.push(...result.shares.map(share => share.id));
    cursor = result.nextPosition
      ? { createdAt: result.nextPosition.createdAt, id: result.nextPosition.id }
      : null;

    if (!cursor) {
      break;
    }
  }

  assert.deepEqual(seen, expectedOrder);
  assert.equal(cursor, null);

  // A second Key granted a subset sees only its own subset, in order.
  await seedKey('pg-page-key-2', ['share:read']);
  await repositoryA.grantShareAccess({ keyId: 'pg-page-key-2', shareId: 'Pgalpha', permissions: READ });
  await repositoryA.grantShareAccess({ keyId: 'pg-page-key-2', shareId: 'pgGolf', permissions: READ });
  const subset = await repositoryA.listGrantedShares({ keyId: 'pg-page-key-2', limit: 20 });
  assert.deepEqual(subset.shares.map(share => share.id), ['Pgalpha', 'pgGolf']);
});
