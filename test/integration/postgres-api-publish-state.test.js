// #39 native PostgreSQL integration: exact access BIGINTs, transactional
// publish operations, replays, revocation/rotation races and shared #35 CAS.
const { validatePostgresTestUrl } = require('../../scripts/release-readiness-check');
const url = validatePostgresTestUrl(process.env.POSTGRES_TEST_URL);
if (decodeURIComponent(url.pathname.slice(1)) !== 'issue39_api_publish_test') {
  throw new Error('POSTGRES_TEST_URL must name the actor-owned localhost issue39_api_publish_test database');
}

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue39-pg-legacy-key';
process.env.SESSION_SECRET = 'issue39-postgres-publish-state-session-secret';
process.env.SHARE_BASE_URL = 'https://share.issue39.invalid';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';

const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '10',
  POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});
const selector = require('../../models/pageRepository');
const originalFactory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = originalFactory;

const HTTP_PORT = 57439;
let server;
let origin;
test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  server = app.listen(HTTP_PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${HTTP_PORT}`;
});
test.after(async () => {
  await new Promise(resolve => server?.close(resolve));
  await repository.pool.end();
});

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  let requestBody;
  if (body !== undefined) {
    requestHeaders['Content-Type'] ||= 'application/json';
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(origin + path, {
    method, headers: requestHeaders, body: requestBody, redirect: 'manual'
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function createKey(name) {
  const created = await request('/admin/apis/keys', { method: 'POST', body: { name } });
  assert.equal(created.status, 201);
  return created.body.apiKey;
}

async function createShare(title, extra = {}) {
  const created = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent: `<h1>${title}</h1><p>PG_PUBLISH_SECRET_BODY</p>`, codeType: 'html', title, ...extra }
  });
  assert.equal(created.status, 200);
  return created.body;
}

async function grant(key, shareId, permissions = {}) {
  return request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', body: { shareId, ...permissions }
  });
}

async function state(key, shareId) {
  return request(`/api/v1/shares/${shareId}/state`, { headers: { 'X-API-Key': key } });
}

async function transition(key, shareId, action, etag, requestId, body = {}) {
  return request(`/api/v1/shares/${shareId}/${action}`, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      ...(etag === undefined ? {} : { 'If-Match': etag }),
      ...(requestId === undefined ? {} : { 'Idempotency-Key': requestId })
    },
    body
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
  }, `database lock on ${sqlFragment}`);
  const result = await observer.query(
    "SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1 LIMIT 1",
    [`%${sqlFragment}%`]
  );
  return Number(result.rows[0].pid);
}

function unfinishedPublish(path, headers, body = {}) {
  const data = JSON.stringify(body);
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const pending = http.request(origin + path, {
    method: 'POST',
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

const accessBase = '9007199254740993';
const accessNext = '9007199254740994';
const accessNextNext = '9007199254740995';

test('publish-only grant is independent, has exact state permission and first/last scope lifecycle', async () => {
  const key = await createKey('PG publish-only scope lifecycle');
  const share = await createShare('PG publish-only protected', { isProtected: true });
  assert.deepEqual(key.scopes, ['share:create']);
  const granted = await grant(key, share.urlId, { canPublish: true });
  assert.equal(granted.status, 201);
  assert.deepEqual(granted.body.scopes, ['share:create', 'share:publish']);
  assert.deepEqual(granted.body.grant, {
    apiKeyId: key.id, shareId: share.urlId, canRead: false, canUpdate: false, canPublish: true
  });

  const current = await state(key.secret, share.urlId);
  assert.equal(current.status, 200);
  assert.deepEqual(Object.keys(current.body).sort(), ['success', 'id', 'published', 'isProtected', 'expiresAt', 'accessRevision', 'url'].sort());
  assert.equal(current.body.url, `https://share.issue39.invalid/view/${encodeURIComponent(share.urlId)}`);
  assert.equal(current.body.expiresAt, null, 'an unset expiry is represented as JSON null');
  assert.match(current.headers.get('etag'), new RegExp(`^"access:${share.urlId}:1"$`));
  for (const path of [
    '/api/v1/shares',
    `/api/v1/shares/${share.urlId}/content`,
    `/api/v1/shares/${share.urlId}/revisions`
  ]) assert.equal((await request(path, { headers: { 'X-API-Key': key.secret } })).status, 403, `${path} has no read scope`);

  const changed = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', body: { canPublish: false }
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.grant, null, 'revoking the only permission removes the empty grant');
  assert.deepEqual(changed.body.scopes, ['share:create']);
  assert.equal((await state(key.secret, share.urlId)).status, 403, 'last publish grant removes the state scope');

  const audits = await repository.pool.query(
    "SELECT action FROM audit_logs WHERE page_id = $1 AND action LIKE 'api_key.%' ORDER BY id", [share.urlId]
  );
  assert.deepEqual(audits.rows.map(row => row.action), ['api_key.grant', 'api_key.revoke']);
});

