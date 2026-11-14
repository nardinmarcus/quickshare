const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { hashSecret } = require('../../utils/security');
const { computeRequestHmac } = require('../../utils/idempotency');
const { isApiKeyCredentialChangedError } = require('../../utils/apiKeyIdentity');

// Granted content update against real Postgres (T13, issue #37). The
// guarantees that matter rest on the transaction discipline shared
// with the dashboard save: the fixed lock order (publishing gate, Key
// row, operation lock, Share row), credential-version and grant
// re-verification BEFORE replay or precondition judgment, and the
// auto-edit grant written inside the create transaction — so
// concurrency is proven with independent pooled connections, and the
// rollback case proves a failed auto-grant leaves no Share, no
// operation record and no partial grant behind.
//
// This file uses its own `quickshare_update_grants_test` database,
// created and dropped by the file itself.

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

const UPDATE_DB = 'quickshare_update_grants_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const updateUrl = serverBaseUrl(UPDATE_DB);

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

async function resetState() {
  await repositoryA.pool.query('DELETE FROM public.share_grants');
  await repositoryA.pool.query('DELETE FROM public.publish_operations');
  await repositoryA.pool.query('DELETE FROM public.share_revisions');
  await repositoryA.pool.query('DELETE FROM public.pages');
  await repositoryA.pool.query('DELETE FROM public.audit_logs');
  await repositoryA.pool.query('DELETE FROM public.api_keys');
  await repositoryA.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

async function seedKey(id, { scopes = ['share:create'], autoGrant = false } = {}) {
  await repositoryA.createApiKey({
    id,
    name: `Key ${id}`,
    keyHash: await hashSecret(`secret-${id}`),
    keyPrefix: `qs.${id.slice(0, 8)}…`,
    createdAt: Date.now(),
    scopes,
    autoGrantNewShareEdit: autoGrant
  });
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

const EDIT = { read: true, update: true, publish: false };
const FULL_SCOPES = ['share:create', 'share:read', 'share:update'];

function credentialFor(keyId, credentialVersion = '1') {
  return {
    type: 'managed',
    keyId,
    name: `Key ${keyId}`,
    credentialVersion,
    scopes: [...FULL_SCOPES]
  };
}

function digestFor({ shareId, htmlContent, expectedRevision }) {
  return computeRequestHmac({
    action: 'share.content.update',
    targetId: shareId,
    presence: {
      htmlContent: 1,
      title: 1,
      description: 1,
      markdownTheme: 0,
      codeType: 0,
      expectedContentRevision: 1
    },
    values: {
      htmlContent,
      title: `title-${shareId}`,
      description: `description-${shareId}`,
      markdownTheme: null,
      codeType: null,
      expectedContentRevision: expectedRevision
    }
  });
}

// One Key-authenticated content update through the shared repository
// transaction, shaped exactly like the v1 route's call.
function saveAsKey(repository, { keyId, shareId, requestId, htmlContent, expectedRevision = '1', credentialVersion = '1' }) {
  return repository.saveContentIdempotent({
    id: shareId,
    options: {
      htmlContent,
      title: `title-${shareId}`,
      description: `description-${shareId}`,
      markdownTheme: null
    },
    precondition: {
      expectedAccessRevision: null,
      accessPreconditionMissing: false,
      advanceAccessRevision: false,
      expectedContentRevision: expectedRevision,
      contentPreconditionMissing: false,
      contentPreconditionInvalid: false,
      contentMeta: { source: 'api-update', actorType: 'api_key', actorId: keyId },
      ip: null
    },
    operation: {
      actorNamespace: `key:managed:${keyId}`,
      requestId,
      action: 'share.content.update',
      targetId: shareId,
      requestHmac: digestFor({ shareId, htmlContent, expectedRevision })
    },
    apiCredential: credentialFor(keyId, credentialVersion),
    grantCheck: { keyId, permission: 'update' }
  });
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${UPDATE_DB}`);
  await adminPool.query(`CREATE DATABASE ${UPDATE_DB}`);

  repositoryA = new PostgresPageRepository(updateUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  repositoryB = new PostgresPageRepository(updateUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  await runMigrations(repositoryA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repositoryA.pool.end();
  await repositoryB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${UPDATE_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('granted update commits through the shared transaction and replays by identifier', async () => {
  await seedKey('pg-upd-key', { scopes: FULL_SCOPES });
  await seedShare('pg-upd-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-upd-key', shareId: 'pg-upd-share', permissions: EDIT });

  const saved = await saveAsKey(repositoryA, {
    keyId: 'pg-upd-key',
    shareId: 'pg-upd-share',
    requestId: 'pg-upd-request-0001',
    htmlContent: '<p>updated by key</p>'
  });
  assert.equal(saved.outcome, 'executed');
  assert.equal(saved.result.status, 'updated');
  assert.equal(saved.result.contentChanged, true);
  assert.equal(saved.result.contentRevision, '2');

  const snapshot = await repositoryA.getContentSnapshot('pg-upd-share', '2');
  assert.equal(snapshot.html_content, '<p>updated by key</p>');
  assert.equal(snapshot.source, 'api-update');
  assert.equal(snapshot.actor_type, 'api_key');
  assert.equal(snapshot.actor_id, 'pg-upd-key');

  // The committed operation is confirmable in the Key's namespace.
  const record = await repositoryA.getOperation('key:managed:pg-upd-key', 'pg-upd-request-0001');
  assert.equal(record.action, 'share.content.update');
  assert.equal(record.resultRevision, '2');

  // An exact retry replays the committed result instead of writing
  // a second Revision, even though its If-Match is now stale.
  const replay = await saveAsKey(repositoryB, {
    keyId: 'pg-upd-key',
    shareId: 'pg-upd-share',
    requestId: 'pg-upd-request-0001',
    htmlContent: '<p>updated by key</p>'
  });
  assert.equal(replay.outcome, 'replayed');

  const revisions = await repositoryA.listContentSnapshots('pg-upd-share');
  assert.equal(revisions.length, 2);

  // A Key without the grant is refused by the in-transaction check —
  // indistinguishable from an unknown Share at the route.
  await seedKey('pg-upd-stranger', { scopes: FULL_SCOPES });
  const refused = await saveAsKey(repositoryA, {
    keyId: 'pg-upd-stranger',
    shareId: 'pg-upd-share',
    requestId: 'pg-upd-request-0002',
    htmlContent: '<p>stranger write</p>',
    expectedRevision: '2'
  });
  assert.equal(refused.outcome, 'executed');
  assert.equal(refused.result.status, 'grant_not_found');
});

test('two connections on one baseline: exactly one update commits', async () => {
  await seedKey('pg-race-key-a', { scopes: FULL_SCOPES });
  await seedKey('pg-race-key-b', { scopes: FULL_SCOPES });
  await seedShare('pg-race-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-race-key-a', shareId: 'pg-race-share', permissions: EDIT });
  await repositoryA.grantShareAccess({ keyId: 'pg-race-key-b', shareId: 'pg-race-share', permissions: EDIT });

  const [first, second] = await Promise.all([
    saveAsKey(repositoryA, {
      keyId: 'pg-race-key-a', shareId: 'pg-race-share',
      requestId: 'pg-race-request-a', htmlContent: '<p>writer A</p>'
    }),
    saveAsKey(repositoryB, {
      keyId: 'pg-race-key-b', shareId: 'pg-race-share',
      requestId: 'pg-race-request-b', htmlContent: '<p>writer B</p>'
    })
  ]);

  const statuses = [first.result.status, second.result.status].sort();
  assert.deepEqual(statuses, ['content_conflict', 'updated']);

  const page = await repositoryA.getById('pg-race-share');
  assert.equal(String(page.current_revision), '2');
  const revisions = await repositoryA.listContentSnapshots('pg-race-share');
  assert.equal(revisions.length, 2);
});

test('dashboard save and API update on one baseline: exactly one wins', async () => {
  await seedKey('pg-mix-key', { scopes: FULL_SCOPES });
  await seedShare('pg-mix-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-mix-key', shareId: 'pg-mix-share', permissions: EDIT });

  const dashboardSave = repositoryB.saveContentIdempotent({
    id: 'pg-mix-share',
    options: { htmlContent: '<p>dashboard writer</p>' },
    precondition: {
      expectedAccessRevision: null,
      advanceAccessRevision: false,
      expectedContentRevision: '1',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: null
    },
    operation: {
      actorNamespace: 'dashboard:owner',
      requestId: 'pg-mix-dashboard-0001',
      action: 'share.content.update',
      targetId: 'pg-mix-share',
      requestHmac: digestFor({ shareId: 'pg-mix-share', htmlContent: '<p>dashboard writer</p>', expectedRevision: '1' })
    }
  });

  const apiSave = saveAsKey(repositoryA, {
    keyId: 'pg-mix-key', shareId: 'pg-mix-share',
    requestId: 'pg-mix-api-0001', htmlContent: '<p>api writer</p>'
  });

  const [dashboardOutcome, apiOutcome] = await Promise.all([dashboardSave, apiSave]);
  const statuses = [dashboardOutcome.result.status, apiOutcome.result.status].sort();
  assert.deepEqual(statuses, ['content_conflict', 'updated']);

  const page = await repositoryA.getById('pg-mix-share');
  assert.equal(String(page.current_revision), '2');
});

test('a revocation that commits first refuses the in-flight write — and its replay', async () => {
  await seedKey('pg-revoke-key', { scopes: FULL_SCOPES });
  await seedShare('pg-revoke-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share', permissions: EDIT });

  const committed = await saveAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', htmlContent: '<p>committed</p>'
  });
  assert.equal(committed.result.status, 'updated');

  await repositoryA.revokeShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share' });

  // A fresh write under a new identifier is refused by the grant
  // re-check and writes nothing: no Revision, no operation record.
  const refused = await saveAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0002', htmlContent: '<p>after revoke</p>',
    expectedRevision: '2'
  });
  assert.equal(refused.result.status, 'grant_not_found');
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-revoke-key', 'pg-revoke-request-0002'),
    null
  );

  // The earlier committed request cannot be replayed either: the
  // grant is re-verified before the replay is honored (parent spec
  // #24 §8 — a revoked Key cannot replay by requestId).
  const replay = await saveAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', htmlContent: '<p>committed</p>'
  });
  assert.equal(replay.outcome, 'executed');
  assert.equal(replay.result.status, 'grant_not_found');

  const revisions = await repositoryA.listContentSnapshots('pg-revoke-share');
  assert.equal(revisions.length, 2);
});

test('a rotation that commits first refuses the write with the stale credential version', async () => {
  await seedKey('pg-rotate-key', { scopes: FULL_SCOPES });
  await seedShare('pg-rotate-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-rotate-key', shareId: 'pg-rotate-share', permissions: EDIT });

  await repositoryA.rotateApiKey('pg-rotate-key', {
    keyHash: await hashSecret('rotated-secret'),
    keyPrefix: 'qs.pg-rotat…'
  });

  await assert.rejects(
    saveAsKey(repositoryA, {
      keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
      requestId: 'pg-rotate-request-0001', htmlContent: '<p>stale credential</p>',
      credentialVersion: '1'
    }),
    error => isApiKeyCredentialChangedError(error)
  );

  const revisions = await repositoryA.listContentSnapshots('pg-rotate-share');
  assert.equal(revisions.length, 1);

  // The current credential version writes fine, and the grant —
  // keyed by the logical Key ID — survived the rotation.
  const saved = await saveAsKey(repositoryA, {
    keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
    requestId: 'pg-rotate-request-0002', htmlContent: '<p>current credential</p>',
    credentialVersion: '2'
  });
  assert.equal(saved.result.status, 'updated');
});

test('revoke racing update across connections never leaves a half-committed write', async () => {
  await seedKey('pg-duel-key', { scopes: FULL_SCOPES });
  await seedShare('pg-duel-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-duel-key', shareId: 'pg-duel-share', permissions: EDIT });

  for (let round = 0; round < 6; round += 1) {
    const shareId = `pg-duel-share-${round}`;
    // eslint-disable-next-line no-await-in-loop
    await seedShare(shareId);
    // eslint-disable-next-line no-await-in-loop
    await repositoryA.grantShareAccess({ keyId: 'pg-duel-key', shareId, permissions: EDIT });

    const [saveOutcome] = await Promise.all([
      saveAsKey(repositoryA, {
        keyId: 'pg-duel-key', shareId,
        requestId: `pg-duel-request-${round}`, htmlContent: `<p>round ${round}</p>`
      }).then(outcome => ({ outcome }), error => ({ error })),
      repositoryB.revokeShareAccess({ keyId: 'pg-duel-key', shareId })
    ]);

    // Whichever committed first decides: either the update landed
    // completely (Revision 2 + operation record) before the grant
    // went away, or it was refused whole. Never anything in between.
    // eslint-disable-next-line no-await-in-loop
    const page = await repositoryA.getById(shareId);
    // eslint-disable-next-line no-await-in-loop
    const record = await repositoryA.getOperation('key:managed:pg-duel-key', `pg-duel-request-${round}`);

    if (saveOutcome.outcome?.result?.status === 'updated') {
      assert.equal(String(page.current_revision), '2', `round ${round}: committed update must be whole`);
      assert.ok(record, `round ${round}: committed update must carry its operation record`);
    } else {
      assert.equal(saveOutcome.outcome?.result?.status, 'grant_not_found');
      assert.equal(String(page.current_revision), '1', `round ${round}: refused update must write nothing`);
      assert.equal(record, null);
    }

    // eslint-disable-next-line no-await-in-loop
    assert.equal(await repositoryA.getShareGrant('pg-duel-key', shareId), null);
  }
});

test('auto-edit grants land inside the create transaction, once, for both create paths', async () => {
  await seedKey('pg-auto-key', { scopes: FULL_SCOPES, autoGrant: true });
  const credential = credentialFor('pg-auto-key');

  const created = await repositoryA.createIdempotent({
    operation: {
      actorNamespace: 'key:managed:pg-auto-key',
      requestId: 'pg-auto-create-0001',
      action: 'share.create',
      targetId: null,
      requestHmac: 'a'.repeat(64)
    },
    apiCredential: credential,
    revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-auto-key' },
    prepare: async () => ({
      page: {
        id: 'pg-auto-share-1',
        htmlContent: '<p>auto one</p>',
        passwordHash: null,
        encryptedPassword: null,
        isProtected: false,
        codeType: 'html',
        title: 'Auto one',
        description: null,
        createdAt: Date.now(),
        expiresAt: null,
        markdownTheme: null
      },
      result: { kind: 'share.create', shareId: 'pg-auto-share-1' }
    })
  });
  assert.equal(created.outcome, 'created');

  const grant = await repositoryA.getShareGrant('pg-auto-key', 'pg-auto-share-1');
  assert.deepEqual(grant.permissions, EDIT);

  // A replayed create mints no second grant.
  const replay = await repositoryA.createIdempotent({
    operation: {
      actorNamespace: 'key:managed:pg-auto-key',
      requestId: 'pg-auto-create-0001',
      action: 'share.create',
      targetId: null,
      requestHmac: 'a'.repeat(64)
    },
    apiCredential: credential,
    revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-auto-key' },
    prepare: async () => {
      throw new Error('prepare must not run for a replay');
    }
  });
  assert.equal(replay.outcome, 'replayed');
  const grants = await repositoryA.listShareGrants('pg-auto-key');
  assert.equal(grants.filter(entry => entry.shareId === 'pg-auto-share-1').length, 1);

  // The plain (non-idempotent) create path grants in its transaction
  // too.
  await repositoryA.create({
    id: 'pg-auto-share-2',
    htmlContent: '<p>auto two</p>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Auto two',
    description: null,
    expiresAt: null,
    markdownTheme: null
  }, { apiCredential: credential, revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-auto-key' } });
  assert.deepEqual(
    (await repositoryA.getShareGrant('pg-auto-key', 'pg-auto-share-2')).permissions,
    EDIT
  );
});

test('an auto-grant failure rolls the whole create back', async () => {
  await seedKey('pg-rollback-key', { scopes: FULL_SCOPES, autoGrant: true });

  // An orphaned grant row for the ID the create will mint: the
  // auto-grant INSERT collides with it, which must abort the entire
  // create — no Share row, no snapshot, no operation record.
  await repositoryA.pool.query(
    `INSERT INTO public.share_grants (api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at)
     VALUES ('pg-rollback-key', 'pg-rollback-share', FALSE, FALSE, TRUE, 1000, 1000)`
  );

  await assert.rejects(
    repositoryA.createIdempotent({
      operation: {
        actorNamespace: 'key:managed:pg-rollback-key',
        requestId: 'pg-rollback-create-0001',
        action: 'share.create',
        targetId: null,
        requestHmac: 'c'.repeat(64)
      },
      apiCredential: credentialFor('pg-rollback-key'),
      revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-rollback-key' },
      prepare: async () => ({
        page: {
          id: 'pg-rollback-share',
          htmlContent: '<p>must not survive</p>',
          passwordHash: null,
          encryptedPassword: null,
          isProtected: false,
          codeType: 'html',
          title: 'Rollback',
          description: null,
          createdAt: Date.now(),
          expiresAt: null,
          markdownTheme: null
        },
        result: { kind: 'share.create', shareId: 'pg-rollback-share' }
      })
    })
  );

  assert.equal(await repositoryA.getById('pg-rollback-share'), null);
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-rollback-key', 'pg-rollback-create-0001'),
    null
  );
  const snapshots = await repositoryA.pool.query(
    'SELECT COUNT(*)::int AS count FROM public.share_revisions WHERE share_id = $1',
    ['pg-rollback-share']
  );
  assert.equal(snapshots.rows[0].count, 0);

  // The pre-existing grant row is untouched by the aborted create.
  const orphan = await repositoryA.pool.query(
    'SELECT can_read, can_update, can_publish FROM public.share_grants WHERE api_key_id = $1 AND share_id = $2',
    ['pg-rollback-key', 'pg-rollback-share']
  );
  assert.deepEqual(orphan.rows, [{ can_read: false, can_update: false, can_publish: true }]);
});

test('opt-in is never retroactive and the toggle reports the stored flag', async () => {
  await seedKey('pg-late-key', { scopes: FULL_SCOPES, autoGrant: false });
  const credential = credentialFor('pg-late-key');

  await repositoryA.create({
    id: 'pg-late-share-1',
    htmlContent: '<p>before opt-in</p>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Before',
    description: null,
    expiresAt: null,
    markdownTheme: null
  }, { apiCredential: credential });
  assert.equal(await repositoryA.getShareGrant('pg-late-key', 'pg-late-share-1'), null);

  const toggled = await repositoryA.updateApiKeyAutoGrant('pg-late-key', true);
  assert.equal(toggled.auto_grant_new_share_edit, true);
  assert.equal(await repositoryA.updateApiKeyAutoGrant('no-such-key', true), null);

  // The earlier Share stays ungranted; only new creations are covered.
  assert.equal(await repositoryA.getShareGrant('pg-late-key', 'pg-late-share-1'), null);

  await repositoryA.create({
    id: 'pg-late-share-2',
    htmlContent: '<p>after opt-in</p>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'After',
    description: null,
    expiresAt: null,
    markdownTheme: null
  }, { apiCredential: credential });
  assert.deepEqual(
    (await repositoryA.getShareGrant('pg-late-key', 'pg-late-share-2')).permissions,
    EDIT
  );
});
