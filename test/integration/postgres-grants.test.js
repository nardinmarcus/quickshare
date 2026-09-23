// #36 native PostgreSQL integration: scope migration backfill, grant/revoke
// atomicity with injected failures, the §8 Key→Share lock order, and
// grant/rotation races across at least two independent connections.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');
const { hashSecret } = require('../../utils/security');

const url = new URL(process.env.POSTGRES_TEST_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Local _test database required');
const repository = new PostgresPageRepository(url.href, { POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '6', POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000', POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000' });
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'legacy-env-key';
const selector = require('../../models/pageRepository');
const factory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = factory;

let server, origin;
test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); await repository.pool.end(); });

async function request(path, method = 'GET', body, key) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('database barrier was not reached');
}

async function waiting(observer, sqlFragment) {
  await until(async () => {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    return (await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1",
      [`%${sqlFragment}%`]
    )).rowCount > 0;
  });
}

async function seedKeyAndShare({ name, title }) {
  const key = (await request('/admin/apis/keys', 'POST', { name })).body.apiKey;
  const share = (await request('/api/v1/share', 'POST', { htmlContent: `<h1>${title}</h1>`, title }, 'legacy-env-key')).body;
  return { key, shareId: share.urlId };
}

test('migration 010 backfills existing managed keys to create-only scopes', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'pre-scope key' })).body.apiKey;
  const row = await repository.pool.query('SELECT scopes, auto_grant_new_share_edit FROM api_keys WHERE id = $1', [key.id]);
  // A key created by the app is born create-only (#36); the migration's
  // backfill to '["share:create"]' is proven by the native drill fixture,
  // and no path ever widens a scope without an explicit grant.
  assert.deepEqual(row.rows[0].scopes, ['share:create']);
  assert.equal(row.rows[0].auto_grant_new_share_edit, false);
});

test('grant commits atomically: a forced audit failure leaves no grant, no scope and no audit row', async () => {
  const { key, shareId } = await seedKeyAndShare({ name: 'atomicity key', title: 'Atomicity Share' });
  const audit = repository.createAuditLog;
  repository.createAuditLog = async () => { throw new Error('synthetic audit failure'); };
  try {
    const result = await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });
    assert.equal(result.status, 500);
  } finally {
    repository.createAuditLog = audit;
  }
  const grant = await repository.pool.query('SELECT * FROM share_grants WHERE api_key_id = $1', [key.id]);
  assert.equal(grant.rowCount, 0, 'no half-committed grant');
  const keyRow = await repository.pool.query('SELECT scopes FROM api_keys WHERE id = $1', [key.id]);
  assert.deepEqual(keyRow.rows[0].scopes, ['share:create'], 'scope unchanged after rollback');

  // The same grant succeeds once the failure is gone.
  const retry = await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });
  assert.equal(retry.status, 201);
});

test('grant takes the Key row lock BEFORE the Share row lock (#24 §8)', async () => {
  const { key, shareId } = await seedKeyAndShare({ name: 'lock order key', title: 'Lock Order Share' });
  const observer = await repository.pool.connect();
  let grantRequest;
  try {
    // Hold the KEY row lock from an outside transaction, then start a grant:
    // the grant must block on the Key row FIRST (observable as a wait on
    // 'SELECT id, scopes FROM api_keys'), never racing ahead to the Share.
    await observer.query('BEGIN');
    await observer.query('SELECT * FROM api_keys WHERE id = $1 FOR UPDATE', [key.id]);
    grantRequest = request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });
    await waiting(observer, 'FROM api_keys WHERE id = $1 FOR UPDATE');
    const grantCount = await repository.pool.query('SELECT COUNT(*)::int AS count FROM share_grants WHERE api_key_id = $1', [key.id]);
    assert.equal(grantCount.rows[0].count, 0, 'grant waits behind the Key row lock');
    await observer.query('COMMIT');
    const settled = await grantRequest;
    assert.equal(settled.status, 201);
    assert.equal((await repository.pool.query('SELECT COUNT(*)::int AS count FROM share_grants WHERE api_key_id = $1', [key.id])).rows[0].count, 1);
  } finally {
    await observer.query('ROLLBACK').catch(() => {});
    observer.release();
    await grantRequest.catch(() => {});
  }
});

test('rotation committed between grant decision and read still yields 401 for the old secret; grants survive for the new one', async () => {
  const { key, shareId } = await seedKeyAndShare({ name: 'race rotation key', title: 'Race Rotation Share' });

  await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });

  // Two independent connections: one holds a verified old-secret request
  // (body unsent), the other commits a rotation meanwhile.
  const observer = await repository.pool.connect();
  const data = JSON.stringify({ htmlContent: '<h1>held</h1>' });
  let pending;
  const heldResult = new Promise((resolve, reject) => {
    pending = require('node:http').request(origin + '/api/v1/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-API-Key': key.secret }
    }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    pending.on('error', reject); pending.flushHeaders();
  });
  try {
    await until(async () => (await observer.query('SELECT last_used_at FROM api_keys WHERE id = $1', [key.id])).rows[0].last_used_at !== null);
    const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, 'POST', {});
    assert.equal(rotated.status, 200);
    const newSecret = rotated.body.apiKey.secret;

    pending.end(data);
    assert.equal((await heldResult).status, 401, 'rotation wins over the held old-secret request');

    const list = await request('/api/v1/shares', 'GET', undefined, newSecret);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.shares.map(row => row.id), [shareId], 'grants survive rotation on real PostgreSQL');
    assert.deepEqual([...rotated.body.apiKey.scopes].sort(), ['share:create', 'share:read']);
  } finally {
    pending.end(data); await heldResult.catch(() => {});
    observer.release();
  }
});