test('exact BIGINT access ETags, no-op and replay do not touch content/policy or leak stale state', async () => {
  const key = await createKey('PG publish replay exact version');
  const share = await createShare('PG publish replay protected', { isProtected: true });
  const granted = await grant(key, share.urlId, { canPublish: true });
  assert.equal(granted.status, 201);
  await repository.pool.query('UPDATE pages SET access_revision = $2::bigint WHERE id = $1', [share.urlId, accessBase]);
  const before = (await repository.pool.query(
    'SELECT current_revision, access_revision, password_hash, encrypted_password, expires_at, published FROM pages WHERE id = $1', [share.urlId]
  )).rows[0];
  const unlocked = await request(`/view/${share.urlId}/password`, { method: 'POST', body: { password: share.password } });
  assert.equal(unlocked.status, 200);
  const oldCookie = unlocked.headers.get('set-cookie').split(';')[0];

  const current = await state(key.secret, share.urlId);
  assert.equal(current.body.accessRevision, accessBase);
  assert.equal(current.headers.get('etag'), `"access:${share.urlId}:${accessBase}"`);
  const unpublish = await transition(key.secret, share.urlId, 'unpublish', current.headers.get('etag'), 'issue39-pg-exact-unpublish-001');
  assert.equal(unpublish.status, 200);
  assert.equal(unpublish.body.accessRevision, accessNext, 'BIGINT increment is exact beyond 2^53');
  assert.equal(unpublish.body.published, false);
  const replay = await transition(key.secret, share.urlId, 'unpublish', current.headers.get('etag'), 'issue39-pg-exact-unpublish-001');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.accessRevision, accessNext);
  assert.equal(replay.body.published, false);
  assert.equal((await request(`/view/${share.urlId}`, { headers: { Cookie: oldCookie } })).status, 404,
    'a real access-revision transition rejects the old protected-page cookie');

  const noOpState = await state(key.secret, share.urlId);
  const auditsBeforeNoOp = Number((await repository.pool.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = 'page.unpublish'", [share.urlId]
  )).rows[0].count);
  const noOp = await transition(key.secret, share.urlId, 'unpublish', noOpState.headers.get('etag'), 'issue39-pg-unpublish-noop-001');
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.changed, false);
  assert.equal(noOp.body.accessRevision, accessNext);
  assert.equal(Number((await repository.pool.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = 'page.unpublish'", [share.urlId]
  )).rows[0].count), auditsBeforeNoOp, 'same-state no-op writes no duplicate audit');

  const republish = await transition(key.secret, share.urlId, 'republish', noOp.headers.get('etag'), 'issue39-pg-republish-next-001');
  assert.equal(republish.status, 200);
  assert.equal(republish.body.published, true);
  assert.equal(republish.body.isProtected, true, 'republish does not remove protection');
  assert.equal(republish.body.accessRevision, accessNextNext);
  const staleReplay = await transition(key.secret, share.urlId, 'unpublish', current.headers.get('etag'), 'issue39-pg-exact-unpublish-001');
  assert.equal(staleReplay.status, 200);
  assert.equal(staleReplay.body.stateChangedSinceCommit, true);
  assert.equal('published' in staleReplay.body, false);
  assert.equal('accessRevision' in staleReplay.body, false);
  const status = await request('/api/v1/operations/issue39-pg-exact-unpublish-001', { headers: { 'X-API-Key': key.secret } });
  assert.equal(status.status, 200);
  assert.equal(status.body.operations[0].stateChangedSinceCommit, true);
  assert.equal('accessRevision' in status.body.operations[0], false);

  const after = (await repository.pool.query(
    'SELECT current_revision, access_revision, password_hash, encrypted_password, expires_at, published FROM pages WHERE id = $1', [share.urlId]
  )).rows[0];
  assert.equal(after.current_revision, before.current_revision, 'publication does not write content history');
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.encrypted_password, before.encrypted_password);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.access_revision, accessNextNext);
  assert.equal(after.published, true);
  const operations = await repository.pool.query(
    'SELECT action, result_revision, result_access_revision, receipt_encrypted FROM publish_operations WHERE actor_namespace = $1 AND request_id = $2',
    [`managed-key:${key.id}`, 'issue39-pg-exact-unpublish-001']
  );
  assert.equal(operations.rowCount, 1);
  assert.equal(operations.rows[0].result_revision, String(before.current_revision));
  assert.equal(operations.rows[0].result_access_revision, accessNext);
  assert.ok(operations.rows[0].receipt_encrypted);
});

