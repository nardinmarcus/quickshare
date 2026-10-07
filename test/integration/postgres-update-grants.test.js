// #37 native PostgreSQL integration: atomic auto-edit grants, credential and
// grant revocation races, and conditional updates on distinct backend PIDs.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');

const { validateCanonicalPostgresSuiteUrl } = require('../../scripts/release-readiness-check');
const url = validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '8', POSTGRES_STATEMENT_TIMEOUT_MS: '8000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000', POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue37-pg-legacy-key';
process.env.SESSION_SECRET = 'issue37-postgres-update-session-secret';
const selector = require('../../models/pageRepository');
const factory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = factory;

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

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function createKey(name) {
  const result = await request('/admin/apis/keys', { method: 'POST', body: { name } });
  assert.equal(result.status, 201);
  return result.body.apiKey;
}

async function createShare(title) {
  const result = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent: `<h1>${title}</h1>\r\n<p>original</p>`, codeType: 'html', title }
  });
  assert.equal(result.status, 200);
  return result.body;
}

async function grantEdit(key, shareId) {
  return request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', body: { shareId, canUpdate: true }
  });
}

async function setAutoGrant(key, enabled) {
  return request(`/admin/apis/keys/${key.id}/auto-grant-edit`, { method: 'PUT', body: { enabled } });
}

async function getContent(key, shareId) {
  return request(`/api/v1/shares/${shareId}/content`, { headers: { 'X-API-Key': key } });
}

function apiUpdate(key, shareId, etag, requestId, htmlContent) {
  return request(`/api/v1/shares/${shareId}/content`, {
    method: 'PUT',
    headers: { 'X-API-Key': key, 'If-Match': etag, 'Idempotency-Key': requestId },
    body: { htmlContent, title: 'PG update', description: null, markdownTheme: null }
  });
}

