const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');

// Permanent Revision purge against real Postgres (T10, issue #34).
// The guarantees that matter — the tombstone write, the receipt scrub
// and the audit commit or roll back together; the current-version
// judgment is re-verified under the Share row lock against concurrent
// restores on a second connection; a purged source cannot be restored
// on this Adapter either (the case T09 could only simulate on the
// memory Adapter before migration 009) — rest on row locks and the
// nullable payload columns, so they are proven with two independent
// repositories (separate pools, separate connections).
//
// This file uses its own `quickshare_purge_test` database, created
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

const PURGE_DB = 'quickshare_purge_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const purgeUrl = serverBaseUrl(PURGE_DB);

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

async function editTo(repo, id, htmlContent, expectedRevision) {
  const result = await repo.updatePageWithPreconditions(id, { htmlContent }, {
    expectedContentRevision: expectedRevision,
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });
  assert.equal(result.status, 'updated');
  return result;
}

async function twoRevisionShare(repo, id) {
  await repo.create(pageFixture(id), {
    revisionMeta: { source: 'api-create', actorType: 'owner', actorId: null }
  });
  await editTo(repo, id, `<h1>${id} v2</h1>`, '1');
}

async function purgeAuditCount(id) {
  const result = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE action = 'page.revision.purge' AND page_id = $1",
    [id]
  );
  return result.rows[0].count;
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${PURGE_DB}`);
  await adminPool.query(`CREATE DATABASE ${PURGE_DB}`);

  repoA = new PostgresPageRepository(purgeUrl, env);
  repoB = new PostgresPageRepository(purgeUrl, env);
  await runMigrations(repoA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repoA.pool.end();
  await repoB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${PURGE_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('purge tombstones the snapshot and scrubs exactly that version\'s receipts in one transaction', async () => {
  await twoRevisionShare(repoA, 'pg-purge-basic');

  // Two committed operations in different namespaces: one whose result
  // is the purge target version, one whose result is the surviving
  // version. The receipts are opaque ciphertext to the purge — what
  // matters is which rows lose them.
  await repoA.pool.query(
    `INSERT INTO public.publish_operations (
       actor_namespace, request_id, action, target_id, request_hmac,
       result_share_id, result_revision, result_access_revision,
       receipt_encrypted, result_state, created_at
     ) VALUES
       ('key:legacy', 'pg-purge-op-target', 'share.create', NULL, $1, 'pg-purge-basic', 1, 1, 'cipher-target', 'committed', 1000),
       ('dashboard:session', 'pg-purge-op-survivor', 'share.content.update', 'pg-purge-basic', $1, 'pg-purge-basic', 2, 1, 'cipher-survivor', 'committed', 1001)`,
    ['a'.repeat(64)]
  );

  const result = await repoA.purgeRevision({ id: 'pg-purge-basic', revision: '1', ip: '127.0.0.1' });
  assert.equal(result.status, 'purged');
  assert.equal(result.scrubbedReceipts, 1);
  assert.equal(typeof result.purgedAt, 'number');

  const row = await repoA.pool.query(
    `SELECT html_content, title, description, markdown_theme, snapshot_hash,
            code_type, source, purged_at::text AS purged_at
     FROM public.share_revisions WHERE share_id = 'pg-purge-basic' AND revision = 1`
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].html_content, null);
  assert.equal(row.rows[0].title, null);
  assert.equal(row.rows[0].description, null);
  assert.equal(row.rows[0].markdown_theme, null);
  assert.equal(row.rows[0].snapshot_hash, null);
  assert.equal(row.rows[0].purged_at, String(result.purgedAt));
  // Structural metadata survives: the tombstone still says what this
  // row was — a version 1 html snapshot from the API create.
  assert.equal(row.rows[0].code_type, 'html');
  assert.equal(row.rows[0].source, 'api-create');

  const survivor = await repoA.getContentSnapshot('pg-purge-basic', '2');
  assert.equal(survivor.html_content, '<h1>pg-purge-basic v2</h1>');
  assert.equal(survivor.purged_at, null);

  const operations = await repoA.pool.query(
    'SELECT request_id, receipt_encrypted, result_state FROM public.publish_operations ORDER BY request_id'
  );
  const byRequest = new Map(operations.rows.map(op => [op.request_id, op]));
  // The target version's receipt is gone in every namespace, but the
  // operation itself stays a committed, confirmable record.
  assert.equal(byRequest.get('pg-purge-op-target').receipt_encrypted, null);
  assert.equal(byRequest.get('pg-purge-op-target').result_state, 'committed');
  assert.equal(byRequest.get('pg-purge-op-survivor').receipt_encrypted, 'cipher-survivor');

  assert.equal(await purgeAuditCount('pg-purge-basic'), 1);

  // The repository read model agrees: a tombstone, flagged as purged.
  const snapshot = await repoA.getContentSnapshot('pg-purge-basic', '1');
  assert.equal(snapshot.html_content, null);
  assert.equal(Number(snapshot.purged_at), result.purgedAt);
  const meta = await repoA.listContentRevisionMeta('pg-purge-basic', { limit: 10, offset: 0 });
  const metaByRevision = new Map(meta.revisions.map(item => [item.revision, item]));
  assert.equal(Number(metaByRevision.get('1').purged_at), result.purgedAt);
  assert.equal(metaByRevision.get('2').purged_at, null);
});

test('purge refusals on Postgres: current version, unknown version, unknown share', async () => {
  await twoRevisionShare(repoA, 'pg-purge-refusals');

  const current = await repoA.purgeRevision({ id: 'pg-purge-refusals', revision: '2' });
  assert.equal(current.status, 'current_revision');
  assert.equal(current.currentRevision, '2');

  const unknown = await repoA.purgeRevision({ id: 'pg-purge-refusals', revision: '99' });
  assert.equal(unknown.status, 'revision_not_found');

  const noShare = await repoA.purgeRevision({ id: 'pg-purge-missing', revision: '1' });
  assert.equal(noShare.status, 'not_found');

  const malformed = await repoA.purgeRevision({ id: 'pg-purge-refusals', revision: 'abc' });
  assert.equal(malformed.status, 'revision_not_found');

  const snapshot = await repoA.getContentSnapshot('pg-purge-refusals', '2');
  assert.equal(snapshot.html_content, '<h1>pg-purge-refusals v2</h1>');
  assert.equal(await purgeAuditCount('pg-purge-refusals'), 0);
});

test('restoring a purged source is source_unavailable on Postgres and mints nothing', async () => {
  await twoRevisionShare(repoA, 'pg-purge-restore');

  const purged = await repoA.purgeRevision({ id: 'pg-purge-restore', revision: '1' });
  assert.equal(purged.status, 'purged');

  const outcome = await repoA.restoreRevision({
    id: 'pg-purge-restore',
    sourceRevision: '1',
    precondition: { expectedContentRevision: '2', ip: '127.0.0.1' }
  });
  assert.equal(outcome.result.status, 'source_unavailable');

  const page = await repoA.getById('pg-purge-restore');
  assert.equal(String(page.current_revision), '2');
  assert.equal(page.html_content, '<h1>pg-purge-restore v2</h1>');
  assert.equal((await repoA.listContentSnapshots('pg-purge-restore')).length, 2);
});

test('concurrent duplicate purges: exactly one purges, the other reports already_purged, one audit', async () => {
  await twoRevisionShare(repoA, 'pg-purge-dupes');

  const [first, second] = await Promise.all([
    repoA.purgeRevision({ id: 'pg-purge-dupes', revision: '1', ip: '127.0.0.1' }),
    repoB.purgeRevision({ id: 'pg-purge-dupes', revision: '1', ip: '127.0.0.1' })
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ['already_purged', 'purged']);
  assert.equal(first.purgedAt, second.purgedAt);
  assert.equal(await purgeAuditCount('pg-purge-dupes'), 1);

  const tombstone = await repoA.getContentSnapshot('pg-purge-dupes', '1');
  assert.equal(tombstone.html_content, null);
  assert.equal(Number(tombstone.purged_at), first.purgedAt);
});

test('purge vs restore of the same source: the current snapshot always keeps its payload', async () => {
  for (let round = 0; round < 6; round += 1) {
    const id = `pg-purge-race-${round}`;
    await twoRevisionShare(repoA, id);

    const [purgeResult, restoreOutcome] = await Promise.all([
      repoA.purgeRevision({ id, revision: '1', ip: '127.0.0.1' }),
      repoB.restoreRevision({
        id,
        sourceRevision: '1',
        precondition: { expectedContentRevision: '2', ip: '127.0.0.1' }
      })
    ]);

    // Revision 1 never becomes current in this race, so the purge
    // always lands exactly once.
    assert.equal(purgeResult.status, 'purged', `round ${round}`);

    // The restore either read the payload before the tombstone landed
    // (serialized by the Share row lock) or found the tombstone and
    // refused. It can never succeed by reading cleared content.
    assert.ok(
      ['updated', 'source_unavailable'].includes(restoreOutcome.result.status),
      `round ${round}: unexpected restore status ${restoreOutcome.result.status}`
    );

    const page = await repoA.getById(id);
    const currentSnapshot = await repoA.getContentSnapshot(id, String(page.current_revision));
    assert.notEqual(currentSnapshot.html_content, null, `round ${round}: current snapshot lost its payload`);
    assert.equal(currentSnapshot.purged_at, null);

    const tombstone = await repoA.getContentSnapshot(id, '1');
    assert.equal(tombstone.html_content, null);
    assert.notEqual(tombstone.purged_at, null);

    if (restoreOutcome.result.status === 'updated') {
      // The restore won the lock order: Revision 3 legitimately holds
      // the v1 payload copied BEFORE the purge — the purge cleared
      // version 1's stored snapshot, not the new version it became.
      assert.equal(String(page.current_revision), '3');
      assert.equal(currentSnapshot.html_content, `<h1>${id} v1</h1>`);
      assert.equal(String(currentSnapshot.restored_from_revision), '1');
    } else {
      assert.equal(String(page.current_revision), '2');
    }
  }
});

test('purge of the current version vs a restore that would dethrone it: the current snapshot is never purged', async () => {
  for (let round = 0; round < 6; round += 1) {
    const id = `pg-purge-current-race-${round}`;
    await twoRevisionShare(repoA, id);

    const [purgeResult, restoreOutcome] = await Promise.all([
      repoA.purgeRevision({ id, revision: '2', ip: '127.0.0.1' }),
      repoB.restoreRevision({
        id,
        sourceRevision: '1',
        precondition: { expectedContentRevision: '2', ip: '127.0.0.1' }
      })
    ]);

    // The restore is unaffected by the purge attempt either way: the
    // purge never touches Revision 1 (its source) or the Revision 2
    // precondition while Revision 2 is current, so it always lands.
    assert.equal(restoreOutcome.result.status, 'updated', `round ${round}`);

    const page = await repoA.getById(id);
    assert.equal(String(page.current_revision), '3');
    const currentSnapshot = await repoA.getContentSnapshot(id, '3');
    assert.notEqual(currentSnapshot.html_content, null, `round ${round}: current snapshot was purged`);
    assert.equal(currentSnapshot.purged_at, null);

    if (purgeResult.status === 'purged') {
      // The restore won the lock order and minted Revision 3 first;
      // only then could the purge judge Revision 2 non-current and
      // clear it. The version that was current when the purge was
      // requested was never purged while still current.
      const dethroned = await repoA.getContentSnapshot(id, '2');
      assert.equal(dethroned.html_content, null);
      assert.notEqual(dethroned.purged_at, null);
    } else {
      // The purge judged first, while Revision 2 was still current,
      // and refused without writing anything.
      assert.equal(purgeResult.status, 'current_revision', `round ${round}`);
      const stillThere = await repoA.getContentSnapshot(id, '2');
      assert.equal(stillThere.html_content, `<h1>${id} v2</h1>`);
      assert.equal(await purgeAuditCount(id), 0);
    }
  }
});
