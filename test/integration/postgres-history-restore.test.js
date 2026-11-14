const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { hashSecret } = require('../../utils/security');
const { computeRequestHmac, isIdempotencyConflictError } = require('../../utils/idempotency');
const { isApiKeyCredentialChangedError } = require('../../utils/apiKeyIdentity');

// Granted history reads and conditional restore against real Postgres
// (T14, issue #38). The guarantees that matter rest on the transaction
// discipline the restore shares with the dashboard: fixed lock order
// (publishing gate, Key row, operation lock, Share row), credential
// and grant re-verification BEFORE replay or precondition judgment,
// and the purge/restore interaction serialized by the Share row lock
// — so concurrency is proven with independent pooled connections, and
// every purge in this file goes through the repository's real purge
// operation, never a hand-written tombstone.
//
// This file uses its own `quickshare_history_restore_test` database,
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

const HISTORY_DB = 'quickshare_history_restore_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const historyUrl = serverBaseUrl(HISTORY_DB);

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
    htmlContent: `<h1>body-v1-${id}</h1>`,
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

// One owner content edit at repository level, shaped like the
// dashboard save's call (no operation record).
function editAsOwner(repository, { shareId, htmlContent, expectedRevision }) {
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
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: null
    }
  });
}

// Builds one Share with three Revisions; current is Revision 3.
async function threeRevisionShare(repository, id) {
  await seedShare(id);
  const v2 = await editAsOwner(repository, {
    shareId: id, htmlContent: `<h1>body-v2-${id}</h1>`, expectedRevision: '1'
  });
  assert.equal(v2.result.status, 'updated');
  const v3 = await editAsOwner(repository, {
    shareId: id, htmlContent: `<h1>body-v3-${id}</h1>`, expectedRevision: '2'
  });
  assert.equal(v3.result.status, 'updated');
}

function restoreDigestFor({ shareId, sourceRevision, expectedRevision }) {
  return computeRequestHmac({
    action: 'share.restore',
    targetId: shareId,
    presence: {
      sourceRevision: 1,
      expectedContentRevision: expectedRevision ? 1 : 0
    },
    values: {
      sourceRevision,
      expectedContentRevision: expectedRevision ?? null
    }
  });
}

