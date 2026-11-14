const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'pg-publication-test-secret';

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { computeRequestHmac, dashboardNamespace } = require('../../utils/idempotency');
const { isPublishingGateError } = require('../../utils/publishing');
const { decryptSecret } = require('../../utils/security');

// Publish-state transitions against real Postgres (T11, issue #35).
// The guarantees that matter — the state flip, the access-version
// advance, the audit and the operation record commit or roll back
// together; a state race on two connections has exactly one winner per
// access-version precondition; the view-event conditional UPDATE
// honors `published` — rest on row locks and the gated transaction, so
// they are proven with two independent repositories (separate pools,
// separate connections).
//
// This file uses its own `quickshare_publication_test` database,
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

const PUBLICATION_DB = 'quickshare_publication_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const publicationUrl = serverBaseUrl(PUBLICATION_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

let adminPool;
let repoA;
let repoB;

async function resetState() {
  await repoA.pool.query('DELETE FROM public.pages');
  await repoA.pool.query('DELETE FROM public.audit_logs');
  await repoA.pool.query('DELETE FROM public.api_keys');
  await repoA.pool.query('DELETE FROM public.publish_operations');
  await repoA.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

function pageFixture(id, overrides = {}) {
  return {
    id,
    htmlContent: `<h1>${id} body</h1>`,
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: `${id} title`,
    description: null,
    expiresAt: null,
    markdownTheme: null,
    ...overrides
  };
}

function publishOperation(requestId, action, id, published, expectedAccessRevision) {
  return {
    actorNamespace: dashboardNamespace(),
    requestId,
    action,
    targetId: id,
    requestHmac: computeRequestHmac({
      action,
      targetId: id,
      presence: {
        published: 1,
        expectedAccessRevision: expectedAccessRevision != null ? 1 : 0
      },
      values: {
        published: published ? 'true' : 'false',
        expectedAccessRevision: expectedAccessRevision ?? null
      }
    })
  };
}

async function publishAuditCount(id) {
  const result = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE action = 'page.publish.update' AND page_id = $1",
    [id]
  );
  return result.rows[0].count;
}

