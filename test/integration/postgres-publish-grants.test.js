const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'postgres-publish-grants-test-secret';

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { hashSecret } = require('../../utils/security');
const { computeRequestHmac, dashboardNamespace } = require('../../utils/idempotency');
const { isApiKeyCredentialChangedError } = require('../../utils/apiKeyIdentity');

// Granted unpublish / republish against real Postgres (T15, issue
// #39). The guarantees that matter rest on the transaction discipline
// shared with the dashboard publish-state transition (T11): the fixed
// lock order (publishing gate, Key row, operation lock, Share row),
// credential-version and publish-grant re-verification BEFORE replay
// or precondition judgment, and the state flip + access-version
// advance + audit + operation record committing or rolling back
// together — so concurrency is proven with independent pooled
// connections, never with one connection pretending to race itself.
//
// This file uses its own `quickshare_publish_grants_test` database,
// created and dropped by the file itself.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.slice(1);
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

const PUBLISH_DB = 'quickshare_publish_grants_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const publishUrl = serverBaseUrl(PUBLISH_DB);

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

const PUBLISH_SCOPES = ['share:create', 'share:publish'];
const PUBLISH_GRANT = { read: false, update: false, publish: true };

async function seedKey(id, { scopes = PUBLISH_SCOPES } = {}) {
  await repositoryA.createApiKey({
    id,
    name: `Key ${id}`,
    keyHash: await hashSecret(`secret-${id}`),
    keyPrefix: `qs.${id.slice(0, 8)}…`,
    createdAt: Date.now(),
    scopes
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

function credentialFor(keyId, credentialVersion = '1') {
  return {
    type: 'managed',
    keyId,
    name: `Key ${keyId}`,
    credentialVersion,
    scopes: [...PUBLISH_SCOPES]
  };
}

function digestFor({ action, shareId, expectedAccessRevision }) {
  return computeRequestHmac({
    action,
    targetId: shareId,
    presence: {
      expectedAccessRevision: expectedAccessRevision != null ? 1 : 0
    },
    values: {
      expectedAccessRevision: expectedAccessRevision ?? null
    }
  });
}

// One Key-authenticated publish-state transition through the shared
// repository transaction, shaped exactly like the v1 route's call.
function publishAsKey(repository, { keyId, shareId, requestId, action, expectedAccessRevision = '1', credentialVersion = '1' }) {
  return repository.setPublishedState({
    id: shareId,
    published: action === 'share.republish',
    precondition: {
      expectedAccessRevision,
      accessPreconditionMissing: expectedAccessRevision == null
    },
    operation: {
      actorNamespace: `key:managed:${keyId}`,
      requestId,
      action,
      targetId: shareId,
      requestHmac: digestFor({ action, shareId, expectedAccessRevision })
    },
    apiCredential: credentialFor(keyId, credentialVersion),
    grantCheck: { keyId, permission: 'publish' },
    ip: '127.0.0.1'
  });
}

// The same transition from the dashboard namespace (T11's call shape).
function publishAsDashboard(repository, { shareId, requestId, published, expectedAccessRevision }) {
  const action = published ? 'share.republish' : 'share.unpublish';

  return repository.setPublishedState({
    id: shareId,
    published,
    precondition: {
      expectedAccessRevision,
      accessPreconditionMissing: expectedAccessRevision == null
    },
    operation: {
      actorNamespace: dashboardNamespace(),
      requestId,
      action,
      targetId: shareId,
      requestHmac: computeRequestHmac({
        action,
        targetId: shareId,
        presence: {
          published: 1,
          expectedAccessRevision: expectedAccessRevision != null ? 1 : 0
        },
        values: {
          published: published ? 'true' : 'false',
          expectedAccessRevision: expectedAccessRevision ?? null
        }
      })
    },
    ip: '127.0.0.1'
  });
}

async function publishAuditCount(id) {
  const result = await repositoryA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE action = 'page.publish.update' AND page_id = $1",
    [id]
  );
  return result.rows[0].count;
}

async function pageState(id) {
  const result = await repositoryA.pool.query(
    'SELECT published, access_revision::text AS access_revision FROM public.pages WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${PUBLISH_DB}`);
  await adminPool.query(`CREATE DATABASE ${PUBLISH_DB}`);

  repositoryA = new PostgresPageRepository(publishUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  repositoryB = new PostgresPageRepository(publishUrl, { ...env, POSTGRES_POOL_MAX: '4' });
  await runMigrations(repositoryA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repositoryA.pool.end();
  await repositoryB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${PUBLISH_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('granted unpublish commits state, version, audit and record together, and replays across connections', async () => {
  await seedKey('pg-pub-key');
  await seedShare('pg-pub-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-pub-key', shareId: 'pg-pub-share', permissions: PUBLISH_GRANT });

  const down = await publishAsKey(repositoryA, {
    keyId: 'pg-pub-key', shareId: 'pg-pub-share',
    requestId: 'pg-pub-request-0001', action: 'share.unpublish'
  });
  assert.equal(down.outcome, 'executed');
  assert.equal(down.result.status, 'updated');
  assert.equal(down.result.published, false);
  assert.equal(down.result.changed, true);
  assert.equal(down.result.accessRevision, '2');

  assert.deepEqual(await pageState('pg-pub-share'), { published: false, access_revision: '2' });
  assert.equal(await publishAuditCount('pg-pub-share'), 1);

  // The committed operation is confirmable in the Key's namespace,
  // carries the resulting access version and — the purge-safety
  // property — NO result content version: a state operation's record
  // is not tied to any Revision, so a later purge never scrubs it.
  const record = await repositoryA.getOperation('key:managed:pg-pub-key', 'pg-pub-request-0001');
  assert.equal(record.action, 'share.unpublish');
  assert.equal(record.resultState, 'committed');
  assert.equal(record.resultShareId, 'pg-pub-share');
  assert.equal(record.resultRevision, null);
  assert.equal(record.resultAccessRevision, '2');

  // An exact retry on the other connection replays the committed
  // result even though its baseline is now stale: no second flip, no
  // second audit, no second version advance.
  const replay = await publishAsKey(repositoryB, {
    keyId: 'pg-pub-key', shareId: 'pg-pub-share',
    requestId: 'pg-pub-request-0001', action: 'share.unpublish'
  });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.operation.action, 'share.unpublish');
  assert.deepEqual(await pageState('pg-pub-share'), { published: false, access_revision: '2' });
  assert.equal(await publishAuditCount('pg-pub-share'), 1);

  // Setting the state the Share already has is an unchanged success:
  // recorded, but no version advance and no audit.
  const unchanged = await publishAsKey(repositoryA, {
    keyId: 'pg-pub-key', shareId: 'pg-pub-share',
    requestId: 'pg-pub-request-0002', action: 'share.unpublish',
    expectedAccessRevision: '2'
  });
  assert.equal(unchanged.outcome, 'executed');
  assert.equal(unchanged.result.status, 'unchanged');
  assert.equal(unchanged.result.changed, false);
  assert.equal(unchanged.result.accessRevision, '2');
  assert.equal(await publishAuditCount('pg-pub-share'), 1);
  assert.ok(await repositoryA.getOperation('key:managed:pg-pub-key', 'pg-pub-request-0002'));

  // A Key without the publish grant is refused by the in-transaction
  // check — indistinguishable from an unknown Share at the route.
  await seedKey('pg-pub-stranger');
  const refused = await publishAsKey(repositoryA, {
    keyId: 'pg-pub-stranger', shareId: 'pg-pub-share',
    requestId: 'pg-pub-request-0003', action: 'share.republish',
    expectedAccessRevision: '2'
  });
  assert.equal(refused.outcome, 'executed');
  assert.equal(refused.result.status, 'grant_not_found');
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-pub-stranger', 'pg-pub-request-0003'),
    null
  );
});

test('two connections on one baseline: exactly one transition wins (Key vs Key and Key vs dashboard)', async () => {
  await seedKey('pg-race-key-a');
  await seedKey('pg-race-key-b');
  await seedShare('pg-race-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-race-key-a', shareId: 'pg-race-share', permissions: PUBLISH_GRANT });
  await repositoryA.grantShareAccess({ keyId: 'pg-race-key-b', shareId: 'pg-race-share', permissions: PUBLISH_GRANT });

  const [first, second] = await Promise.all([
    publishAsKey(repositoryA, {
      keyId: 'pg-race-key-a', shareId: 'pg-race-share',
      requestId: 'pg-race-request-a', action: 'share.unpublish'
    }),
    publishAsKey(repositoryB, {
      keyId: 'pg-race-key-b', shareId: 'pg-race-share',
      requestId: 'pg-race-request-b', action: 'share.unpublish'
    })
  ]);

  const statuses = [first.result.status, second.result.status].sort();
  assert.deepEqual(statuses, ['conflict', 'updated']);
  assert.deepEqual(await pageState('pg-race-share'), { published: false, access_revision: '2' });
  assert.equal(await publishAuditCount('pg-race-share'), 1);

  // Key vs dashboard on the republish baseline: also exactly one.
  const [dashboardOutcome, keyOutcome] = await Promise.all([
    publishAsDashboard(repositoryB, {
      shareId: 'pg-race-share', requestId: 'pg-race-dashboard-0001',
      published: true, expectedAccessRevision: '2'
    }),
    publishAsKey(repositoryA, {
      keyId: 'pg-race-key-a', shareId: 'pg-race-share',
      requestId: 'pg-race-request-c', action: 'share.republish',
      expectedAccessRevision: '2'
    })
  ]);

  const mixed = [dashboardOutcome.result.status, keyOutcome.result.status].sort();
  assert.deepEqual(mixed, ['conflict', 'updated']);
  assert.deepEqual(await pageState('pg-race-share'), { published: true, access_revision: '3' });
  assert.equal(await publishAuditCount('pg-race-share'), 2);
});

test('a revocation that commits first refuses the in-flight transition — and its replay', async () => {
  await seedKey('pg-revoke-key');
  await seedShare('pg-revoke-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share', permissions: PUBLISH_GRANT });

  const committed = await publishAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', action: 'share.unpublish'
  });
  assert.equal(committed.result.status, 'updated');

  await repositoryA.revokeShareAccess({ keyId: 'pg-revoke-key', shareId: 'pg-revoke-share' });

  // A fresh transition under a new identifier is refused whole: no
  // flip, no version advance, no operation record.
  const refused = await publishAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0002', action: 'share.republish',
    expectedAccessRevision: '2'
  });
  assert.equal(refused.result.status, 'grant_not_found');
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-revoke-key', 'pg-revoke-request-0002'),
    null
  );
  assert.deepEqual(await pageState('pg-revoke-share'), { published: false, access_revision: '2' });

  // The earlier committed request cannot be replayed either: the
  // grant is re-verified before the replay is honored (parent spec
  // #24 §8 — a revoked Key cannot replay by requestId).
  const replay = await publishAsKey(repositoryA, {
    keyId: 'pg-revoke-key', shareId: 'pg-revoke-share',
    requestId: 'pg-revoke-request-0001', action: 'share.unpublish'
  });
  assert.equal(replay.outcome, 'executed');
  assert.equal(replay.result.status, 'grant_not_found');
});

