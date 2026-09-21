const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');
const url = new URL(process.env.POSTGRES_TEST_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Local _test database required');
const repository = new PostgresPageRepository(url.href, { POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '6', POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000', POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000' });
process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
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
function heldShare(secret) {
  const data = JSON.stringify({ htmlContent: '<h1>stale request</h1>' });
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request(origin + '/api/v1/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-API-Key': secret } }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.flushHeaders();
  });
  return { finish: () => req.end(data), result, destroy: () => req.destroy() };
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

for (const action of ['rotate', 'delete']) {
  test(`${action} committed after first authentication rejects the held old HTTP Share request`, async () => {
    const key = (await request('/admin/apis/keys', 'POST', { name: action })).body.apiKey;
    const observer = await repository.pool.connect();
    const held = heldShare(key.secret);
    try {
      // The usage timestamp is written only after first secret verification;
      // the request body remains unsent, so no publishing transaction exists yet.
      await until(async () => (await observer.query('SELECT last_used_at FROM api_keys WHERE id = $1', [key.id])).rows[0].last_used_at !== null);
      const changed = await request(`/admin/apis/keys/${key.id}${action === 'rotate' ? '/rotate' : ''}`, action === 'rotate' ? 'POST' : 'DELETE', action === 'rotate' ? {} : undefined);
      assert.equal(changed.status, 200);
      const count = await repository.countPages();
      held.finish();
      assert.equal((await held.result).status, 401);
      assert.equal(await repository.countPages(), count);
    } finally { held.finish(); await held.result; observer.release(); }
  });
}

test('a Share holding the Key lock commits before later rotation; discovery never waits on usage writes', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'lock ordering' })).body.apiKey;
  const observer = await repository.pool.connect();
  let share, rotation;
  try {
    await observer.query(`CREATE FUNCTION issue29_share_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(29001); RETURN NEW; END $$;
      CREATE TRIGGER issue29_share_barrier BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION issue29_share_barrier()`);
    await observer.query('BEGIN');
    await observer.query('SELECT pg_advisory_xact_lock(29001)');
    share = request('/api/v1/share', 'POST', { htmlContent: '<h1>legitimate first writer</h1>' }, key.secret);
    await waiting(observer, 'INSERT INTO pages');
    // This read's best-effort usage UPDATE is now blocked by the Key row lock.
    const identity = await request('/api/v1/me', 'GET', undefined, key.secret);
    assert.equal(identity.status, 200);
    await waiting(observer, 'UPDATE api_keys SET last_used_at');
    rotation = request(`/admin/apis/keys/${key.id}/rotate`, 'POST', {});
    await waiting(observer, 'UPDATE api_keys SET key_hash');
    await observer.query('COMMIT');
    const published = await share;
    assert.equal(published.status, 200);
    assert.ok(await repository.getById(published.body.urlId));
    const rotated = await rotation;
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.apiKey.credential_version, '2');
    assert.equal((await request('/api/v1/me', 'GET', undefined, key.secret)).status, 401);
  } finally {
    await observer.query('ROLLBACK');
    if (share) await share;
    if (rotation) await rotation;
    await observer.query('DROP TRIGGER IF EXISTS issue29_share_barrier ON pages; DROP FUNCTION IF EXISTS issue29_share_barrier()');
    observer.release();
  }
});

for (const failure of ['audit', 'commit']) {
  test(`rotation ${failure} failure rolls back the hash/version and never discloses the generated secret`, async () => {
    const key = (await request('/admin/apis/keys', 'POST', { name: failure })).body.apiKey;
    const observer = await repository.pool.connect();
    try {
      if (failure === 'audit') {
        await observer.query("ALTER TABLE audit_logs ADD CONSTRAINT issue29_audit_failure CHECK (action <> 'api_key.rotate') NOT VALID");
      } else {
        await observer.query(`CREATE FUNCTION issue29_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.action = 'api_key.rotate' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END $$;
          CREATE CONSTRAINT TRIGGER issue29_commit_failure AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION issue29_commit_failure()`);
      }
      const before = await repository.getApiKeyById(key.id);
      const response = await request(`/admin/apis/keys/${key.id}/rotate`, 'POST', {});
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { success: false, error: 'Failed to rotate API key' });
      const after = await repository.getApiKeyById(key.id);
      assert.equal(after.key_hash, before.key_hash);
      assert.equal(after.credential_version, before.credential_version);
      assert.equal((await request('/api/v1/share', 'POST', { htmlContent: 'original credential survives rollback' }, key.secret)).status, 200);
      assert.equal((await observer.query("SELECT 1 FROM audit_logs WHERE action = 'api_key.rotate' AND details::jsonb->>'apiKeyId' = $1", [key.id])).rowCount, 0);
    } finally {
      await observer.query('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS issue29_audit_failure');
      await observer.query('DROP TRIGGER IF EXISTS issue29_commit_failure ON audit_logs; DROP FUNCTION IF EXISTS issue29_commit_failure()');
      observer.release();
    }
  });
}

test('real PostgreSQL maintenance rejects rotation but keeps managed discovery read-only and available', async () => {
  const key = (await request('/admin/apis/keys', 'POST', { name: 'paused identity' })).body.apiKey;
  await repository.setPublishingWritesPaused(true);
  try {
    const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, 'POST', {});
    assert.equal(rotated.status, 503);
    assert.equal(rotated.body.code, 'PUBLISHING_MAINTENANCE');
    assert.equal('apiKey' in rotated.body, false);
    assert.equal((await request('/api/v1/me', 'GET', undefined, key.secret)).body.credentialVersion, '1');
    assert.equal((await request('/api/v1/capabilities', 'GET', undefined, key.secret)).status, 200);
    assert.equal((await repository.getApiKeyById(key.id)).last_used_at, null);
  } finally { await repository.setPublishingWritesPaused(false); }
});

test('migration006 preserves existing Key IDs/hashes and BIGINT versions survive HTTP rotation exactly', async () => {
  // Rebuild the pre-006 schema only in this guarded disposable test database.
  await repository.pool.query("DELETE FROM quickshare_schema_migrations WHERE version = '006'; ALTER TABLE api_keys DROP COLUMN credential_version");
  const before = (await repository.pool.query('SELECT id, key_hash FROM api_keys ORDER BY id')).rows;
  assert.deepEqual((await runMigrations(repository.pool, { logger: { info() {} } })).applied, ['006']);
  assert.deepEqual((await repository.pool.query('SELECT id, key_hash FROM api_keys ORDER BY id')).rows, before);
  assert.ok((await repository.pool.query('SELECT credential_version FROM api_keys')).rows.every(row => row.credential_version === '1'));
  assert.deepEqual((await runMigrations(repository.pool, { logger: { info() {} } })).applied, []);
  const key = (await request('/admin/apis/keys', 'POST', { name: 'bigint fidelity' })).body.apiKey;
  await repository.pool.query('UPDATE api_keys SET credential_version = $2 WHERE id = $1', [key.id, '9007199254740993']);
  assert.equal((await request('/api/v1/me', 'GET', undefined, key.secret)).body.credentialVersion, '9007199254740993');
  const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, 'POST', {});
  assert.equal(rotated.body.apiKey.credential_version, '9007199254740994');
  assert.equal((await request('/api/v1/share', 'POST', { htmlContent: 'bigint credential creates' }, rotated.body.apiKey.secret)).status, 200);
});
