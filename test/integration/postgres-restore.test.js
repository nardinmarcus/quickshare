const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { computeRequestHmac, dashboardNamespace } = require('../../utils/idempotency');
const { hashSecret, encryptSecret } = require('../../utils/security');

// History restore and idempotent dashboard saves against real Postgres
// (T09, issue #33). The guarantees that matter — restore-vs-update on
// the same expected revision has exactly one winner, a failed restore
// rolls back projection + snapshot + audit + operation record together,
// and a committed operation replays its result even after its
// precondition went stale — rest on the operation lock order and row
// locks, so they are proven with two independent repositories (separate
// pools, separate connections).
//
// This file uses its own `quickshare_restore_test` database, created
// and dropped by the file itself.

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

const RESTORE_DB = 'quickshare_restore_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const restoreUrl = serverBaseUrl(RESTORE_DB);

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
    htmlContent: `<h1>${id} v1</h1>`,
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

function saveOperation(requestId, targetId, revision) {
  return {
    actorNamespace: dashboardNamespace(),
    requestId,
    action: 'share.content.update',
    targetId,
    requestHmac: computeRequestHmac({
      action: 'share.content.update',
      targetId,
      presence: { htmlContent: 1, expectedContentRevision: 1 },
      values: { htmlContent: '<h1>saved v2</h1>', expectedContentRevision: revision }
    })
  };
}

function restoreOperation(requestId, targetId, sourceRevision, revision) {
  return {
    actorNamespace: dashboardNamespace(),
    requestId,
    action: 'share.restore',
    targetId,
    requestHmac: computeRequestHmac({
      action: 'share.restore',
      targetId,
      presence: { sourceRevision: 1, expectedContentRevision: 1 },
      values: { sourceRevision, expectedContentRevision: revision }
    })
  };
}

