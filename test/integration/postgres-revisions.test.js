const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');

const { validateCanonicalPostgresSuiteUrl } = require('../../scripts/release-readiness-check');
const url = validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '5',
  POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue30-pg-synthetic-secret';
// Inject only the database boundary: HTTP uses a real PostgreSQL adapter.
const selector = require('../../models/pageRepository');
const originalFactory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = originalFactory;
let server;
let origin;

test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await repository.pool.end();
});
const etag = (id, revision) => `"content:${id}:${revision}"`;

async function createOverHttp(body) {
  const response = await fetch(`${origin}/api/pages/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ htmlContent: '<h1>ISSUE30 PG BASE</h1>', codeType: 'html', title: 'Pg base', ...body })
  });
  assert.equal(response.status, 200);
  return (await response.json()).urlId;
}

test('two racing content saves on one baseline produce one winner and one snapshot', async () => {
  const id = await createOverHttp({});
  const responses = await Promise.all(['<h1>RACE A</h1>', '<h1>RACE B</h1>'].map(htmlContent =>
    fetch(`${origin}/admin/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
      body: JSON.stringify({ htmlContent })
    })
  ));
  const statuses = responses.map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 412], 'exactly one old-baseline save may win');

  const winner = responses.find(response => response.status === 200);
  const loser = responses.find(response => response.status === 412);
  const loserBody = await loser.json();
  assert.equal(loserBody.code, 'CONTENT_REVISION_CONFLICT');
  const winnerBody = await winner.json();
  assert.equal(winnerBody.page.currentRevision, '2');
  assert.equal(loserBody.current.currentRevision, '2', 'conflict payload reports the remote pointer');
  assert.equal(loserBody.current.htmlContent, (await repository.getById(id)).html_content);

  const revisions = await repository.listContentRevisions(id);
  assert.equal(revisions.length, 2, 'one baseline + one winner snapshot');
  assert.equal((revisions.find(rev => rev.revision === '2')).html_content, winnerBody.page.htmlContent);
});