test('dashboard and Key state transitions serialize on the same Share row across independent PIDs', async () => {
  const key = await createKey('PG owner/API state race');
  const share = await createShare('PG owner/API state race target');
  assert.equal((await grant(key, share.urlId, { canPublish: true })).status, 201);
  const baseline = await state(key.secret, share.urlId);
  const observer = await repository.pool.connect();
  const originalSetPublished = repository.setPublished;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let paused = false;
  let apiPid;
  repository.setPublished = async function (id, options) {
    if (id === share.urlId && !paused) {
      paused = true;
      apiPid = Number((await this.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      enter();
      await gate;
    }
    return originalSetPublished.call(this, id, options);
  };
  let apiRequest;
  let ownerRequest;
  try {
    apiRequest = transition(key.secret, share.urlId, 'unpublish', baseline.headers.get('etag'), 'issue39-pg-owner-race-api-01');
    await entered;
    ownerRequest = request(`/admin/pages/${share.urlId}/unpublish`, {
      method: 'POST', body: { expectedAccessRevision: '1' },
      headers: { 'Idempotency-Key': 'issue39-pg-owner-race-owner-01' }
    });
    const ownerPid = await waitForLock(observer, 'SELECT * FROM pages WHERE id = $1 FOR UPDATE');
    assert.notEqual(ownerPid, apiPid, 'owner and Key state changes occupy different PostgreSQL backend PIDs');
    release();
    const [api, owner] = await Promise.all([apiRequest, ownerRequest]);
    assert.equal(api.status, 200);
    assert.equal(api.body.accessRevision, '2');
    assert.equal(owner.status, 412, 'the queued owner transition sees the Key commit as a stale baseline');
  } finally {
    release();
    repository.setPublished = originalSetPublished;
    observer.release();
    await Promise.allSettled([apiRequest, ownerRequest]);
  }
  const page = await repository.pool.query('SELECT published, access_revision FROM pages WHERE id = $1', [share.urlId]);
  assert.equal(page.rows[0].published, false);
  assert.equal(page.rows[0].access_revision, '2');
});

test('Key rotation waits behind an in-flight state transaction; rotated identity keeps grant but old secret dies', async () => {
  const key = await createKey('PG rotation serialization');
  const share = await createShare('PG rotation serialization target');
  assert.equal((await grant(key, share.urlId, { canPublish: true })).status, 201);
  const current = await state(key.secret, share.urlId);
  const observer = await repository.pool.connect();
  const originalSetPublished = repository.setPublished;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let paused = false;
  let apiPid;
  repository.setPublished = async function (id, options) {
    if (id === share.urlId && !paused) {
      paused = true;
      apiPid = Number((await this.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      enter();
      await gate;
    }
    return originalSetPublished.call(this, id, options);
  };
  let apiRequest;
  let rotateRequest;
  try {
    apiRequest = transition(key.secret, share.urlId, 'unpublish', current.headers.get('etag'), 'issue39-pg-rotation-order-01');
    await entered;
    rotateRequest = request(`/admin/apis/keys/${key.id}/rotate`, { method: 'POST', body: {} });
    const rotatePid = await waitForLock(observer, 'UPDATE api_keys SET key_hash = $2');
    assert.notEqual(rotatePid, apiPid, 'rotation waits on the API transaction from a distinct backend');
    release();
    const [api, rotated] = await Promise.all([apiRequest, rotateRequest]);
    assert.equal(api.status, 200, 'the transaction that acquired the Key lock first commits');
    assert.equal(rotated.status, 200, 'rotation commits after the publish transaction');
    assert.deepEqual(rotated.body.apiKey.scopes, ['share:create', 'share:publish']);
    assert.equal((await state(key.secret, share.urlId)).status, 401);
    const status = await request('/api/v1/operations/issue39-pg-rotation-order-01', {
      headers: { 'X-API-Key': rotated.body.apiKey.secret }
    });
    assert.equal(status.status, 200, 'the rotated credential in the same logical namespace can confirm');
    assert.equal(status.body.operations[0].action, 'unpublish');
  } finally {
    release();
    repository.setPublished = originalSetPublished;
    observer.release();
    await Promise.allSettled([apiRequest, rotateRequest]);
  }
});

test('rotation committed after header authentication invalidates the old credential before transaction work', async () => {
  const key = await createKey('PG rotation before operation transaction');
  const share = await createShare('PG rotation before operation transaction target');
  assert.equal((await grant(key, share.urlId, { canPublish: true })).status, 201);
  const baseline = await state(key.secret, share.urlId);
  await repository.pool.query('UPDATE api_keys SET last_used_at = NULL WHERE id = $1', [key.id]);
  const held = unfinishedPublish(`/api/v1/shares/${share.urlId}/unpublish`, {
    'X-API-Key': key.secret,
    'If-Match': baseline.headers.get('etag'),
    'Idempotency-Key': 'issue39-pg-rotation-before-tx-001'
  });
  await waitForKeyUse(key.id);

  const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.deepEqual(rotated.body.apiKey.scopes, ['share:create', 'share:publish']);
  held.finish();
  const refused = await held.result;
  assert.equal(refused.status, 401, 'the old credential_version is rechecked at the write transaction boundary');
  assert.equal(refused.body.code, 'INVALID_API_KEY');
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue39-pg-rotation-before-tx-001'), null);
  const page = await repository.pool.query('SELECT published, access_revision FROM pages WHERE id = $1', [share.urlId]);
  assert.equal(page.rows[0].published, true);
  assert.equal(page.rows[0].access_revision, '1');
  assert.equal((await state(rotated.body.apiKey.secret, share.urlId)).status, 200, 'rotated credential keeps its logical grant');
});

test('grant revocation waits behind the Share transaction, then blocks operation status and stale auth requests', async () => {
  const key = await createKey('PG grant revoke serialization');
  const target = await createShare('PG grant revoke target');
  const other = await createShare('PG second publish grant');
  assert.equal((await grant(key, target.urlId, { canPublish: true })).status, 201);
  assert.equal((await grant(key, other.urlId, { canPublish: true })).status, 201);
  const current = await state(key.secret, target.urlId);
  const observer = await repository.pool.connect();
  const originalSetPublished = repository.setPublished;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let paused = false;
  let apiPid;
  repository.setPublished = async function (id, options) {
    if (id === target.urlId && !paused) {
      paused = true;
      apiPid = Number((await this.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      enter();
      await gate;
    }
    return originalSetPublished.call(this, id, options);
  };
  let apiRequest;
  let revokeRequest;
  try {
    apiRequest = transition(key.secret, target.urlId, 'unpublish', current.headers.get('etag'), 'issue39-pg-grant-order-001');
    await entered;
    revokeRequest = request(`/admin/apis/keys/${key.id}/grants/${target.urlId}`, {
      method: 'PUT', body: { canPublish: false }
    });
    const revokePid = await waitForLock(observer, 'SELECT id FROM api_keys WHERE id = $1 FOR UPDATE');
    assert.notEqual(revokePid, apiPid, 'grant revocation is a second PostgreSQL backend waiting on the Key lock');
    release();
    const [api, revoked] = await Promise.all([apiRequest, revokeRequest]);
    assert.equal(api.status, 200);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.grant, null);
    assert.ok(revoked.body.scopes.includes('share:publish'), 'the other Share keeps the global publish scope');
  } finally {
    release();
    repository.setPublished = originalSetPublished;
    observer.release();
    await Promise.allSettled([apiRequest, revokeRequest]);
  }
  assert.equal((await request('/api/v1/operations/issue39-pg-grant-order-001', {
    headers: { 'X-API-Key': key.secret }
  })).status, 404, 'a revoked target grant hides the old operation result');

  // Authentication has already observed the old grant when the body is held,
  // but the write transaction starts only after owner revocation commits.
  const staleShare = await createShare('PG revoke before operation tx');
  assert.equal((await grant(key, staleShare.urlId, { canPublish: true })).status, 201);
  await repository.pool.query('UPDATE api_keys SET last_used_at = NULL WHERE id = $1', [key.id]);
  const staleState = await state(key.secret, staleShare.urlId);
  await repository.pool.query('UPDATE api_keys SET last_used_at = NULL WHERE id = $1', [key.id]);
  const held = unfinishedPublish(`/api/v1/shares/${staleShare.urlId}/unpublish`, {
    'X-API-Key': key.secret,
    'If-Match': staleState.headers.get('etag'),
    'Idempotency-Key': 'issue39-pg-revoke-before-tx-001'
  });
  await waitForKeyUse(key.id);
  const revoked = await request(`/admin/apis/keys/${key.id}/grants/${staleShare.urlId}`, {
    method: 'PUT', body: { canPublish: false }
  });
  assert.equal(revoked.status, 200);
  held.finish();
  const refused = await held.result;
  assert.equal(refused.status, 404, 'write transaction rechecks the now-revoked target grant');
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue39-pg-revoke-before-tx-001'), null);
  assert.equal((await repository.pool.query('SELECT published FROM pages WHERE id = $1', [staleShare.urlId])).rows[0].published, true);
});

test('publication state, audit and encrypted result roll back together on COMMIT failure', async () => {
  const key = await createKey('PG publish commit rollback');
  const share = await createShare('PG publish commit rollback target');
  assert.equal((await grant(key, share.urlId, { canPublish: true })).status, 201);
  const before = await state(key.secret, share.urlId);
  const beforeAuditCount = Number((await repository.pool.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = 'page.unpublish'", [share.urlId]
  )).rows[0].count);
  await repository.pool.query(`
    CREATE FUNCTION issue39_fail_publish_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.page_id = '${share.urlId}' AND NEW.action = 'page.unpublish' THEN
        RAISE EXCEPTION 'issue39 injected publish COMMIT failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER issue39_fail_publish_commit_trigger
      AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION issue39_fail_publish_commit();
  `);
  let failed;
  try {
    failed = await transition(key.secret, share.urlId, 'unpublish', before.headers.get('etag'), 'issue39-pg-commit-failure-01');
  } finally {
    await repository.pool.query('DROP TRIGGER IF EXISTS issue39_fail_publish_commit_trigger ON audit_logs; DROP FUNCTION IF EXISTS issue39_fail_publish_commit()');
  }
  assert.equal(failed.status, 503, 'deferred COMMIT failure is retryable, never success');
  assert.equal((await state(key.secret, share.urlId)).body.accessRevision, '1');
  assert.equal((await repository.pool.query('SELECT published FROM pages WHERE id = $1', [share.urlId])).rows[0].published, true);
  assert.equal(Number((await repository.pool.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = 'page.unpublish'", [share.urlId]
  )).rows[0].count), beforeAuditCount);
  assert.equal(await repository.findPublishingOperation(`managed-key:${key.id}`, 'issue39-pg-commit-failure-01'), null);

  const retry = await transition(key.secret, share.urlId, 'unpublish', before.headers.get('etag'), 'issue39-pg-commit-failure-01');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.changed, true);
  assert.equal(retry.body.accessRevision, '2');
});

test('revision purge preserves PostgreSQL publish-state receipts, replay and status without stale state leaks', async () => {
  for (const action of ['unpublish', 'republish']) {
    const key = await createKey(`PG purge independent ${action}`);
    const share = await createShare(`PG purge ${action}`);
    assert.equal((await grant(key, share.urlId, { canPublish: true })).status, 201);

    const initialState = await state(key.secret, share.urlId);
    const requestId = `issue39-pg-purge-${action}-001`;
    const committed = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(committed.status, 200, committed.text);
    const committedAccessRevision = committed.body.accessRevision;
    const committedPublished = action === 'republish';
    assert.equal(committed.body.published, committedPublished);

    assert.equal(await repository.updatePage(share.urlId, {
      htmlContent: `<h1>PG ${action} revision two</h1>`,
      title: `PG ${action} revision two`,
      expectedContentRevision: '1'
    }), true);
    assert.equal(String((await repository.getById(share.urlId)).current_revision), '2');

    const purged = await request(`/admin/pages/${share.urlId}/revisions/1/purge`, {
      method: 'POST', body: { confirm: `${share.urlId}:1` }
    });
    assert.equal(purged.status, 200, purged.text);
    const record = await repository.findPublishingOperation(`managed-key:${key.id}`, requestId);
    assert.ok(record.receipt_encrypted, 'PostgreSQL keeps the minimal state receipt after content purge');
    assert.equal(record.purged_at, null, 'the content tombstone is not copied onto a state operation');

    const beforeReplay = await repository.getById(share.urlId);
    const committedAuditsBeforeReplay = Number((await repository.pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = $2",
      [share.urlId, `page.${action}`]
    )).rows[0].count);
    const replay = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.changed, committed.body.changed);
    assert.equal(replay.body.published, committedPublished);
    assert.equal(replay.body.accessRevision, committedAccessRevision);
    const afterReplay = await repository.getById(share.urlId);
    assert.equal(String(afterReplay.access_revision), String(beforeReplay.access_revision), 'state replay leaves the locked row unchanged');
    assert.equal(afterReplay.published, beforeReplay.published);

    const status = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.operations[0].action, action);
    assert.equal(status.body.operations[0].status, 'succeeded');
    assert.equal(status.body.operations[0].revision, '1');
    assert.equal(status.body.operations[0].accessRevision, committedAccessRevision);
    assert.equal(Number((await repository.pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = $2",
      [share.urlId, `page.${action}`]
    )).rows[0].count), committedAuditsBeforeReplay, 'replay/status do not add committed state audit entries');

    const current = await state(key.secret, share.urlId);
    const laterAction = action === 'unpublish' ? 'republish' : 'unpublish';
    const later = await transition(key.secret, share.urlId, laterAction, current.headers.get('etag'), `issue39-pg-purge-later-${action}-01`);
    assert.equal(later.status, 200, later.text);
    assert.equal(later.body.changed, true);
    const laterAccessRevision = String(BigInt(committedAccessRevision) + 1n);
    assert.equal(later.body.accessRevision, laterAccessRevision);
    const laterAuditCount = Number((await repository.pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = $2",
      [share.urlId, `page.${laterAction}`]
    )).rows[0].count);

    const staleReplay = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(staleReplay.status, 200, staleReplay.text);
    assert.equal(staleReplay.body.stateChangedSinceCommit, true);
    assert.equal('published' in staleReplay.body, false);
    assert.equal('accessRevision' in staleReplay.body, false);
    assert.notEqual(staleReplay.headers.get('etag'), initialState.headers.get('etag'), 'a stale replay does not return its old strong state ETag');
    const staleStatus = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(staleStatus.status, 200, staleStatus.text);
    assert.equal(staleStatus.body.operations[0].stateChangedSinceCommit, true);
    assert.equal('accessRevision' in staleStatus.body.operations[0], false);
    assert.equal(Number((await repository.pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE page_id = $1 AND action = $2",
      [share.urlId, `page.${laterAction}`]
    )).rows[0].count), laterAuditCount, 'stale replay/status do not repeat the later transition');
    assert.equal(String((await repository.getById(share.urlId)).access_revision), laterAccessRevision);
  }
});

