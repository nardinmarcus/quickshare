const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { collectSnapshot, compareSnapshots } = require('../../scripts/backup-lib');
const { computeRequestHmac } = require('../../utils/idempotency');
const { isPublishingGateError } = require('../../utils/publishing');
const { generateId } = require('../../utils/security');

// Publish operations against real Postgres (T08, issue #32). The dedup
// guarantee rests on the (actor_namespace, request_id) primary key plus
// the per-request advisory transaction lock, exercised here with two
// independent repositories (separate pools, separate connections) —
// never with two queries multiplexed over one client.
//
// This file uses its own `quickshare_idempotency_test` database,
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

const IDEMPOTENCY_DB = 'quickshare_idempotency_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const idempotencyUrl = serverBaseUrl(IDEMPOTENCY_DB);

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
  await repoA.pool.query('DELETE FROM public.publish_operations');
  await repoA.pool.query('DELETE FROM public.share_revisions');
  await repoA.pool.query('DELETE FROM public.pages');
  await repoA.pool.query('DELETE FROM public.audit_logs');
  await repoA.pool.query('DELETE FROM public.api_keys');
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

const NAMESPACE = 'key:managed:pg-idem-key';

function operationFixture(requestId, overrides = {}) {
  return {
    actorNamespace: NAMESPACE,
    requestId,
    action: 'share.create',
    targetId: null,
    requestHmac: computeRequestHmac({
      action: 'share.create',
      targetId: null,
      presence: { title: 1 },
      values: { htmlContent: '<h1>x</h1>', title: 'T' }
    }),
    ...overrides
  };
}

function createAttempt(repo, operation, { prepareError = null } = {}) {
  return repo.createIdempotent({
    operation,
    revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-idem-key' },
    audit: {
      action: 'page.create',
      details: JSON.stringify({ source: 'api', requestId: operation.requestId }),
      ip: '127.0.0.1'
    },
    prepare: async () => {
      if (prepareError) {
        throw prepareError;
      }

      const id = `pg-idem-${generateId(10)}`;
      const page = pageFixture(id);
      return {
        page,
        result: {
          kind: 'share.create',
          shareId: id,
          password: null,
          isProtected: false,
          codeType: 'html',
          title: page.title,
          description: null,
          expiresAt: null,
          markdownTheme: null,
          contentRevision: '1',
          contentEtag: `"content:${id}:1"`
        }
      };
    }
  });
}