async function pageRow(id) {
  const result = await repoA.pool.query(
    'SELECT published, access_revision::text AS access_revision, current_revision::text AS current_revision, COALESCE(view_count, 0)::int AS view_count FROM public.pages WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${PUBLICATION_DB}`);
  await adminPool.query(`CREATE DATABASE ${PUBLICATION_DB}`);

  repoA = new PostgresPageRepository(publicationUrl, env);
  repoB = new PostgresPageRepository(publicationUrl, env);
  await runMigrations(repoA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repoA.pool.end();
  await repoB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${PUBLICATION_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('a transition commits state, version advance, audit and operation record together', async () => {
  await repoA.create(pageFixture('pg-pub-atomic'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const operation = publishOperation('pg-pub-req-atomic', 'share.unpublish', 'pg-pub-atomic', false, '1');
  const outcome = await repoA.setPublishedState({
    id: 'pg-pub-atomic',
    published: false,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
    operation,
    ip: '127.0.0.1'
  });

  assert.equal(outcome.outcome, 'executed');
  assert.equal(outcome.result.status, 'updated');
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.published, false);
  assert.equal(outcome.result.accessRevision, '2');
  assert.equal(outcome.result.contentRevision, '1');

  const row = await pageRow('pg-pub-atomic');
  assert.equal(row.published, false);
  assert.equal(row.access_revision, '2');
  assert.equal(row.current_revision, '1');

  assert.equal(await publishAuditCount('pg-pub-atomic'), 1);
  const audit = await repoA.pool.query(
    "SELECT details FROM public.audit_logs WHERE action = 'page.publish.update' AND page_id = 'pg-pub-atomic'"
  );
  assert.deepEqual(JSON.parse(audit.rows[0].details), { from: true, to: false, accessRevision: '2' });

  const opRow = await repoA.pool.query(
    'SELECT * FROM public.publish_operations WHERE request_id = $1',
    ['pg-pub-req-atomic']
  );
  assert.equal(opRow.rows.length, 1);
  assert.equal(opRow.rows[0].action, 'share.unpublish');
  assert.equal(opRow.rows[0].result_share_id, 'pg-pub-atomic');
  assert.equal(opRow.rows[0].result_revision, null);
  assert.equal(String(opRow.rows[0].result_access_revision), '2');
  const receipt = JSON.parse(decryptSecret(opRow.rows[0].receipt_encrypted));
  assert.deepEqual(receipt, {
    kind: 'share.unpublish',
    shareId: 'pg-pub-atomic',
    published: false,
    changed: true,
    accessRevision: '2'
  });
});

test('state race on two connections: exactly one winner per access-version precondition', async () => {
  await repoA.create(pageFixture('pg-pub-race'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const [first, second] = await Promise.all([
    repoA.setPublishedState({
      id: 'pg-pub-race',
      published: false,
      precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
      operation: publishOperation('pg-pub-req-race-a', 'share.unpublish', 'pg-pub-race', false, '1'),
      ip: '127.0.0.1'
    }),
    repoB.setPublishedState({
      id: 'pg-pub-race',
      published: false,
      precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
      operation: publishOperation('pg-pub-req-race-b', 'share.unpublish', 'pg-pub-race', false, '1'),
      ip: '127.0.0.1'
    })
  ]);

  const statuses = [first.result?.status, second.result?.status].sort();
  assert.deepEqual(statuses, ['conflict', 'updated']);

  const row = await pageRow('pg-pub-race');
  assert.equal(row.published, false);
  assert.equal(row.access_revision, '2');
  assert.equal(await publishAuditCount('pg-pub-race'), 1);

  // The loser recorded nothing: only the winner's operation exists.
  const ops = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.publish_operations WHERE target_id = 'pg-pub-race'"
  );
  assert.equal(ops.rows[0].count, 1);
});

test('unpublish racing a revoke: one advance wins, the loser conflicts, state stays coherent', async () => {
  await repoA.create(pageFixture('pg-pub-revoke-race'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const [transition, revoke] = await Promise.all([
    repoA.setPublishedState({
      id: 'pg-pub-revoke-race',
      published: false,
      precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
      ip: '127.0.0.1'
    }),
    repoB.revokeAccess('pg-pub-revoke-race', '1')
  ]);

  const outcomes = [transition.result?.status, revoke.status].sort();
  assert.deepEqual(outcomes, ['conflict', 'updated']);

  const row = await pageRow('pg-pub-revoke-race');
  assert.equal(row.access_revision, '2');
  // Whichever write won, the publish state matches it exactly: the
  // unpublish won => unpublished; the revoke won => still published.
  assert.equal(row.published, transition.result?.status !== 'updated');
});

test('unchanged under Postgres: recorded, replayable across connections, no advance, no audit', async () => {
  await repoA.create(pageFixture('pg-pub-unchanged'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const operation = publishOperation('pg-pub-req-unchanged', 'share.republish', 'pg-pub-unchanged', true, '1');
  const outcome = await repoA.setPublishedState({
    id: 'pg-pub-unchanged',
    published: true,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
    operation,
    ip: '127.0.0.1'
  });
  assert.equal(outcome.result.status, 'unchanged');
  assert.equal(outcome.result.accessRevision, '1');
  assert.equal(await publishAuditCount('pg-pub-unchanged'), 0);
  assert.equal((await pageRow('pg-pub-unchanged')).access_revision, '1');

  // The same operation replayed from the other connection returns the
  // recorded result rather than re-judging.
  const replay = await repoB.setPublishedState({
    id: 'pg-pub-unchanged',
    published: true,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
    operation,
    ip: '127.0.0.1'
  });
  assert.equal(replay.outcome, 'replayed');
  assert.ok(replay.shareState);
  const receipt = JSON.parse(decryptSecret(replay.operation.receiptEncrypted));
  assert.equal(receipt.changed, false);
  assert.equal(receipt.published, true);
  assert.equal(receipt.accessRevision, '1');
});

test('replay after a transition returns the recorded result even with a stale precondition', async () => {
  await repoA.create(pageFixture('pg-pub-replay'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const operation = publishOperation('pg-pub-req-replay', 'share.unpublish', 'pg-pub-replay', false, '1');
  const first = await repoA.setPublishedState({
    id: 'pg-pub-replay',
    published: false,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
    operation,
    ip: '127.0.0.1'
  });
  assert.equal(first.result.status, 'updated');

  const replay = await repoB.setPublishedState({
    id: 'pg-pub-replay',
    published: false,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false },
    operation,
    ip: '127.0.0.1'
  });
  assert.equal(replay.outcome, 'replayed');
  const receipt = JSON.parse(decryptSecret(replay.operation.receiptEncrypted));
  assert.equal(receipt.published, false);
  assert.equal(receipt.accessRevision, '2');
  assert.equal(await publishAuditCount('pg-pub-replay'), 1);
});

test('precondition judgments: missing, stale and not-found record nothing', async () => {
  await repoA.create(pageFixture('pg-pub-preconditions'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  const missing = await repoA.setPublishedState({
    id: 'pg-pub-preconditions',
    published: false,
    precondition: { expectedAccessRevision: null, accessPreconditionMissing: true },
    operation: publishOperation('pg-pub-req-missing', 'share.unpublish', 'pg-pub-preconditions', false, null)
  });
  assert.equal(missing.result.status, 'access_precondition_required');
  assert.equal(missing.result.accessRevision, '1');

  const stale = await repoA.setPublishedState({
    id: 'pg-pub-preconditions',
    published: false,
    precondition: { expectedAccessRevision: '42', accessPreconditionMissing: false },
    operation: publishOperation('pg-pub-req-stale', 'share.unpublish', 'pg-pub-preconditions', false, '42')
  });
  assert.equal(stale.result.status, 'conflict');
  assert.equal(stale.result.accessRevision, '1');

  const notFound = await repoA.setPublishedState({
    id: 'pg-pub-absent',
    published: false,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false }
  });
  assert.equal(notFound.result.status, 'not_found');

  const ops = await repoA.pool.query('SELECT COUNT(*)::int AS count FROM public.publish_operations');
  assert.equal(ops.rows[0].count, 0);
  assert.equal((await pageRow('pg-pub-preconditions')).access_revision, '1');
});

test('BIGINT access revisions stay exact across a transition', async () => {
  await repoA.create(pageFixture('pg-pub-bigint'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });
  await repoA.pool.query(
    "UPDATE public.pages SET access_revision = 9007199254740993 WHERE id = 'pg-pub-bigint'"
  );

  const outcome = await repoA.setPublishedState({
    id: 'pg-pub-bigint',
    published: false,
    precondition: { expectedAccessRevision: '9007199254740993', accessPreconditionMissing: false },
    ip: '127.0.0.1'
  });
  assert.equal(outcome.result.status, 'updated');
  assert.equal(outcome.result.accessRevision, '9007199254740994');
  assert.equal((await pageRow('pg-pub-bigint')).access_revision, '9007199254740994');
});

test('recordViewEvent honors published ahead of expiry and protection', async () => {
  await repoA.create(pageFixture('pg-pub-events'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  assert.equal(await repoA.recordViewEvent('pg-pub-events', Date.now(), false, null), 'counted');
  assert.equal((await pageRow('pg-pub-events')).view_count, 1);

  await repoA.setPublishedState({
    id: 'pg-pub-events',
    published: false,
    precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false }
  });
  assert.equal(await repoA.recordViewEvent('pg-pub-events', Date.now(), false, null), 'not_found');
  assert.equal((await pageRow('pg-pub-events')).view_count, 1);

  // Unpublished outranks expiry too.
  await repoA.pool.query(
    "UPDATE public.pages SET expires_at = $1 WHERE id = 'pg-pub-events'",
    [Date.now() - 1000]
  );
  assert.equal(await repoA.recordViewEvent('pg-pub-events', Date.now(), false, null), 'not_found');

  await repoA.setPublishedState({
    id: 'pg-pub-events',
    published: true,
    precondition: { expectedAccessRevision: '2', accessPreconditionMissing: false }
  });
  assert.equal(await repoA.recordViewEvent('pg-pub-events', Date.now(), false, null), 'expired');
  assert.equal((await pageRow('pg-pub-events')).view_count, 1);
});

test('the publishing gate refuses a transition while writes are paused', async () => {
  await repoA.create(pageFixture('pg-pub-gated'), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });

  await repoA.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    await assert.rejects(
      repoB.setPublishedState({
        id: 'pg-pub-gated',
        published: false,
        precondition: { expectedAccessRevision: '1', accessPreconditionMissing: false }
      }),
      error => isPublishingGateError(error)
    );
  } finally {
    await repoA.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  const row = await pageRow('pg-pub-gated');
  assert.equal(row.published, true);
  assert.equal(row.access_revision, '1');
});