async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: condition was not reached`);
}

async function waitForLock(observer, sqlFragment) {
  await until(async () => {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    return (await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1",
      [`%${sqlFragment}%`]
    )).rowCount > 0;
  }, `lock wait for ${sqlFragment}`);
  const waiting = await observer.query(
    "SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1 LIMIT 1",
    [`%${sqlFragment}%`]
  );
  return Number(waiting.rows[0].pid);
}

function unfinishedPut(path, headers, body) {
  const data = JSON.stringify(body);
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const pending = http.request(origin + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
  }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => {
      let json = null;
      try { json = JSON.parse(text); } catch { /* response body may be non-JSON */ }
      resolveResult({ status: response.statusCode, text, body: json });
    });
  });
  pending.on('error', rejectResult);
  pending.flushHeaders();
  return { finish: () => pending.end(data), result };
}

async function waitForKeyUse(keyId) {
  await until(async () => Number((await repository.pool.query(
    'SELECT last_used_at FROM api_keys WHERE id = $1', [keyId]
  )).rows[0]?.last_used_at) > 1, `key ${keyId} authentication`);
}

test('auto-edit grant, scopes and create operation commit atomically; legacy stays create-only', async () => {
  const key = await createKey('PG atomic auto-edit');
  const preexisting = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': key.secret },
    body: { htmlContent: '<h1>before auto-edit</h1>', codeType: 'html', title: 'before auto-edit' }
  });
  assert.equal(preexisting.status, 200);
  assert.equal(await repository.getShareGrant(key.id, preexisting.body.urlId), null);
  const enabled = await setAutoGrant(key, true);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.autoGrantNewShareEdit, true);
  assert.equal(await repository.getShareGrant(key.id, preexisting.body.urlId), null,
    'enabling only affects subsequent managed creations');

  const before = await repository.pool.query(`
    SELECT (SELECT COUNT(*)::int FROM pages) AS pages,
           (SELECT COUNT(*)::int FROM share_revisions) AS revisions,
           (SELECT COUNT(*)::int FROM audit_logs) AS audits,
           (SELECT COUNT(*)::int FROM publish_operations) AS operations
  `);
  const grantMethod = repository.grantShareEdit;
  repository.grantShareEdit = async () => { throw new Error('synthetic #37 edit-grant transaction failure'); };
  let failed;
  try {
    failed = await request('/api/v1/share', {
      method: 'POST',
      headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-pg-rollback-0001' },
      body: { htmlContent: '<h1>rollback me</h1>', codeType: 'html', title: 'rollback me' }
    });
  } finally {
    repository.grantShareEdit = grantMethod;
  }
  assert.equal(failed.status, 500);
  const afterFailure = await repository.pool.query(`
    SELECT (SELECT COUNT(*)::int FROM pages) AS pages,
           (SELECT COUNT(*)::int FROM share_revisions) AS revisions,
           (SELECT COUNT(*)::int FROM audit_logs) AS audits,
           (SELECT COUNT(*)::int FROM publish_operations) AS operations
  `);
  assert.deepEqual(afterFailure.rows[0], before.rows[0], 'page, baseline revision, audit and idempotency all rolled back');
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue37-pg-rollback-0001'), null);
  assert.deepEqual((await repository.getApiKeyById(key.id)).scopes, ['share:create']);

  const retry = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-pg-rollback-0001' },
    body: { htmlContent: '<h1>rollback me</h1>', codeType: 'html', title: 'rollback me' }
  });
  assert.equal(retry.status, 200);
  const autoGrant = await repository.getShareGrant(key.id, retry.body.urlId);
  assert.deepEqual({ read: autoGrant.can_read, update: autoGrant.can_update, publish: autoGrant.can_publish },
    { read: true, update: true, publish: false });
  assert.deepEqual([...(await repository.getApiKeyById(key.id)).scopes].sort(),
    ['share:create', 'share:read', 'share:update']);

  const legacy = await createShare('legacy is not auto-granted');
  assert.equal(await repository.getShareGrant(key.id, legacy.urlId), null,
    'legacy API creation never inherits a managed Key auto-grant setting');
  const disabled = await setAutoGrant(key, false);
  assert.equal(disabled.status, 200);
  assert.equal((await repository.getShareGrant(key.id, retry.body.urlId)).can_update, true,
    'disabling auto-edit preserves existing explicit grants');
});

test('API/API and dashboard/API updates serialize across distinct PostgreSQL PIDs on one baseline', async () => {
  const key = await createKey('PG update race');
  const apiApiShare = await createShare('PG API/API race');
  assert.equal((await grantEdit(key, apiApiShare.urlId)).status, 201);
  const apiApiBase = await getContent(key.secret, apiApiShare.urlId);
  const apiApiPath = `/api/v1/shares/${apiApiShare.urlId}/content`;
  const observer = await repository.pool.connect();
  const originalUpdatePage = repository.updatePage;
  let reached;
  const atUpdate = new Promise(resolve => { reached = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let firstPid;
  repository.updatePage = async function (id, options) {
    if (id === apiApiShare.urlId && options.actorSource === 'api-content-update') {
      firstPid = Number((await this.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      reached();
      await held;
    }
    return originalUpdatePage.call(this, id, options);
  };
  let firstRequest;
  let secondRequest;
  try {
    firstRequest = apiUpdate(key.secret, apiApiShare.urlId, apiApiBase.headers.get('etag'), 'issue37-pg-api-race-0001', '<h1>first API</h1>');
    await atUpdate;
    secondRequest = apiUpdate(key.secret, apiApiShare.urlId, apiApiBase.headers.get('etag'), 'issue37-pg-api-race-0002', '<h1>second API</h1>');
    const secondPid = await waitForLock(observer, 'SELECT credential_version FROM api_keys WHERE id = $1 FOR UPDATE');
    assert.notEqual(secondPid, firstPid, 'the two HTTP writes occupy distinct PostgreSQL backends');
    release();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal([first, second].filter(result => result.status === 200).length, 1);
    assert.equal([first, second].filter(result => result.status === 412).length, 1);
  } finally {
    release();
    repository.updatePage = originalUpdatePage;
    observer.release();
    await Promise.allSettled([firstRequest, secondRequest]);
  }

  const mixedShare = await createShare('PG dashboard/API race');
  assert.equal((await grantEdit(key, mixedShare.urlId)).status, 201);
  const mixedBase = await getContent(key.secret, mixedShare.urlId);
  const mixedPath = `/api/v1/shares/${mixedShare.urlId}/content`;
  const mixedObserver = await repository.pool.connect();
  const originalMixedUpdatePage = repository.updatePage;
  let mixedReached;
  const mixedAtUpdate = new Promise(resolve => { mixedReached = resolve; });
  let mixedRelease;
  const mixedHeld = new Promise(resolve => { mixedRelease = resolve; });
  let apiPid;
  let dashboardPid;
  repository.updatePage = async function (id, options) {
    if (id === mixedShare.urlId) {
      const pid = Number((await this.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      if (options.actorSource === 'api-content-update') {
        apiPid = pid;
        mixedReached();
        await mixedHeld;
      } else if (options.actorSource === 'dashboard-edit') {
        dashboardPid = pid;
      }
    }
    return originalMixedUpdatePage.call(this, id, options);
  };
  let apiRequest;
  let dashboardRequest;
  try {
    apiRequest = apiUpdate(key.secret, mixedShare.urlId, mixedBase.headers.get('etag'), 'issue37-pg-mixed-api-0001', '<h1>API wins</h1>');
    await mixedAtUpdate;
    dashboardRequest = request(`/admin/pages/${mixedShare.urlId}`, {
      method: 'PUT',
      headers: { 'If-Match': mixedBase.headers.get('etag'), 'Idempotency-Key': 'issue37-pg-mixed-dashboard-0001' },
      body: { htmlContent: '<h1>dashboard loses</h1>', title: 'dashboard', description: null, markdownTheme: null }
    });
    dashboardPid = await waitForLock(mixedObserver, 'SELECT * FROM pages WHERE id = $1 FOR UPDATE');
    assert.notEqual(dashboardPid, apiPid, 'dashboard and API writes use distinct PostgreSQL backends');
    mixedRelease();
    const [api, dashboardResult] = await Promise.all([apiRequest, dashboardRequest]);
    assert.equal(api.status, 200, 'the write holding the Share baseline lock commits');
    assert.equal(dashboardResult.status, 412, 'the queued dashboard write sees a stale content baseline');
  } finally {
    mixedRelease();
    repository.updatePage = originalMixedUpdatePage;
    mixedObserver.release();
    await Promise.allSettled([apiRequest, dashboardRequest]);
  }
});

test('Key rotation and edit-grant revocation win before held update bodies commit', async () => {
  const key = await createKey('PG credential race');
  const share = await createShare('PG credential race target');
  assert.equal((await grantEdit(key, share.urlId)).status, 201);
  const baseline = await getContent(key.secret, share.urlId);
  const body = { htmlContent: '<h1>must not commit</h1>', title: 'race', description: null, markdownTheme: null };
  await repository.pool.query('UPDATE api_keys SET last_used_at = 1 WHERE id = $1', [key.id]);

  const heldRotation = unfinishedPut(`/api/v1/shares/${share.urlId}/content`, {
    'X-API-Key': key.secret, 'If-Match': baseline.headers.get('etag'), 'Idempotency-Key': 'issue37-pg-rotation-race-0001'
  }, body);
  await waitForKeyUse(key.id);
  const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  heldRotation.finish();
  const rejectedOldKey = await heldRotation.result;
  assert.equal(rejectedOldKey.status, 401, 'Key lock rechecks credential_version after rotation');
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue37-pg-rotation-race-0001'), null);
  const afterRotation = await getContent(rotated.body.apiKey.secret, share.urlId);
  assert.equal(afterRotation.body.revision, '1', 'rejected old credential did not mutate content');
  assert.equal((await repository.getShareGrant(key.id, share.urlId)).can_update, true, 'rotation preserves edit grant');

  const current = await getContent(rotated.body.apiKey.secret, share.urlId);
  await repository.pool.query('UPDATE api_keys SET last_used_at = 1 WHERE id = $1', [key.id]);
  const heldRevoke = unfinishedPut(`/api/v1/shares/${share.urlId}/content`, {
    'X-API-Key': rotated.body.apiKey.secret, 'If-Match': current.headers.get('etag'), 'Idempotency-Key': 'issue37-pg-revoke-race-0001'
  }, body);
  await waitForKeyUse(key.id);
  const revoke = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', body: { canUpdate: false }
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.grant.canRead, true);
  assert.equal(revoke.body.grant.canUpdate, false);
  heldRevoke.finish();
  const rejectedGrant = await heldRevoke.result;
  assert.equal(rejectedGrant.status, 404, 'current grant is rechecked inside the write transaction');
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue37-pg-revoke-race-0001'), null);
  const final = await getContent(rotated.body.apiKey.secret, share.urlId);
  assert.equal(final.body.revision, '1', 'revoked update grant cannot mutate content');
});