// One Key-authenticated restore through the shared repository
// transaction, shaped exactly like the v1 route's call.
function restoreAsKey(repository, { keyId, shareId, requestId, sourceRevision, expectedRevision, credentialVersion = '1' }) {
  return repository.restoreRevision({
    id: shareId,
    sourceRevision,
    precondition: {
      expectedContentRevision: expectedRevision,
      contentPreconditionMissing: false,
      contentPreconditionInvalid: false,
      ip: null
    },
    operation: {
      actorNamespace: `key:managed:${keyId}`,
      requestId,
      action: 'share.restore',
      targetId: shareId,
      requestHmac: restoreDigestFor({ shareId, sourceRevision, expectedRevision })
    },
    apiCredential: credentialFor(keyId, credentialVersion),
    grantCheck: { keyId, permission: 'update' },
    restoreMeta: { source: 'api-restore', actorType: 'api_key', actorId: keyId }
  });
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${HISTORY_DB}`);
  await adminPool.query(`CREATE DATABASE ${HISTORY_DB}`);

  repositoryA = new PostgresPageRepository(historyUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  repositoryB = new PostgresPageRepository(historyUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  await runMigrations(repositoryA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repositoryA.pool.end();
  await repositoryB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${HISTORY_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('granted history reads return coherent pointer and metadata; ungranted keys see nothing', async () => {
  await seedKey('pg-hist-key', { scopes: FULL_SCOPES });
  await seedKey('pg-hist-other', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-hist-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-hist-key', shareId: 'pg-hist-share', permissions: READ });

  const list = await repositoryB.getGrantedShareRevisions({
    keyId: 'pg-hist-key', shareId: 'pg-hist-share', limit: 20, offset: 0
  });
  assert.equal(list.permissions.read, true);
  assert.equal(list.currentRevision, '3');
  assert.equal(list.total, 3);
  assert.deepEqual(list.revisions.map(entry => entry.revision), ['3', '2', '1']);
  // Metadata rows never carry the snapshot body.
  for (const entry of list.revisions) {
    assert.equal(entry.html_content, undefined);
    assert.equal(entry.purged_at, null);
  }

  const page2 = await repositoryB.getGrantedShareRevisions({
    keyId: 'pg-hist-key', shareId: 'pg-hist-share', limit: 2, offset: 2
  });
  assert.deepEqual(page2.revisions.map(entry => entry.revision), ['1']);
  assert.equal(page2.total, 3);
  assert.equal(page2.currentRevision, '3');

  const outOfRange = await repositoryB.getGrantedShareRevisions({
    keyId: 'pg-hist-key', shareId: 'pg-hist-share', limit: 20, offset: 50
  });
  assert.equal(outOfRange.total, 3);
  assert.deepEqual(outOfRange.revisions, []);

  const single = await repositoryB.getGrantedShareRevision({
    keyId: 'pg-hist-key', shareId: 'pg-hist-share', revision: '1'
  });
  assert.equal(single.currentRevision, '3');
  assert.equal(single.snapshot.html_content, '<h1>body-v1-pg-hist-share</h1>');
  assert.equal(single.snapshot.purged_at, null);

  const missing = await repositoryB.getGrantedShareRevision({
    keyId: 'pg-hist-key', shareId: 'pg-hist-share', revision: '99'
  });
  assert.equal(missing.snapshot, null);
  assert.equal(missing.currentRevision, '3');

  // Cross-Key isolation: no grant — no history, in either direction.
  assert.equal(await repositoryB.getGrantedShareRevisions({
    keyId: 'pg-hist-other', shareId: 'pg-hist-share', limit: 20, offset: 0
  }), null);
  assert.equal(await repositoryB.getGrantedShareRevision({
    keyId: 'pg-hist-other', shareId: 'pg-hist-share', revision: '1'
  }), null);
  assert.equal(await repositoryB.getGrantedShareRevisions({
    keyId: 'pg-hist-key', shareId: 'pg-no-such-share', limit: 20, offset: 0
  }), null);
});

test('API restore commits through the shared transaction: key namespace receipt, API provenance, no access drift', async () => {
  await seedKey('pg-restore-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-restore-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-restore-key', shareId: 'pg-restore-share', permissions: EDIT });

  const before = await repositoryA.getById('pg-restore-share');

  const restored = await restoreAsKey(repositoryB, {
    keyId: 'pg-restore-key', shareId: 'pg-restore-share',
    requestId: 'pg-restore-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(restored.outcome, 'executed');
  assert.equal(restored.result.status, 'updated');
  assert.equal(restored.result.contentChanged, true);
  assert.equal(restored.result.contentRevision, '4');
  assert.equal(restored.result.sourceRevision, '1');
  assert.equal(restored.result.previousRevision, '3');

  const snapshot = await repositoryA.getContentSnapshot('pg-restore-share', '4');
  assert.equal(snapshot.html_content, '<h1>body-v1-pg-restore-share</h1>');
  assert.equal(snapshot.source, 'api-restore');
  assert.equal(snapshot.actor_type, 'api_key');
  assert.equal(snapshot.actor_id, 'pg-restore-key');
  assert.equal(snapshot.restored_from_revision, '1');

  // The operation record lives in the Key's namespace — never in the
  // dashboard namespace.
  const record = await repositoryA.getOperation('key:managed:pg-restore-key', 'pg-restore-request-0001');
  assert.ok(record);
  assert.equal(record.action, 'share.restore');
  assert.equal(record.resultRevision, '4');
  assert.equal(
    await repositoryA.getOperation('session:dashboard-owner', 'pg-restore-request-0001'),
    null
  );

  const after = await repositoryA.getById('pg-restore-share');
  assert.equal(String(after.access_revision), String(before.access_revision));
  assert.equal(after.published, before.published);
});

test('response-loss replay across connections returns the committed restore; a different source under the same identifier conflicts', async () => {
  await seedKey('pg-replay-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-replay-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-replay-key', shareId: 'pg-replay-share', permissions: EDIT });

  const committed = await restoreAsKey(repositoryA, {
    keyId: 'pg-replay-key', shareId: 'pg-replay-share',
    requestId: 'pg-replay-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(committed.result.contentRevision, '4');

  // The retry arrives on another connection with the now-stale
  // baseline: replay resolution precedes precondition judgment.
  const replay = await restoreAsKey(repositoryB, {
    keyId: 'pg-replay-key', shareId: 'pg-replay-share',
    requestId: 'pg-replay-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.operation.resultRevision, '4');

  const snapshots = await repositoryA.listContentSnapshots('pg-replay-share');
  assert.equal(snapshots.length, 4);

  await assert.rejects(
    restoreAsKey(repositoryB, {
      keyId: 'pg-replay-key', shareId: 'pg-replay-share',
      requestId: 'pg-replay-request-0001', sourceRevision: '2', expectedRevision: '3'
    }),
    error => isIdempotencyConflictError(error)
  );
});

test('restore vs dashboard save on the same baseline: exactly one wins', async () => {
  await seedKey('pg-race-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-race-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-race-key', shareId: 'pg-race-share', permissions: EDIT });

  const [restoreOutcome, saveOutcome] = await Promise.all([
    restoreAsKey(repositoryA, {
      keyId: 'pg-race-key', shareId: 'pg-race-share',
      requestId: 'pg-race-request-0001', sourceRevision: '1', expectedRevision: '3'
    }),
    editAsOwner(repositoryB, {
      shareId: 'pg-race-share', htmlContent: '<h1>owner concurrent edit</h1>', expectedRevision: '3'
    })
  ]);

  const outcomes = [restoreOutcome.result.status, saveOutcome.result.status].sort();
  assert.deepEqual(outcomes, ['content_conflict', 'updated']);

  const page = await repositoryA.getById('pg-race-share');
  assert.equal(String(page.current_revision), '4');
  const snapshots = await repositoryA.listContentSnapshots('pg-race-share');
  assert.equal(snapshots.length, 4);
});

test('purge vs API restore of the same source: serialized whole-or-nothing, current payload always intact', async () => {
  await seedKey('pg-duel-key', { scopes: FULL_SCOPES });
  await repositoryA.grantShareAccess({ keyId: 'pg-duel-key', shareId: 'pg-duel-share', permissions: EDIT });

  for (let round = 0; round < 6; round += 1) {
    await resetState();
    await seedKey('pg-duel-key', { scopes: FULL_SCOPES });
    await threeRevisionShare(repositoryA, 'pg-duel-share');
    await repositoryA.grantShareAccess({ keyId: 'pg-duel-key', shareId: 'pg-duel-share', permissions: EDIT });

    const [purgeOutcome, restoreOutcome] = await Promise.all([
      repositoryA.purgeRevision({ id: 'pg-duel-share', revision: '1', ip: null }),
      restoreAsKey(repositoryB, {
        keyId: 'pg-duel-key', shareId: 'pg-duel-share',
        requestId: `pg-duel-request-${round}`, sourceRevision: '1', expectedRevision: '3'
      })
    ]);

    // The purge of a non-current version always lands exactly once.
    assert.equal(purgeOutcome.status, 'purged', `round ${round}`);

    // The restore either committed BEFORE the purge read the source
    // (its new Revision carries the v1 payload verbatim) or was
    // refused by it — never anything in between.
    if (restoreOutcome.result.status === 'updated') {
      assert.equal(restoreOutcome.result.contentRevision, '4', `round ${round}`);
      const restoredSnapshot = await repositoryA.getContentSnapshot('pg-duel-share', '4');
      assert.equal(restoredSnapshot.html_content, '<h1>body-v1-pg-duel-share</h1>', `round ${round}`);
    } else {
      assert.equal(restoreOutcome.result.status, 'source_unavailable', `round ${round}`);
    }

    // In every interleaving the source ends as a tombstone and the
    // CURRENT snapshot keeps its payload.
    const source = await repositoryA.getContentSnapshot('pg-duel-share', '1');
    assert.equal(source.html_content, null, `round ${round}`);
    assert.notEqual(source.purged_at, null, `round ${round}`);

    const page = await repositoryA.getById('pg-duel-share');
    const current = await repositoryA.getContentSnapshot('pg-duel-share', String(page.current_revision));
    assert.notEqual(current.html_content, null, `round ${round}`);
  }
});

test('restore from a source purged through the real purge operation is source_unavailable and records nothing', async () => {
  await seedKey('pg-purged-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-purged-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-purged-key', shareId: 'pg-purged-share', permissions: EDIT });

  const purged = await repositoryA.purgeRevision({ id: 'pg-purged-share', revision: '1', ip: null });
  assert.equal(purged.status, 'purged');

  const refused = await restoreAsKey(repositoryB, {
    keyId: 'pg-purged-key', shareId: 'pg-purged-share',
    requestId: 'pg-purged-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(refused.outcome, 'executed');
  assert.equal(refused.result.status, 'source_unavailable');
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-purged-key', 'pg-purged-request-0001'),
    null
  );

  const snapshots = await repositoryA.listContentSnapshots('pg-purged-share');
  assert.equal(snapshots.length, 3);
});

test('a revocation that commits first refuses the restore — and its replay', async () => {
  await seedKey('pg-revoke-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-revoke-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share', permissions: EDIT });

  const committed = await restoreAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(committed.result.status, 'updated');

  await repositoryA.revokeShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share' });

  const refused = await restoreAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0002', sourceRevision: '2', expectedRevision: '4'
  });
  assert.equal(refused.result.status, 'grant_not_found');
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-revoke-key', 'pg-revoke-request-0002'),
    null
  );

  // The earlier committed request cannot be replayed either: the
  // grant is re-verified before the replay is honored.
  const replay = await restoreAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', sourceRevision: '1', expectedRevision: '3'
  });
  assert.equal(replay.outcome, 'executed');
  assert.equal(replay.result.status, 'grant_not_found');

  const snapshots = await repositoryA.listContentSnapshots('pg-revoke-share');
  assert.equal(snapshots.length, 4);
});

test('a rotation that commits first refuses the restore with the stale credential version', async () => {
  await seedKey('pg-rotate-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-rotate-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-rotate-key', shareId: 'pg-rotate-share', permissions: EDIT });

  await repositoryA.rotateApiKey('pg-rotate-key', {
    keyHash: await hashSecret('rotated-secret'),
    keyPrefix: 'qs.pg-rotat…'
  });

  await assert.rejects(
    restoreAsKey(repositoryA, {
      keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
      requestId: 'pg-rotate-request-0001', sourceRevision: '1', expectedRevision: '3',
      credentialVersion: '1'
    }),
    error => isApiKeyCredentialChangedError(error)
  );

  const snapshots = await repositoryA.listContentSnapshots('pg-rotate-share');
  assert.equal(snapshots.length, 3);

  // The current credential version restores fine; the grant survived
  // the rotation because it is keyed by the logical Key ID.
  const restored = await restoreAsKey(repositoryA, {
    keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
    requestId: 'pg-rotate-request-0002', sourceRevision: '1', expectedRevision: '3',
    credentialVersion: '2'
  });
  assert.equal(restored.result.status, 'updated');
});

test('restoring the current content is a recorded no-op on Postgres', async () => {
  await seedKey('pg-noop-key', { scopes: FULL_SCOPES });
  await threeRevisionShare(repositoryA, 'pg-noop-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-noop-key', shareId: 'pg-noop-share', permissions: EDIT });

  const restored = await restoreAsKey(repositoryB, {
    keyId: 'pg-noop-key', shareId: 'pg-noop-share',
    requestId: 'pg-noop-request-0001', sourceRevision: '3', expectedRevision: '3'
  });
  assert.equal(restored.outcome, 'executed');
  assert.equal(restored.result.status, 'updated');
  assert.equal(restored.result.contentChanged, false);
  assert.equal(restored.result.contentRevision, '3');

  const snapshots = await repositoryA.listContentSnapshots('pg-noop-share');
  assert.equal(snapshots.length, 3);

  const record = await repositoryA.getOperation('key:managed:pg-noop-key', 'pg-noop-request-0001');
  assert.ok(record);
  assert.equal(record.resultRevision, '3');
});