async function counts() {
  const pages = await repoA.pool.query('SELECT COUNT(*)::int AS count FROM public.pages');
  const operations = await repoA.pool.query('SELECT COUNT(*)::int AS count FROM public.publish_operations');
  const revisions = await repoA.pool.query('SELECT COUNT(*)::int AS count FROM public.share_revisions');
  const audits = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE action = 'page.create'"
  );
  return {
    pages: pages.rows[0].count,
    operations: operations.rows[0].count,
    revisions: revisions.rows[0].count,
    createAudits: audits.rows[0].count
  };
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${IDEMPOTENCY_DB}`);
  await adminPool.query(`CREATE DATABASE ${IDEMPOTENCY_DB}`);

  repoA = new PostgresPageRepository(idempotencyUrl, env);
  repoB = new PostgresPageRepository(idempotencyUrl, env);
  await runMigrations(repoA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repoA.pool.end();
  await repoB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${IDEMPOTENCY_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('migration 008 creates publish_operations keyed by (namespace, request id) with no pages foreign key', async () => {
  const columns = await repoA.pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'publish_operations'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows.map(row => row.column_name), [
    'actor_namespace',
    'request_id',
    'action',
    'target_id',
    'request_hmac',
    'result_share_id',
    'result_revision',
    'result_access_revision',
    'receipt_encrypted',
    'result_state',
    'created_at'
  ]);

  const pk = await repoA.pool.query(`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'public.publish_operations'::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
  `);
  assert.deepEqual(pk.rows.map(row => row.column_name), ['actor_namespace', 'request_id']);

  // No foreign key to pages: the record must survive its result Share
  // as a content-free tombstone.
  const fks = await repoA.pool.query(`
    SELECT COUNT(*)::int AS count
    FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'publish_operations'
      AND constraint_type = 'FOREIGN KEY'
  `);
  assert.equal(fks.rows[0].count, 0);

  const index = await repoA.pool.query(`
    SELECT COUNT(*)::int AS count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'publish_operations'
      AND indexname = 'idx_publish_operations_result_share'
  `);
  assert.equal(index.rows[0].count, 1);
});

test('two concurrent identical creates on separate connections commit exactly one Share, Revision and operation', async () => {
  const operation = operationFixture('pg-concurrent-0001');

  const [first, second] = await Promise.all([
    createAttempt(repoA, operation),
    createAttempt(repoB, operation)
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ['created', 'replayed']);

  const created = first.outcome === 'created' ? first : second;
  const replayed = first.outcome === 'replayed' ? first : second;
  assert.equal(replayed.operation.resultShareId, created.page.id);
  assert.equal(replayed.operation.resultRevision, '1');
  assert.ok(replayed.shareState, 'replay must see the committed result state');
  assert.equal(replayed.shareState.exists, true);
  assert.equal(replayed.shareState.revisionExists, true);

  assert.deepEqual(await counts(), { pages: 1, operations: 1, revisions: 1, createAudits: 1 });

  // A third submission from either connection still replays.
  const third = await createAttempt(repoB, operation);
  assert.equal(third.outcome, 'replayed');
  assert.equal(third.operation.resultShareId, created.page.id);
  assert.deepEqual(await counts(), { pages: 1, operations: 1, revisions: 1, createAudits: 1 });
});

test('same identifier with a different digest is refused 409 on both connections', async () => {
  const operation = operationFixture('pg-conflict-0001');
  const created = await createAttempt(repoA, operation);
  assert.equal(created.outcome, 'created');

  const conflicting = operationFixture('pg-conflict-0001', {
    requestHmac: computeRequestHmac({
      action: 'share.create',
      targetId: null,
      presence: { title: 1 },
      values: { htmlContent: '<h1>different</h1>', title: 'T' }
    })
  });

  await assert.rejects(createAttempt(repoB, conflicting), (error) => {
    assert.equal(error.code, 'idempotency_conflict');
    assert.equal(error.status, 409);
    return true;
  });
  assert.deepEqual(await counts(), { pages: 1, operations: 1, revisions: 1, createAudits: 1 });
});

test('a failed first execution commits nothing and the same identifier can be retried', async () => {
  const operation = operationFixture('pg-atomic-0001');
  const failure = new Error('simulated derivation failure');
  failure.name = 'CreateValidationError';

  await assert.rejects(createAttempt(repoA, operation, { prepareError: failure }), /derivation failure/);
  assert.deepEqual(await counts(), { pages: 0, operations: 0, revisions: 0, createAudits: 0 });

  // No persisted running/failed state: an explicit retry with the same
  // identifier executes fresh and commits exactly once.
  const retried = await createAttempt(repoB, operation);
  assert.equal(retried.outcome, 'created');
  assert.deepEqual(await counts(), { pages: 1, operations: 1, revisions: 1, createAudits: 1 });
});

test('deleting the result Share tombstones the record in the same transaction', async () => {
  const operation = operationFixture('pg-tombstone-0001');
  const created = await createAttempt(repoA, operation);
  const shareId = created.page.id;

  const stored = await repoA.getOperation(NAMESPACE, 'pg-tombstone-0001');
  assert.equal(stored.resultState, 'committed');
  assert.ok(stored.receiptEncrypted, 'receipt is stored encrypted before deletion');

  await repoB.deletePage(shareId);

  const tombstone = await repoA.getOperation(NAMESPACE, 'pg-tombstone-0001');
  assert.equal(tombstone.resultState, 'result_unavailable');
  assert.equal(tombstone.receiptEncrypted, null);
  assert.equal(tombstone.resultShareId, shareId, 'the tombstone still names the result it committed');

  const replay = await createAttempt(repoB, operation);
  assert.equal(replay.outcome, 'unavailable');
  assert.deepEqual(await counts(), { pages: 0, operations: 1, revisions: 0, createAudits: 1 });

  const ownerView = await repoA.getOperationByRequestId('pg-tombstone-0001');
  assert.equal(ownerView.actorNamespace, NAMESPACE);
  assert.equal(ownerView.resultState, 'result_unavailable');

  const missing = await repoA.getOperation(NAMESPACE, 'pg-never-existed');
  assert.equal(missing, null);
});

test('managed-Key credential recheck applies to idempotent writes (T05 machinery)', async () => {
  await repoA.pool.query(
    `INSERT INTO public.api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, credential_version)
     VALUES ('pg-idem-key', 'PG idem key', 'hash', 'qs_pg…', $1, NULL, 1)`,
    [Date.now()]
  );

  const credential = { type: 'managed', keyId: 'pg-idem-key', credentialVersion: '1' };
  const operation = operationFixture('pg-credential-0001');
  const created = await repoA.createIdempotent({
    operation,
    apiCredential: credential,
    revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-idem-key' },
    prepare: async () => {
      const id = `pg-idem-${generateId(10)}`;
      return {
        page: pageFixture(id),
        result: { kind: 'share.create', shareId: id }
      };
    }
  });
  assert.equal(created.outcome, 'created');

  // Rotation commits first (version 1 -> 2): a new write still carrying
  // the version-1 verification is refused inside its transaction, and
  // the refusal records nothing.
  await repoA.pool.query(
    'UPDATE public.api_keys SET credential_version = 2 WHERE id = $1',
    ['pg-idem-key']
  );

  await assert.rejects(
    repoB.createIdempotent({
      operation: operationFixture('pg-credential-0002'),
      apiCredential: credential,
      revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-idem-key' },
      prepare: async () => {
        const id = `pg-idem-${generateId(10)}`;
        return { page: pageFixture(id), result: { kind: 'share.create', shareId: id } };
      }
    }),
    (error) => {
      assert.equal(error.code, 'api_key_credential_changed');
      return true;
    }
  );
  assert.deepEqual(await counts(), { pages: 1, operations: 1, revisions: 1, createAudits: 0 });

  // But the replay of the operation committed BEFORE rotation still
  // works for the rotated credential (same logical namespace): the
  // recheck uses the version the replay request itself verified (2).
  const replay = await repoB.createIdempotent({
    operation,
    apiCredential: { type: 'managed', keyId: 'pg-idem-key', credentialVersion: '2' },
    revisionMeta: { source: 'api-create', actorType: 'api_key', actorId: 'pg-idem-key' },
    prepare: async () => {
      throw new Error('prepare must not run on a replay');
    }
  });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.operation.resultShareId, created.page.id);
});

test('write maintenance refuses an idempotent create without recording anything', async () => {
  const operation = operationFixture('pg-maintenance-0001');
  await repoA.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    await assert.rejects(createAttempt(repoB, operation), (error) => {
      assert.equal(isPublishingGateError(error), true);
      return true;
    });
    assert.deepEqual(await counts(), { pages: 0, operations: 0, revisions: 0, createAudits: 0 });
  } finally {
    await repoA.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  const after = await createAttempt(repoB, operation);
  assert.equal(after.outcome, 'created');
});

test('backup snapshot covers publish_operations row-for-row (T03 pattern)', async () => {
  const operation = operationFixture('pg-backup-0001');
  const created = await createAttempt(repoA, operation);
  assert.equal(created.outcome, 'created');

  const query = (sql, params) => repoA.pool.query(sql, params);
  const before = await collectSnapshot(query);
  assert.ok(before.snapshot.operations, 'snapshot must carry a publish_operations section');
  assert.equal(before.snapshot.operations.count, 1);
  const key = `${NAMESPACE}:pg-backup-0001`;
  assert.ok(before.snapshot.operations.digests[key], 'operation row digest is recorded by namespace:requestId');
  assert.ok(before.snapshot.tables.includes('publish_operations'));
  assert.deepEqual(
    compareSnapshots(before.snapshot, before.snapshot).filter(f => f.includes('publish_operations')),
    []
  );

  // Flipping the row into a tombstone in the "restored" copy must be
  // detected by the comparison.
  await repoA.pool.query(
    "UPDATE public.publish_operations SET result_state = 'result_unavailable', receipt_encrypted = NULL WHERE request_id = 'pg-backup-0001'"
  );
  const after = await collectSnapshot(query);
  const failures = compareSnapshots(before.snapshot, after.snapshot);
  assert.ok(
    failures.some(failure => failure.includes('publish_operations')),
    `tamper must be reported, got: ${failures.join('; ')}`
  );
});