test('a rotation that commits first refuses the transition with the stale credential version', async () => {
  await seedKey('pg-rotate-key');
  await seedShare('pg-rotate-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-rotate-key', shareId: 'pg-rotate-share', permissions: PUBLISH_GRANT });

  await repositoryA.rotateApiKey('pg-rotate-key', {
    keyHash: await hashSecret('rotated-secret'),
    keyPrefix: 'qs.pg-rotat…'
  });

  await assert.rejects(
    publishAsKey(repositoryA, {
      keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
      requestId: 'pg-rotate-request-0001', action: 'share.unpublish',
      credentialVersion: '1'
    }),
    error => isApiKeyCredentialChangedError(error)
  );

  // Nothing was written under the stale credential.
  assert.deepEqual(await pageState('pg-rotate-share'), { published: true, access_revision: '1' });
  assert.equal(await publishAuditCount('pg-rotate-share'), 0);
  assert.equal(
    await repositoryA.getOperation('key:managed:pg-rotate-key', 'pg-rotate-request-0001'),
    null
  );

  // The current credential version transitions fine, and the grant —
  // keyed by the logical Key ID — survived the rotation.
  const saved = await publishAsKey(repositoryA, {
    keyId: 'pg-rotate-key', shareId: 'pg-rotate-share',
    requestId: 'pg-rotate-request-0002', action: 'share.unpublish',
    credentialVersion: '2'
  });
  assert.equal(saved.result.status, 'updated');
});