async function editTo(repo, id, htmlContent, expectedRevision) {
  const result = await repo.updatePageWithPreconditions(id, { htmlContent }, {
    expectedContentRevision: expectedRevision,
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });
  assert.equal(result.status, 'updated');
  return result;
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await adminPool.query(`CREATE DATABASE ${RESTORE_DB}`);

  repoA = new PostgresPageRepository(restoreUrl, env);
  repoB = new PostgresPageRepository(restoreUrl, env);
  await runMigrations(repoA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repoA.pool.end();
  await repoB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('restore vs update on the same expected revision: exactly one wins', async () => {
  await repoA.create(pageFixture('pg-restore-race'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });
  await editTo(repoA, 'pg-restore-race', '<h1>race v2</h1>', '1');

  const operation = restoreOperation('pg-restore-race-op-0001', 'pg-restore-race', '1', '2');

  const [restoreOutcome, updateResult] = await Promise.all([
    repoA.restoreRevision({
      id: 'pg-restore-race',
      sourceRevision: '1',
      precondition: { expectedContentRevision: '2', ip: '127.0.0.1' },
      operation
    }),
    repoB.updatePageWithPreconditions('pg-restore-race', { htmlContent: '<h1>race v3</h1>' }, {
      expectedContentRevision: '2',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: '127.0.0.1'
    })
  ]);

  const restoreStatus = restoreOutcome.result.status;
  const statuses = [restoreStatus, updateResult.status].sort();
  assert.deepEqual(statuses, ['content_conflict', 'updated']);

  const page = await repoA.getById('pg-restore-race');
  assert.equal(String(page.current_revision), '3');

  const snapshots = await repoA.listContentSnapshots('pg-restore-race');
  assert.equal(snapshots.length, 3);

  const operations = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.publish_operations WHERE request_id = 'pg-restore-race-op-0001'"
  );

  if (restoreStatus === 'updated') {
    // The restore won: Revision 3 is the restored v1 content with its
    // provenance recorded, and the operation was committed.
    assert.equal(page.html_content, '<h1>pg-restore-race v1</h1>');
    assert.equal(snapshots[2].source, 'admin-restore');
    assert.equal(String(snapshots[2].restored_from_revision), '1');
    assert.equal(operations.rows[0].count, 1);
  } else {
    // The update won: the losing restore recorded nothing.
    assert.equal(page.html_content, '<h1>race v3</h1>');
    assert.equal(operations.rows[0].count, 0);
  }
});

test('a failing snapshot insert during restore rolls back everything', async () => {
  await repoA.create(pageFixture('pg-restore-atomic'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });
  await editTo(repoA, 'pg-restore-atomic', '<h1>atomic v2</h1>', '1');

  await repoA.pool.query(`
    CREATE OR REPLACE FUNCTION public.fail_revision_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected snapshot failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await repoA.pool.query(`
    CREATE TRIGGER fail_revision_insert_trigger
    BEFORE INSERT ON public.share_revisions
    FOR EACH ROW EXECUTE FUNCTION public.fail_revision_insert()
  `);

  const operation = restoreOperation('pg-restore-atomic-op-01', 'pg-restore-atomic', '1', '2');

  try {
    await assert.rejects(
      repoB.restoreRevision({
        id: 'pg-restore-atomic',
        sourceRevision: '1',
        precondition: { expectedContentRevision: '2', ip: '127.0.0.1' },
        operation
      }),
      /injected snapshot failure/
    );
  } finally {
    await repoA.pool.query('DROP TRIGGER IF EXISTS fail_revision_insert_trigger ON public.share_revisions');
    await repoA.pool.query('DROP FUNCTION IF EXISTS public.fail_revision_insert()');
  }

  const page = await repoA.getById('pg-restore-atomic');
  assert.equal(page.html_content, '<h1>atomic v2</h1>');
  assert.equal(String(page.current_revision), '2');
  assert.equal((await repoA.listContentSnapshots('pg-restore-atomic')).length, 2);

  const operations = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.publish_operations WHERE request_id = 'pg-restore-atomic-op-01'"
  );
  assert.equal(operations.rows[0].count, 0);

  // Only the setup edit's content audit exists; the failed restore
  // committed no audit row.
  const audits = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE page_id = 'pg-restore-atomic' AND action = 'page.content.update'"
  );
  assert.equal(audits.rows[0].count, 1);
});

test('committed save replays at repository level after its precondition went stale', async () => {
  await repoA.create(pageFixture('pg-save-replay'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });

  const operation = saveOperation('pg-save-replay-op-0001', 'pg-save-replay', '1');
  const executed = await repoA.saveContentIdempotent({
    id: 'pg-save-replay',
    options: { htmlContent: '<h1>saved v2</h1>' },
    precondition: {
      expectedContentRevision: '1',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: '127.0.0.1'
    },
    operation
  });
  assert.equal(executed.outcome, 'executed');
  assert.equal(executed.result.status, 'updated');
  assert.equal(executed.result.contentRevision, '2');

  // Another connection advances the content; the original expected
  // revision is stale now.
  await editTo(repoB, 'pg-save-replay', '<h1>saved v3</h1>', '2');

  const replayed = await repoB.saveContentIdempotent({
    id: 'pg-save-replay',
    options: { htmlContent: '<h1>saved v2</h1>' },
    precondition: {
      expectedContentRevision: '1',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: '127.0.0.1'
    },
    operation
  });
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(String(replayed.operation.resultRevision), '2');

  // No fourth snapshot, current content untouched.
  assert.equal((await repoA.listContentSnapshots('pg-save-replay')).length, 3);
  const page = await repoA.getById('pg-save-replay');
  assert.equal(page.html_content, '<h1>saved v3</h1>');
});

test('committed restore replays at repository level; restore preserves access state', async () => {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  await repoA.create(pageFixture('pg-restore-replay', {
    passwordHash: await hashSecret('Pg9!pass'),
    encryptedPassword: encryptSecret('Pg9!pass'),
    isProtected: true,
    expiresAt
  }), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });
  await repoA.pool.query(
    'UPDATE public.pages SET is_favorite = true, view_count = 7 WHERE id = $1',
    ['pg-restore-replay']
  );
  await editTo(repoA, 'pg-restore-replay', '<h1>replay v2</h1>', '1');

  const before = await repoA.getById('pg-restore-replay');
  const operation = restoreOperation('pg-restore-replay-op-1', 'pg-restore-replay', '1', '2');

  const executed = await repoA.restoreRevision({
    id: 'pg-restore-replay',
    sourceRevision: '1',
    precondition: { expectedContentRevision: '2', ip: '127.0.0.1' },
    operation
  });
  assert.equal(executed.outcome, 'executed');
  assert.equal(executed.result.status, 'updated');
  assert.equal(executed.result.contentRevision, '3');
  assert.equal(executed.result.sourceRevision, '1');
  assert.equal(executed.result.previousRevision, '2');

  const after = await repoA.getById('pg-restore-replay');
  assert.equal(after.html_content, '<h1>pg-restore-replay v1</h1>');
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.encrypted_password, before.encrypted_password);
  assert.equal(Number(after.expires_at), Number(before.expires_at));
  assert.equal(String(after.access_revision), String(before.access_revision));
  assert.equal(after.is_favorite, true);
  assert.equal(Number(after.view_count), 7);
  assert.equal(after.published, before.published);

  // Advance, then replay the committed restore with its stale
  // precondition: the recorded result comes back, nothing re-executes.
  await editTo(repoB, 'pg-restore-replay', '<h1>replay v4</h1>', '3');

  const replayed = await repoB.restoreRevision({
    id: 'pg-restore-replay',
    sourceRevision: '1',
    precondition: { expectedContentRevision: '2', ip: '127.0.0.1' },
    operation
  });
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(String(replayed.operation.resultRevision), '3');
  assert.equal((await repoA.listContentSnapshots('pg-restore-replay')).length, 4);
});

test('a missing snapshot is not a valid restore source', async () => {
  // The purged-tombstone case is covered by the memory-adapter HTTP
  // suite: the current Postgres schema keeps html_content NOT NULL and
  // has no purge representation yet (purge is a later ticket), while
  // the restore path already refuses a content-less snapshot in both
  // adapters.
  await repoA.create(pageFixture('pg-restore-purged'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });
  await editTo(repoA, 'pg-restore-purged', '<h1>purged v2</h1>', '1');

  const missing = await repoA.restoreRevision({
    id: 'pg-restore-purged',
    sourceRevision: '99',
    precondition: { expectedContentRevision: '2', ip: '127.0.0.1' },
    operation: null
  });
  assert.equal(missing.result.status, 'source_not_found');

  const page = await repoA.getById('pg-restore-purged');
  assert.equal(String(page.current_revision), '2');
  assert.equal(page.html_content, '<h1>purged v2</h1>');
  assert.equal((await repoA.listContentSnapshots('pg-restore-purged')).length, 2);
});
