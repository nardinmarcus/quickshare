// #38: managed-Key history/restore over real HTTP and PostgreSQL.
// Exercises BIGINT keyset ordering, conditional CAS/replay, two-backend races,
// and actual dashboard-purge/API-restore serialization in both lock orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');

const { validateCanonicalPostgresSuiteUrl } = require('../../scripts/release-readiness-check');
const url = validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue38-postgres-synthetic-session-secret';
process.env.SHARE_API_KEY = 'issue38-postgres-legacy-key';

const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');
const { contentSnapshotHash } = require('../../utils/contentRevision');
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '8',
  POSTGRES_STATEMENT_TIMEOUT_MS: '10000', POSTGRES_QUERY_TIMEOUT_MS: '11000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '20000'
});
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
  server = app.listen(Number(process.env.ISSUE38_HTTP_PORT || 57438), '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await repository.pool.end();
});

const LEGACY = process.env.SHARE_API_KEY;
const etag = (id, revision) => `"content:${id}:${revision}"`;
const jsonHeaders = { 'Content-Type': 'application/json' };

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : jsonHeaders), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result = null;
  try { result = JSON.parse(text); } catch { /* HTML response */ }
  return { status: response.status, headers: response.headers, text, body: result };
}

async function createShare({ title, htmlContent = `<h1>${title}</h1>`, codeType = 'html', markdownTheme = null } = {}) {
  const response = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': LEGACY },
    body: { htmlContent, codeType, title, markdownTheme }
  });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

async function createKey(name = 'issue38 PG key') {
  const response = await request('/admin/apis/keys', { method: 'POST', body: { name } });
  assert.equal(response.status, 201, response.text);
  return response.body.apiKey;
}

async function grantEdit(key, shareId) {
  const response = await request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', body: { shareId, canUpdate: true }
  });
  assert.equal(response.status, 201, response.text);
}

async function apiRestore(key, shareId, sourceRevision, currentRevision, requestId) {
  return request(`/api/v1/shares/${shareId}/restore`, {
    method: 'POST',
    headers: {
      'X-API-Key': key.secret,
      'If-Match': etag(shareId, currentRevision),
      'Idempotency-Key': requestId
    },
    body: { revision: String(sourceRevision) }
  });
}

async function dashboardPurge(shareId, revision) {
  return request(`/admin/pages/${shareId}/revisions/${revision}/purge`, {
    method: 'POST', body: { confirm: `${shareId}:${revision}` }
  });
}

async function updateWithKey(key, shareId, expectedRevision, requestId, body) {
  return request(`/api/v1/shares/${shareId}/content`, {
    method: 'PUT',
    headers: {
      'X-API-Key': key.secret,
      'If-Match': etag(shareId, expectedRevision),
      'Idempotency-Key': requestId
    },
    body
  });
}

async function waitForPageLockWaiters(minimum, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const result = await repository.pool.query(
      `SELECT pid, query FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%FROM pages WHERE id = $1 FOR UPDATE%'`
    );
    last = result.rows;
    const pids = new Set(last.map(row => String(row.pid)));
    if (pids.size >= minimum) return [...pids];
    await delay(20);
  }
  throw new Error(`expected ${minimum} page-lock waiters; observed ${JSON.stringify(last)}`);
}

async function withHeldShareLock(shareId, operation) {
  const blocker = await repository.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [shareId]);
    return await operation(blocker);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
}