test('a real snapshot-write failure rolls back content, pointer and audit together', async () => {
  const id = await createOverHttp({});
  const observer = await repository.pool.connect();
  const beforeAudits = await repository.countAuditLogs();
  try {
    // Test-only fault injection on the snapshot INSERT itself: the materialized
    // write would succeed, so only a full rollback prevents a half commit.
    await observer.query(`
      CREATE FUNCTION issue30_snapshot_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue30 synthetic snapshot failure' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER issue30_snapshot_failure BEFORE INSERT ON share_revisions
      FOR EACH ROW WHEN (NEW.revision > 1) EXECUTE FUNCTION issue30_snapshot_failure();
    `);
    const failed = await fetch(`${origin}/admin/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
      body: JSON.stringify({ htmlContent: '<h1>NEVER SAVED</h1>' })
    });
    assert.equal(failed.status, 500);
    const page = await repository.getById(id);
    assert.equal(page.html_content, '<h1>ISSUE30 PG BASE</h1>', 'materialized body rolls back');
    assert.equal(page.current_revision, '1', 'current pointer rolls back');
    assert.equal(await repository.countAuditLogs(), beforeAudits, 'necessary audit rolls back with the snapshot');
    assert.equal((await repository.listContentRevisions(id)).length, 1);
  } finally {
    await observer.query('DROP TRIGGER IF EXISTS issue30_snapshot_failure ON share_revisions; DROP FUNCTION IF EXISTS issue30_snapshot_failure()');
    observer.release();
  }

  // After removing the fault the same baseline save succeeds end to end.
  const recovered = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
    body: JSON.stringify({ htmlContent: '<h1>RECOVERED</h1>' })
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).page.currentRevision, '2');
});

test('snapshot hash matches the shared canonical digest and provenance names the real paths', async () => {
  const { contentSnapshotHash } = require('../../utils/contentRevision');
  const id = await createOverHttp({});
  let revisions = await repository.listContentRevisions(id);
  assert.equal(revisions[0].source, 'web', 'browser creation names the web path');
  assert.equal(revisions[0].actor, null, 'no trusted individual identity is invented for web creates');
  assert.equal(revisions[0].restored_from, null, 'restore origin stays null without a restore entry point');
  assert.equal(revisions[0].snapshot_hash, contentSnapshotHash({
    htmlContent: '<h1>ISSUE30 PG BASE</h1>', codeType: 'html', title: 'Pg base', description: null, markdownTheme: null
  }), 'PG digest equals the shared canonical hash used by the Memory adapter');

  // The same canonical digest must hold for a CRLF body: original characters
  // (not normalized lines) enter the hash.
  const crlf = await createOverHttp({ htmlContent: 'CRLF\r\nbody\rmix' });
  const crlfRevs = await repository.listContentRevisions(crlf);
  assert.equal(crlfRevs[0].html_content, 'CRLF\r\nbody\rmix');
  assert.equal(crlfRevs[0].snapshot_hash, contentSnapshotHash({
    htmlContent: 'CRLF\r\nbody\rmix', codeType: 'html', title: 'Pg base', description: null, markdownTheme: null
  }));

  const updated = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
    body: JSON.stringify({ htmlContent: '<h1>OWNER PATH</h1>' })
  });
  assert.equal(updated.status, 200);
  revisions = await repository.listContentRevisions(id);
  assert.equal(revisions[1].source, 'dashboard-edit');
  assert.equal(revisions[1].actor, 'owner-dashboard');
  assert.equal(revisions[1].restored_from, null);
  assert.equal(revisions[1].snapshot_hash, contentSnapshotHash({
    htmlContent: '<h1>OWNER PATH</h1>', codeType: 'html', title: 'Pg base', description: null, markdownTheme: null
  }));
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('HTTP success is only sent after snapshot, projection and audit COMMIT', async () => {
  const id = await createOverHttp({});
  const observer = await repository.pool.connect();
  let pending;
  try {
    await observer.query(`
      CREATE FUNCTION issue30_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(20828012); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER issue30_commit_barrier AFTER INSERT ON share_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue30_commit_barrier();
    `);
    await observer.query('BEGIN');
    await observer.query('SELECT pg_advisory_xact_lock(20828012)');
    let settled = false;
    pending = fetch(`${origin}/admin/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
      body: JSON.stringify({ htmlContent: '<h1>BARRIER</h1>' })
    }).then(response => { settled = true; return response; });
    // Observe the writer waiting inside COMMIT, not before its writes.
    const deadline = Date.now() + 5000;
    let writerWaiting = false;
    while (Date.now() < deadline && !writerWaiting) {
      await observer.query('SELECT pg_stat_clear_snapshot()');
      const activity = await observer.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND position('COMMIT' in query) > 0`
      );
      writerWaiting = activity.rows[0].n > 0;
      if (!writerWaiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(writerWaiting, true, 'the save must reach COMMIT before responding');
    assert.equal(settled, false);
    assert.equal((await repository.getById(id)).current_revision, '1', 'nothing is visible before COMMIT');
    assert.equal((await repository.listContentRevisions(id)).length, 1);
    await observer.query('COMMIT');
    const response = await pending;
    pending = null;
    assert.equal(response.status, 200);
    assert.equal((await repository.getById(id)).current_revision, '2');
    assert.equal((await repository.listContentRevisions(id)).length, 2);
  } finally {
    await observer.query('DROP TRIGGER IF EXISTS issue30_commit_barrier ON share_revisions; DROP FUNCTION IF EXISTS issue30_commit_barrier()')
      .catch(() => {});
    if (pending) await pending.catch(() => {});
    observer.release();
  }
});

test('independent repository connections serialize on the content baseline', async () => {
  const id = await createOverHttp({});
  const connections = [await repository.pool.connect(), await repository.pool.connect()];
  try {
    assert.notEqual(
      (await connections[0].query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      (await connections[1].query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      'the race uses two independent backends'
    );
    const outcomes = await Promise.allSettled([
      repository.updatePage(id, { htmlContent: 'CONN A', expectedContentRevision: '1' }),
      repository.updatePage(id, { htmlContent: 'CONN B', expectedContentRevision: '1' })
    ]);
    assert.equal(outcomes.filter(entry => entry.status === 'fulfilled').length, 1);
    const conflict = outcomes.find(entry => entry.status === 'rejected');
    assert.equal(conflict.reason.code, 'CONTENT_REVISION_CONFLICT');
    assert.ok(conflict.reason.current, 'conflict carries the remote projection');

    // The winning connection holds the row lock only until its COMMIT; the
    // loser re-reading on a fresh statement sees the committed pointer.
    const stored = await repository.getById(id);
    assert.equal(stored.current_revision, '2');
    assert.equal((await repository.listContentRevisions(id)).length, 2);
  } finally {
    connections.forEach(connection => connection.release());
  }
});

test('combined baseline races reject atomically across both families', async () => {
  const id = await createOverHttp({});
  // Content baseline valid, access baseline stale: nothing may commit.
  await repository.updatePage(id, { isProtected: true, passwordHash: 'x', encryptedPassword: 'y', expectedAccessRevision: '1' });
  const combined = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': etag(id, '1') },
    body: JSON.stringify({ htmlContent: '<h1>COMBO RACE</h1>', revokeAccess: true, expectedAccessRevision: '1' })
  });
  assert.equal(combined.status, 412);
  assert.equal((await combined.json()).code, 'ACCESS_REVISION_CONFLICT');
  const page = await repository.getById(id);
  assert.equal(page.html_content, '<h1>ISSUE30 PG BASE</h1>', 'content half of the combo is not saved');
  assert.equal(page.current_revision, '1');
  assert.equal(page.access_revision, '2', 'access half of the combo is not saved');
});

test('revision arithmetic stays exact beyond the JavaScript safe-integer boundary', async () => {
  const { contentSnapshotHash } = require('../../utils/contentRevision');
  const id = 'issue30-pg-big-rev';
  await repository.create({ id, htmlContent: '<h1>BIG PG</h1>', createdAt: 1 });
  await repository.pool.query('UPDATE pages SET current_revision = 9007199254740993 WHERE id = $1', [id]);
  await repository.pool.query(
    `INSERT INTO share_revisions (share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
       snapshot_hash, source, actor, restored_from)
     VALUES ($1, 9007199254740993, '<h1>BIG PG</h1>', 'html', NULL, NULL, NULL, 1, $2, 'baseline-backfill', 'maintenance:baseline-backfill', NULL)`,
    [id, contentSnapshotHash({ htmlContent: '<h1>BIG PG</h1>', codeType: 'html', title: null, description: null, markdownTheme: null })]
  );

  const updated = await repository.updatePage(id, {
    htmlContent: '<h1>BIG PG 2</h1>', expectedContentRevision: '9007199254740993', returnUpdated: true
  });
  assert.equal(updated.current_revision, '9007199254740994', 'BIGINT arithmetic never passes through Number');
  const revisions = await repository.listContentRevisions(id);
  assert.deepEqual(revisions.map(rev => rev.revision), ['1', '9007199254740993', '9007199254740994']);
  assert.equal((revisions.find(rev => rev.revision === '9007199254740994')).html_content, '<h1>BIG PG 2</h1>');
});

test('policy, favorite and view-count writes leave the snapshot set unchanged', async () => {
  const id = await createOverHttp({});
  await repository.updatePage(id, { htmlContent: '<h1>V2</h1>', expectedContentRevision: '1' });
  const before = await repository.listContentRevisions(id);
  await repository.updatePage(id, { expiresAt: 9999999999999, expectedAccessRevision: '1' });
  await repository.setFavorite(id, true);
  await repository.recordViewEvent(id, Date.now(), '1');
  await repository.updateProtection(id, { revokeAccess: true, expectedAccessRevision: '2' });
  const after = await repository.listContentRevisions(id);
  assert.deepEqual(after, before, 'non-content writes never create or mutate snapshots');
  assert.equal((await repository.getById(id)).view_count, '1');
});