test('revoke racing publish across connections never leaves a half-committed transition', async () => {
  await seedKey('pg-duel-key');

  for (let round = 0; round < 6; round += 1) {
    const shareId = `pg-duel-share-${round}`;
    // eslint-disable-next-line no-await-in-loop
    await seedShare(shareId);
    // eslint-disable-next-line no-await-in-loop
    await repositoryA.grantShareAccess({ keyId: 'pg-duel-key', shareId, permissions: PUBLISH_GRANT });

    const [publishOutcome] = await Promise.all([
      publishAsKey(repositoryA, {
        keyId: 'pg-duel-key', shareId,
        requestId: `pg-duel-request-${round}`, action: 'share.unpublish'
      }).then(outcome => ({ outcome }), error => ({ error })),
      repositoryB.revokeShareAccess({ keyId: 'pg-duel-key', shareId })
    ]);

    // Whichever committed first decides: either the transition landed
    // completely (flip + version + audit + record) before the grant
    // went away, or it was refused whole. Never anything in between.
    // eslint-disable-next-line no-await-in-loop
    const state = await pageState(shareId);
    // eslint-disable-next-line no-await-in-loop
    const record = await repositoryA.getOperation('key:managed:pg-duel-key', `pg-duel-request-${round}`);
    // eslint-disable-next-line no-await-in-loop
    const audits = await publishAuditCount(shareId);

    if (publishOutcome.outcome?.result?.status === 'updated') {
      assert.deepEqual(state, { published: false, access_revision: '2' }, `round ${round}: committed transition must be whole`);
      assert.ok(record, `round ${round}: committed transition must carry its operation record`);
      assert.equal(audits, 1, `round ${round}: committed transition must carry its audit`);
    } else {
      assert.equal(publishOutcome.outcome?.result?.status, 'grant_not_found');
      assert.deepEqual(state, { published: true, access_revision: '1' }, `round ${round}: refused transition must write nothing`);
      assert.equal(record, null);
      assert.equal(audits, 0);
    }

    // eslint-disable-next-line no-await-in-loop
    assert.equal(await repositoryA.getShareGrant('pg-duel-key', shareId), null);
  }
});

test('an exact BIGINT access baseline advances exactly for a granted transition', async () => {
  await seedKey('pg-big-key');
  await seedShare('pg-big-share');
  await repositoryA.grantShareAccess({ keyId: 'pg-big-key', shareId: 'pg-big-share', permissions: PUBLISH_GRANT });
  await repositoryA.pool.query(
    'UPDATE public.pages SET access_revision = 9007199254740993 WHERE id = $1',
    ['pg-big-share']
  );

  const down = await publishAsKey(repositoryA, {
    keyId: 'pg-big-key', shareId: 'pg-big-share',
    requestId: 'pg-big-request-0001', action: 'share.unpublish',
    expectedAccessRevision: '9007199254740993'
  });
  assert.equal(down.result.status, 'updated');
  assert.equal(down.result.accessRevision, '9007199254740994');

  const record = await repositoryA.getOperation('key:managed:pg-big-key', 'pg-big-request-0001');
  assert.equal(record.resultAccessRevision, '9007199254740994');

  const state = await pageState('pg-big-share');
  assert.equal(state.access_revision, '9007199254740994');
});