async function interleaveEditDuringHistoryStatement(shareId, marker, advisoryParameter, sendRead) {
  const originalQuery = repository.pool.query.bind(repository.pool);
  const originalWithTransaction = repository.withTransaction.bind(repository);
  const lockKey = 3810380038;
  const blocker = await repository.pool.connect();
  const lock = await blocker.query('SELECT pg_backend_pid() AS pid, pg_advisory_lock($1::bigint) AS locked', [lockKey]);
  const blockerPid = String(lock.rows[0].pid);
  let lockHeld = true;
  let injected = false;
  let editorPid;
  let readPromise;

  repository.pool.query = (sql, values) => {
    if (!injected && typeof sql === 'string' && sql.includes(marker)) {
      injected = true;
      const gatedSql = sql.replace(
        /FROM pages p\s+WHERE p\.id = \$1/,
        `FROM pages p CROSS JOIN LATERAL (SELECT pg_advisory_xact_lock($${advisoryParameter}::bigint)) AS issue38_gate WHERE p.id = $1`
      );
      if (gatedSql === sql) throw new Error(`could not install controlled interleave for ${marker}`);
      return originalQuery(gatedSql, [...values, lockKey]);
    }
    return originalQuery(sql, values);
  };
  repository.withTransaction = operation => originalWithTransaction(async transaction => {
    if (!editorPid) {
      const pid = await transaction.pool.query('SELECT pg_backend_pid() AS pid');
      editorPid = String(pid.rows[0].pid);
    }
    return operation(transaction);
  });

  try {
    readPromise = sendRead();
    const deadline = Date.now() + 8000;
    let readerPid;
    while (Date.now() < deadline) {
      const waiters = await repository.pool.query(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock%'
           AND position($1 IN query) > 0`,
        [marker]
      );
      if (waiters.rowCount > 0) {
        readerPid = String(waiters.rows[0].pid);
        break;
      }
      await delay(20);
    }
    assert.ok(readerPid, `HTTP history statement did not wait at its controlled PostgreSQL interleave (${marker})`);
    assert.notEqual(readerPid, blockerPid, 'the HTTP reader and advisory-lock holder are separate PostgreSQL backends');

    const saved = await repository.updatePage(shareId, {
      htmlContent: '<h1>interleaved edit v2</h1>', title: 'Interleaved edit v2',
      expectedContentRevision: '1', returnUpdated: true
    });
    assert.equal(String(saved.current_revision), '2');
    assert.ok(editorPid && new Set([blockerPid, readerPid, editorPid]).size === 3,
      `lock holder, history reader and committed editor use independent PostgreSQL backends: ${blockerPid}/${readerPid}/${editorPid}`);

    const unlocked = await blocker.query('SELECT pg_advisory_unlock($1::bigint) AS released', [lockKey]);
    lockHeld = false;
    assert.equal(unlocked.rows[0].released, true);
    return { response: await readPromise, blockerPid, readerPid, editorPid };
  } finally {
    if (lockHeld) await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => {});
    repository.pool.query = originalQuery;
    repository.withTransaction = originalWithTransaction;
    if (readPromise) await readPromise.catch(() => {});
    blocker.release();
  }
}

function dropResponseAfterHeaders(path, body, headers) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const req = http.request(target, {
      method: 'POST',
      headers: { ...jsonHeaders, 'Content-Length': payload.length, ...headers }
    }, response => {
      // The application only writes response headers after transaction COMMIT.
      const status = response.statusCode;
      response.destroy();
      resolve(status);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('history list current flags stay coherent with a concurrent committed edit', async (t) => {
  const key = await createKey('issue38 PG interleaved list');
  const share = await createShare({ title: 'Interleaved list v1' });
  await grantEdit(key, share.urlId);
  const { response, blockerPid, readerPid, editorPid } = await interleaveEditDuringHistoryStatement(
    share.urlId,
    'api_revision_history_page AS MATERIALIZED',
    4,
    () => request(`/api/v1/shares/${share.urlId}/revisions`, { headers: { 'X-API-Key': key.secret } })
  );
  t.diagnostic(`single-statement list snapshot PIDs: lock holder ${blockerPid}, reader ${readerPid}, editor ${editorPid}`);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.revisions.map(row => row.revision), ['1'],
    'the history statement sees the pointer and revisions from its pre-edit snapshot');
  assert.equal(response.body.revisions[0].current, true);
  assert.equal((await repository.getById(share.urlId)).current_revision, '2');
});

test('single revision current flag stays coherent with a concurrent committed edit', async (t) => {
  const key = await createKey('issue38 PG interleaved single');
  const share = await createShare({ title: 'Interleaved single v1' });
  await grantEdit(key, share.urlId);
  const { response, blockerPid, readerPid, editorPid } = await interleaveEditDuringHistoryStatement(
    share.urlId,
    'api_revision_single_page AS MATERIALIZED',
    3,
    () => request(`/api/v1/shares/${share.urlId}/revisions/1`, { headers: { 'X-API-Key': key.secret } })
  );
  t.diagnostic(`single-statement snapshot PIDs: lock holder ${blockerPid}, reader ${readerPid}, editor ${editorPid}`);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.revision.revision, '1');
  assert.equal(response.body.revision.current, true,
    'the snapshot read returns the source snapshot and its pointer from one statement');
  assert.equal((await repository.getById(share.urlId)).current_revision, '2');
});

test('Key history is metadata-only, grant-bounded, exact-BIGINT keyset paginated, and tombstone-safe', async () => {
  const key = await createKey('issue38 PG history');
  const share = await createShare({ title: 'PG history v1', htmlContent: '<p>PG38-OLD-BODY</p>' });
  const other = await createShare({ title: 'PG history hidden' });
  const route = `/api/v1/shares/${share.urlId}/revisions`;

  assert.equal((await request(route)).status, 401, 'cookies/no credential never authorize history');
  const scopeDenied = await request(route, { headers: { 'X-API-Key': key.secret } });
  assert.equal(scopeDenied.status, 403, 'create-only key has no read scope');
  await grantEdit(key, share.urlId);

  const hidden = await request(`/api/v1/shares/${other.urlId}/revisions`, { headers: { 'X-API-Key': key.secret } });
  const missing = await request('/api/v1/shares/issue38-missing/revisions', { headers: { 'X-API-Key': key.secret } });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, missing.body.code, 'ungranted and missing Share are indistinguishable');

  await repository.updatePage(share.urlId, {
    htmlContent: '<p>PG38-CURRENT-BODY</p>', title: 'PG history current', expectedContentRevision: '1', returnUpdated: true
  });
  const current = await repository.getById(share.urlId);
  const hugeBefore = '9007199254740992';
  const hugeCurrent = '9007199254740993';
  const highSnapshot = {
    htmlContent: current.html_content, codeType: current.code_type, title: current.title,
    description: current.description, markdownTheme: current.markdown_theme
  };
  const previousSnapshot = {
    htmlContent: '<p>PG38-BIGINT-PREVIOUS</p>', codeType: current.code_type,
    title: 'PG history huge predecessor', description: null, markdownTheme: null
  };
  await repository.pool.query('UPDATE pages SET current_revision = $2::bigint WHERE id = $1', [share.urlId, hugeCurrent]);
  for (const [revision, snapshot] of [[hugeBefore, previousSnapshot], [hugeCurrent, highSnapshot]]) {
    await repository.pool.query(
      `INSERT INTO share_revisions (
         share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
         snapshot_hash, source, actor, restored_from
       ) VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, 'api-content-update', 'api-key:fixture', NULL)`,
      [share.urlId, revision, snapshot.htmlContent, snapshot.codeType, snapshot.title, snapshot.description,
        snapshot.markdownTheme, Date.now(), contentSnapshotHash(snapshot)]
    );
  }

  const first = await request(`${route}?limit=1`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.body.revisions[0].revision, hugeCurrent);
  assert.equal(first.body.revisions[0].current, true);
  const second = await request(`${route}?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(second.body.revisions[0].revision, hugeBefore, 'cursor order never passes BIGINT through Number/string sorting');
  const third = await request(`${route}?limit=1&cursor=${encodeURIComponent(second.body.nextCursor)}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(third.body.revisions[0].revision, '2');
  const fourth = await request(`${route}?limit=1&cursor=${encodeURIComponent(third.body.nextCursor)}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(fourth.body.revisions[0].revision, '1');
  assert.equal(fourth.body.nextCursor, undefined);
  for (const row of first.body.revisions) {
    for (const forbidden of ['htmlContent', 'title', 'description', 'snapshotHash', 'actor', 'favorite', 'grants']) {
      assert.equal(forbidden in row, false, `metadata page excludes ${forbidden}`);
    }
  }
  const single = await request(`${route}/${hugeCurrent}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(single.status, 200);
  assert.equal(single.body.revision.revision, hugeCurrent);
  assert.equal(single.body.revision.htmlContent, '<p>PG38-CURRENT-BODY</p>');

  const publicView = await request(`/view/${share.urlId}`);
  assert.equal(publicView.status, 200, 'public view remains a separate, existing surface');
  assert.match(publicView.text, /PG38-CURRENT-BODY/);
  assert.doesNotMatch(publicView.text, /PG38-OLD-BODY/, 'public reads never aggregate history');

  const restored = await apiRestore(key, share.urlId, '1', hugeCurrent, 'issue38-bigint-restore-0001');
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body.page.currentRevision, '9007199254740994');
  assert.equal(restored.body.page.htmlContent, '<p>PG38-OLD-BODY</p>');

  // Dashboard purge is the real existing route, not a fabricated DB tombstone.
  const purge = await dashboardPurge(share.urlId, hugeBefore);
  assert.equal(purge.status, 200, purge.text);
  const tombstone = await request(`${route}/${hugeBefore}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(tombstone.status, 410);
  assert.equal(tombstone.body.code, 'REVISION_PURGED');
  for (const forbidden of ['PG38-BIGINT-PREVIOUS', 'htmlContent', 'title', 'snapshotHash']) {
    assert.equal(tombstone.text.includes(forbidden), false, `410 excludes ${forbidden}`);
  }
  const purgedSource = await apiRestore(key, share.urlId, hugeBefore, '9007199254740994', 'issue38-purged-source-0001');
  assert.equal(purgedSource.status, 410);
  assert.equal(purgedSource.body.code, 'REVISION_PURGED');
});

test('lost restore response replays original result before stale CAS; source purge closes replay/status', async () => {
  const key = await createKey('issue38 PG replay');
  const share = await createShare({ title: 'PG replay v1', htmlContent: '# replay v1\r\nbody', codeType: 'markdown', markdownTheme: 'github' });
  await grantEdit(key, share.urlId);
  const saved = await repository.updatePage(share.urlId, {
    htmlContent: '# replay v2\nbody', title: 'PG replay v2', description: 'revision two', markdownTheme: 'claude',
    expectedContentRevision: '1', returnUpdated: true
  });
  assert.equal(saved.current_revision, '2');

  const requestId = 'issue38-http-loss-replay-0001';
  const lostStatus = await dropResponseAfterHeaders(`/api/v1/shares/${share.urlId}/restore`, { revision: '1' }, {
    'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '2'), 'Idempotency-Key': requestId
  });
  assert.equal(lostStatus, 200, 'response was deliberately dropped only after successful response headers');
  const storedOperation = await repository.findPublishingOperation(`managed-key:${key.id}`, requestId);
  assert.ok(storedOperation, 'operation receipt committed before the response was dropped');

  const noop = await apiRestore(key, share.urlId, '1', '3', 'issue38-pg-restore-noop-0001');
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);
  assert.equal(noop.body.page.currentRevision, '3');
  assert.equal((await repository.getById(share.urlId)).current_revision, '3', 'PostgreSQL no-op creates no content revision');

  await repository.updatePage(share.urlId, {
    htmlContent: '# later v4', title: 'PG replay later', markdownTheme: 'github', expectedContentRevision: '3'
  });
  const retry = await apiRestore(key, share.urlId, '1', '2', requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.page.currentRevision, '3');
  assert.equal(retry.body.page.htmlContent, '# replay v1\r\nbody');
  assert.equal(retry.body.page.markdownTheme, 'github');

  const status = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(status.status, 200);
  assert.equal(status.body.operations[0].action, 'restore');
  assert.equal(status.body.operations[0].revision, '3');
  for (const forbidden of ['replay v1', 'sourceRevision', 'htmlContent', 'title', 'receipt']) {
    assert.equal(status.text.includes(forbidden), false, `restore status excludes ${forbidden}`);
  }
  const otherKey = await createKey('issue38 PG other namespace');
  const foreign = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': otherKey.secret } });
  assert.equal(foreign.status, 404, 'operation status is namespace-bound');

  const resultRevision = await request(`/api/v1/shares/${share.urlId}/revisions/3`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(resultRevision.status, 200);
  const purge = await dashboardPurge(share.urlId, '3');
  assert.equal(purge.status, 200, purge.text);
  assert.equal((await request(`/api/v1/shares/${share.urlId}/revisions/1`, { headers: { 'X-API-Key': key.secret } })).status, 200,
    'the source remains live while the committed result is purged');
  const replayAfterPurge = await apiRestore(key, share.urlId, '1', '2', requestId);
  assert.equal(replayAfterPurge.status, 410);
  assert.equal(replayAfterPurge.body.code, 'RESULT_UNAVAILABLE');
  for (const forbidden of ['replay v1', 'htmlContent', 'title', 'receipt', 'sourceRevision']) {
    assert.equal(replayAfterPurge.text.includes(forbidden), false);
  }
  const statusAfterPurge = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(statusAfterPurge.status, 410);
  assert.equal(statusAfterPurge.body.code, 'RESULT_UNAVAILABLE');
  const noopStatusAfterPurge = await request('/api/v1/operations/issue38-pg-restore-noop-0001', { headers: { 'X-API-Key': key.secret } });
  assert.equal(noopStatusAfterPurge.status, 410, 'purging a no-op result revision also closes its receipt');
});

test('API and Dashboard restores from one baseline serialize on two PostgreSQL backends', async (t) => {
  const key = await createKey('issue38 PG restore race');
  const share = await createShare({ title: 'PG race v1' });
  await grantEdit(key, share.urlId);
  await repository.updatePage(share.urlId, { htmlContent: '<h1>PG race v2</h1>', expectedContentRevision: '1' });

  const responses = await withHeldShareLock(share.urlId, async blocker => {
    const api = apiRestore(key, share.urlId, '1', '2', 'issue38-race-api-restore-0001');
    await waitForPageLockWaiters(1);
    const dashboard = request(`/admin/pages/${share.urlId}/restore`, {
      method: 'POST', headers: { 'Idempotency-Key': 'issue38-race-dashboard-0001', 'If-Match': etag(share.urlId, '2') },
      body: { revision: '1' }
    });
    const pids = await waitForPageLockWaiters(2);
    assert.ok(new Set(pids).size >= 2, `two independent PostgreSQL backend PIDs waited: ${pids.join(',')}`);
    t.diagnostic(`same-baseline API/Dashboard restore lock waiters: backend PIDs ${pids.join(', ')}`);
    await blocker.query('COMMIT');
    return Promise.all([api, dashboard]);
  });
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
  const finalPage = await repository.getById(share.urlId);
  assert.equal(finalPage.current_revision, '3', 'exactly one winner created a content revision');
});

test('dashboard purge and Key restore serialize both ways on real PostgreSQL locks', async (t) => {
  const key = await createKey('issue38 PG purge race');
  const scenarios = [
    { name: 'restore-first', expectRestore: 200, expectPurge: 200 },
    { name: 'purge-first', expectRestore: 410, expectPurge: 200 }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const share = await createShare({ title: `PG purge race ${scenario.name}`, htmlContent: `<h1>${scenario.name} v1</h1>` });
    await grantEdit(key, share.urlId);
    await repository.updatePage(share.urlId, {
      htmlContent: `<h1>${scenario.name} v2</h1>`, expectedContentRevision: '1'
    });
    const requestId = `issue38-purge-race-${scenario.name}-0001`;

    const [restore, purge] = await withHeldShareLock(share.urlId, async blocker => {
      let restorePromise;
      let purgePromise;
      if (index === 0) {
        restorePromise = apiRestore(key, share.urlId, '1', '2', requestId);
        await waitForPageLockWaiters(1);
        purgePromise = dashboardPurge(share.urlId, '1');
      } else {
        purgePromise = dashboardPurge(share.urlId, '1');
        await waitForPageLockWaiters(1);
        restorePromise = apiRestore(key, share.urlId, '1', '2', requestId);
      }
      const pids = await waitForPageLockWaiters(2);
      assert.ok(new Set(pids).size >= 2, `${scenario.name}: independent backend PIDs ${pids.join(',')}`);
      t.diagnostic(`${scenario.name} purge/restore lock waiters: backend PIDs ${pids.join(', ')}`);
      await blocker.query('COMMIT');
      return Promise.all([restorePromise, purgePromise]);
    });

    assert.equal(restore.status, scenario.expectRestore, `${scenario.name} restore: ${restore.text}`);
    assert.equal(purge.status, scenario.expectPurge, `${scenario.name} purge: ${purge.text}`);
    if (scenario.name === 'restore-first') {
      assert.equal(restore.body.changed, true);
      const closedReplay = await apiRestore(key, share.urlId, '1', '2', requestId);
      assert.equal(closedReplay.status, 410, 'purging the committed source closes replay');
      assert.equal(closedReplay.body.code, 'RESULT_UNAVAILABLE');
      const closedStatus = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
      assert.equal(closedStatus.status, 410, 'restore status also requires source availability');
      assert.equal(closedStatus.body.code, 'RESULT_UNAVAILABLE');
      assert.doesNotMatch(closedStatus.text, /sourceRevision|htmlContent|title|receipt/);
    } else {
      assert.equal(restore.body.code, 'REVISION_PURGED', 'purge winner makes the source unavailable before restore CAS');
    }
  }
});