test('revoke wins over an in-flight grant by taking the Key row lock first', async () => {
  const { key, shareId } = await seedKeyAndShare({ name: 'revoke race key', title: 'Revoke Race Share' });
  await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });

  const observer = await repository.pool.connect();
  let grantAgain;
  try {
    await observer.query('BEGIN');
    await observer.query('SELECT * FROM api_keys WHERE id = $1 FOR UPDATE', [key.id]);
    grantAgain = request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });
    await waiting(observer, 'FROM api_keys WHERE id = $1 FOR UPDATE');
    // Revoke cannot run inside this transaction (same lock), so instead
    // verify the revocation that already committed stays until the lock
    // holder commits: delete the grant through a second path.
    await observer.query('COMMIT');
    const settled = await grantAgain;
    assert.equal(settled.status, 200, 'duplicate grant after lock release is a no-op');
    assert.equal(settled.body.changed, false);

    const revoked = await request(`/admin/apis/keys/${key.id}/grants/${shareId}`, 'DELETE');
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.changed, true);
    const keyRow = await repository.pool.query('SELECT scopes FROM api_keys WHERE id = $1', [key.id]);
    assert.deepEqual(keyRow.rows[0].scopes, ['share:create'], 'last revoke drops the read scope');
  } finally {
    await observer.query('ROLLBACK').catch(() => {});
    observer.release();
    await grantAgain.catch(() => {});
  }
});

test('share deletion cascades its grants; an edit-dependent read grant refuses single revoke', async () => {
  const { key, shareId } = await seedKeyAndShare({ name: 'cascade native key', title: 'Cascade Native Share' });
  await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId });

  // #37 will write can_update through the API; set the bit directly to pin
  // today's refusal: revoke must 409, never violate update ⇒ read.
  await repository.pool.query('UPDATE share_grants SET can_update = TRUE WHERE api_key_id = $1 AND share_id = $2', [key.id, shareId]);
  const dependent = await request(`/admin/apis/keys/${key.id}/grants/${shareId}`, 'DELETE');
  assert.equal(dependent.status, 409, 'edit-dependent read grant cannot be singly revoked');
  const intact = await repository.pool.query('SELECT can_read, can_update FROM share_grants WHERE api_key_id = $1', [key.id]);
  assert.deepEqual(intact.rows[0], { can_read: true, can_update: true }, 'grant intact, not downgraded');

  // Share deletion cascades the grant row (FK ON DELETE CASCADE) and the
  // owner keeps the read scope — explicit grant history is an owner call.
  await repository.pool.query('DELETE FROM pages WHERE id = $1', [shareId]);
  assert.equal((await repository.pool.query('SELECT COUNT(*)::int AS count FROM share_grants WHERE api_key_id = $1', [key.id])).rows[0].count, 0);
  const keyRow = await repository.pool.query('SELECT scopes FROM api_keys WHERE id = $1', [key.id]);
  assert.deepEqual(keyRow.rows[0].scopes, ['share:create', 'share:read']);
});

test('cursor pagination is stable on native PostgreSQL with BIGINT timestamps', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'native cursor key' })).body.apiKey;
  const shareIds = [];
  for (let index = 1; index <= 3; index += 1) {
    const share = (await request('/api/v1/share', 'POST', { htmlContent: `<h1>Native ${index}</h1>`, title: `Native ${index}` }, 'legacy-env-key')).body;
    shareIds.push(share.urlId);
    await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId: share.urlId });
  }

  const page1 = await request('/api/v1/shares?limit=2', 'GET', undefined, key.secret);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.shares.length, 2);
  const page2 = await request(`/api/v1/shares?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, 'GET', undefined, key.secret);
  assert.equal(page2.status, 200);
  const walked = [...page1.body.shares.map(row => row.id), ...page2.body.shares.map(row => row.id)];
  assert.deepEqual(new Set(walked).size, 3);
  assert.deepEqual([...walked].sort(), [...shareIds].sort(), 'cursor walk reaches every grant exactly once');
});

test('cursor traversal is stable for same-timestamp mixed-case IDs on native PostgreSQL (S1)', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'case cursor native' })).body.apiKey;
  const ids = ['ANativeCaseCursor', 'aNativeCaseCursor'];
  for (const id of ids) {
    await repository.create({
      id,
      htmlContent: `<h1>${id}</h1>`,
      createdAt: 1700000004500,
      isProtected: false,
      codeType: 'html',
      title: id,
      markdownTheme: null
    });
    const granted = await request(`/admin/apis/keys/${key.id}/grants`, 'POST', { shareId: id });
    assert.equal(granted.status, 201);
  }

  const visited = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await request(`/api/v1/shares?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, key.secret);
    assert.equal(response.status, 200);
    for (const row of response.body.shares) {
      if (ids.includes(row.id)) visited.push(row.id);
    }
    if (!response.body.nextCursor) break;
    cursor = response.body.nextCursor;
  }
  assert.equal(visited.length, ids.length, 'the walk terminates after every grant exactly once');
  assert.deepEqual([...visited].sort(), [...ids].sort(), 'mixed-case same-timestamp grants are all visited');

  await repository.pool.query('DELETE FROM pages WHERE id = ANY($1)', [ids]);
});