test('same request id is isolated by managed-Key namespace', async () => {
  const firstKey = await createKey('PG namespace publisher one');
  const secondKey = await createKey('PG namespace publisher two');
  const share = await createShare('PG namespace isolation');
  assert.equal((await grant(firstKey, share.urlId, { canPublish: true })).status, 201);
  assert.equal((await grant(secondKey, share.urlId, { canPublish: true })).status, 201);
  const firstState = await state(firstKey.secret, share.urlId);
  const requestId = 'issue39-pg-namespace-same-01';
  const created = await transition(firstKey.secret, share.urlId, 'unpublish', firstState.headers.get('etag'), requestId);
  assert.equal(created.status, 200);
  const foreign = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': secondKey.secret } });
  assert.equal(foreign.status, 404, 'a different managed Key cannot inspect this namespace result');
  const foreignReplay = await transition(secondKey.secret, share.urlId, 'unpublish', firstState.headers.get('etag'), requestId);
  assert.equal(foreignReplay.status, 412, 'the second namespace executes against its own stale baseline, not the first receipt');
  const rows = await repository.pool.query('SELECT actor_namespace, request_id FROM publish_operations WHERE request_id = $1', [requestId]);
  assert.deepEqual(rows.rows, [{ actor_namespace: `managed-key:${firstKey.id}`, request_id: requestId }]);
});
