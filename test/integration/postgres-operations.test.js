const test = require('node:test');
const assert = require('node:assert/strict');

const url = new URL(process.env.POSTGRES_TEST_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Isolated localhost _test database required');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue32-pg-operations-secret';
process.env.SHARE_API_KEY = 'issue32-pg-legacy-key';

const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');

const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '6',
  POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
});

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

const LEGACY = 'issue32-pg-legacy-key';

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function createManagedKey(name) {
  const res = await postJson('/admin/apis/keys', { name });
  assert.equal(res.status, 201);
  return res.body.apiKey;
}

const API_BODY = { htmlContent: '<h1>PG Idem</h1>', codeType: 'html', title: 'Pg Idem' };

test('migration 008 creates the operation ledger with the namespace+request primary key', async () => {
  const table = await repository.pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'publish_operations'
    ORDER BY ordinal_position ASC
  `);
  const columns = table.rows.map(row => row.column_name);
  for (const required of ['actor_namespace', 'request_id', 'action', 'request_digest', 'target_id',
    'result_share_id', 'result_revision', 'result_access_revision', 'receipt_encrypted', 'created_at', 'deleted_at']) {
    assert.ok(columns.includes(required), `publish_operations.${required} exists`);
  }
  const pk = await repository.pool.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE c.relname = 'publish_operations' AND i.indisprimary
  `);
  assert.deepEqual(pk.rows.map(row => row.attname).sort(), ['actor_namespace', 'request_id']);
});

test('two independent connections racing the same request id produce one share', async () => {
  const key = 'pg-race-same-key-012345';
  const requests = await Promise.all([0, 1, 2].map(() => postJson('/api/v1/share', API_BODY,
    { 'X-API-Key': LEGACY, 'Idempotency-Key': key })));

  for (const response of requests) {
    assert.equal(response.status, 200);
  }
  const ids = new Set(requests.map(response => response.body.urlId));
  assert.equal(ids.size, 1, 'all racers observe the same single share');

  const replayed = requests.filter(response => response.body.replayed === true);
  assert.equal(replayed.length, 2, 'exactly the serialized losers confirm the committed result');

  const pages = await repository.pool.query('SELECT count(*)::int AS n FROM pages WHERE title = $1', ['Pg Idem']);
  assert.equal(pages.rows[0].n, 1, 'the database holds exactly one Share for the operation');

  const operations = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key]);
  assert.equal(operations.rows[0].n, 1);
});

test('a failure after the operation write rolls back share, revision, audit and operation together', async () => {
  const key = 'pg-rollback-ops-0123456';
  const observer = await repository.pool.connect();
  try {
    // Constraint trigger fires during COMMIT: everything (Share, baseline
    // Revision, audit, operation record) must roll back as one unit.
    await observer.query(`
      CREATE FUNCTION issue32_op_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue32 injected operation failure'; END $$;
      CREATE CONSTRAINT TRIGGER issue32_op_barrier AFTER INSERT ON publish_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue32_op_barrier();
    `);

    const pagesBefore = (await observer.query('SELECT count(*)::int AS n FROM pages')).rows[0].n;
    const operationsBefore = (await observer.query('SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key])).rows[0].n;
    const auditsBefore = (await observer.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n;

    const response = await postJson('/api/v1/share', API_BODY,
      { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
    assert.equal(response.status, 500, 'the injected failure surfaces as a server error, never success');

    const pagesAfter = (await repository.pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n;
    assert.equal(pagesAfter, pagesBefore, 'no half-committed Share survives');
    const operations = await repository.pool.query(
      'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key]);
    assert.equal(operations.rows[0].n, operationsBefore, 'no half-committed operation record survives');
    const audits = await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs');
    assert.equal(audits.rows[0].n, auditsBefore, 'no half-committed audit entry survives');
  } finally {
    await observer.query('DROP TRIGGER IF EXISTS issue32_op_barrier ON publish_operations; DROP FUNCTION IF EXISTS issue32_op_barrier()')
      .catch(() => {});
    observer.release();
  }

  // After the failure the request id was never committed: the same key can
  // be retried with the same input and then succeeds exactly once.
  const retry = await postJson('/api/v1/share', API_BODY,
    { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, undefined);
});

test('same request id with different input is a 409 and commits nothing on PostgreSQL', async () => {
  const key = 'pg-conflict-key-0123456';
  const first = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);

  const before = (await repository.pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n;
  const conflict = await postJson('/api/v1/share', { ...API_BODY, title: 'Changed' },
    { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_ID_CONFLICT');

  const after = (await repository.pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n;
  assert.equal(after, before);
});

test('an expiry that has since passed still replays the committed creation', async () => {
  const key = 'pg-expiry-replay-012345';
  const body = { ...API_BODY, expiresAt: Date.now() + 80 };
  const first = await postJson('/api/v1/share', body, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  await new Promise(resolve => setTimeout(resolve, 200));

  const replay = await postJson('/api/v1/share', body, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, first.body.urlId);
  assert.equal(replay.body.replayed, true);
});

test('deleting the Share clears the receipt and tombstones the operation in the same transaction', async () => {
  const key = 'pg-tombstone-key-012345';
  const first = await postJson('/api/v1/share', { ...API_BODY, isProtected: true },
    { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  assert.ok(first.body.password);
  const shareId = first.body.urlId;

  const stored = await repository.pool.query(
    'SELECT receipt_encrypted, deleted_at FROM publish_operations WHERE request_id = $1', [key]);
  assert.ok(stored.rows[0].receipt_encrypted, 'the generated password is stored encrypted');
  assert.equal(stored.rows[0].deleted_at, null);

  const del = await fetch(`${origin}/admin/pages/${shareId}`, { method: 'DELETE', headers: { Origin: origin } });
  assert.equal(del.status, 200);

  const tombstone = await repository.pool.query(
    'SELECT receipt_encrypted, deleted_at, result_share_id FROM publish_operations WHERE request_id = $1', [key]);
  assert.equal(tombstone.rows[0].receipt_encrypted, null, 'the sensitive receipt is gone');
  assert.notEqual(tombstone.rows[0].deleted_at, null, 'the tombstone is marked');
  assert.equal(tombstone.rows[0].result_share_id, shareId, 'non-content identifiers remain');

  const replay = await postJson('/api/v1/share', { ...API_BODY, isProtected: true },
    { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 410);
  assert.equal(replay.body.code, 'RESULT_UNAVAILABLE');

  const revived = await repository.pool.query('SELECT count(*)::int AS n FROM pages WHERE id = $1', [shareId]);
  assert.equal(revived.rows[0].n, 0, 'the late replay never revives the Share');
});

test('managed key rotation preserves the logical namespace for old operations', async () => {
  const managed = await createManagedKey('pg-rotate-confirm');
  const key = 'pg-rotation-key-0123456';
  const created = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(created.status, 200);

  const rotated = await postJson(`/admin/apis/keys/${managed.id}/rotate`, {});
  assert.equal(rotated.status, 200);
  const newSecret = rotated.body.apiKey.secret;

  const oldSecretReplay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(oldSecretReplay.status, 401, 'the revoked secret cannot even authenticate');

  const newSecretReplay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': newSecret, 'Idempotency-Key': key });
  assert.equal(newSecretReplay.status, 200);
  assert.equal(newSecretReplay.body.urlId, created.body.urlId);
  assert.equal(newSecretReplay.body.replayed, true, 'the rotated key confirms the old logical operation');
});

test('legacy and managed namespaces with the same request id stay independent', async () => {
  const managed = await createManagedKey('pg-ns-isolation');
  const key = 'pg-cross-ns-key-0123456';

  const legacyCreate = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  const managedCreate = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(legacyCreate.status, 200);
  assert.equal(managedCreate.status, 200);
  assert.notEqual(managedCreate.body.urlId, legacyCreate.body.urlId);

  const rows = await repository.pool.query(
    'SELECT actor_namespace FROM publish_operations WHERE request_id = $1 ORDER BY actor_namespace ASC', [key]);
  assert.equal(rows.rows.length, 2);
  assert.match(rows.rows[0].actor_namespace, /^legacy-key:[0-9a-f]{64}$/);
  assert.equal(rows.rows[1].actor_namespace, `managed-key:${managed.id}`);
});

test('operation status returns metadata only and stays scoped to the caller namespace', async () => {
  const managed = await createManagedKey('pg-ops-status');
  const key = 'pg-status-key-01234567';
  const created = await postJson('/api/v1/share', { ...API_BODY, isProtected: true },
    { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.ok(created.body.password);

  const response = await fetch(`${origin}/api/v1/operations/${key}`, { headers: { 'X-API-Key': managed.secret } });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes('password'));
  assert.ok(!text.includes('htmlContent'));
  assert.ok(!text.includes('title'));
  const body = JSON.parse(text);
  assert.equal(body.operations[0].shareId, created.body.urlId);
  assert.equal(body.operations[0].status, 'succeeded');

  const foreign = await fetch(`${origin}/api/v1/operations/${key}`, { headers: { 'X-API-Key': LEGACY } });
  assert.equal(foreign.status, 404, 'another namespace cannot enumerate this operation');
});

test('dashboard clone with a request id replays after the source disappears', async () => {
  const home = await fetch(origin, { headers: { Origin: origin } });
  const setCookie = home.headers.get('set-cookie') || '';
  const publishSession = setCookie.split(',').find(value => value.trim().startsWith('publish_session='));

  const src = await postJson('/api/pages/create', { htmlContent: '<h1>PG CloneSource</h1>', codeType: 'html' },
    publishSession ? { Cookie: publishSession.split(';')[0] } : {});
  assert.equal(src.status, 200);
  const sourceId = src.body.urlId;
  const key = 'pg-clone-key-012345678';

  const clone = (k) => fetch(`${origin}/admin/pages/${sourceId}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: `requestId=${encodeURIComponent(k)}`,
    redirect: 'manual'
  });

  const first = await clone(key);
  assert.equal(first.status, 302);
  const cloneId = first.headers.get('location').split('/').pop();

  await fetch(`${origin}/admin/pages/${sourceId}`, { method: 'DELETE', headers: { Origin: origin } });

  const replay = await clone(key);
  assert.equal(replay.status, 302, 'the committed clone replays without re-reading the deleted source');
  assert.equal(replay.headers.get('location').split('/').pop(), cloneId);
});

test('publishing maintenance pause also stops idempotent creation on PostgreSQL', async () => {
  const key = 'pg-maintenance-key-0123';
  await repository.setPublishingWritesPaused(true);
  try {
    const blocked = await postJson('/api/pages/create', API_BODY,
      { 'Idempotency-Key': key, Origin: origin, Cookie: 'publish_session=x' });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.retryable, true);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }

  const operations = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key]);
  assert.equal(operations.rows[0].n, 0, 'a maintenance-refused attempt records no operation');
});

test('a title whose 160-unit cap would split a surrogate pair stores well-formed on PostgreSQL', async () => {
  // Permanent regression for the preflight32-title-utf8-probe finding: the
  // lone surrogate used to become U+FFFD in storage (silent corruption).
  const home = await fetch(origin, { headers: { Origin: origin } });
  const setCookie = home.headers.get('set-cookie') || '';
  const publishSession = setCookie.split(',').find(value => value.trim().startsWith('publish_session='));

  const created = await postJson('/api/pages/create',
    { htmlContent: '<p>x</p>', codeType: 'html', title: 'a'.repeat(159) + '\u{1F600}' },
    publishSession ? { Cookie: publishSession.split(';')[0] } : {});
  assert.equal(created.status, 200);

  const row = await repository.pool.query('SELECT title FROM pages WHERE id = $1', [created.body.urlId]);
  const storedTitle = row.rows[0].title;
  assert.ok(storedTitle.length <= 160, 'the 160 code-unit cap holds in storage');
  assert.ok(!storedTitle.includes('\uFFFD'), 'no replacement character may be stored');
  assert.equal(Buffer.from(storedTitle, 'utf8').toString('utf8'), storedTitle);
});

// ---- Rework closure: failure models + result-availability (#24 §8) ----

test('a purged result revision makes the original result unconfirmable: 410, no metadata, no rebuild', async () => {
  const key = 'pg-revision-gone-01234567';
  const created = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(created.status, 200);
  const shareId = created.body.urlId;

  // Fault injection (explicit): simulate a history purge of the committed
  // result revision. Only the revision row is removed; the Share row stays —
  // the replay must still refuse, because the committed result revision is
  // what makes the original result confirmable.
  const purged = await repository.pool.query('DELETE FROM share_revisions WHERE share_id = $1 AND revision = 1', [shareId]);
  assert.equal(purged.rowCount, 1);

  const replay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 410);
  assert.equal(replay.body.code, 'RESULT_UNAVAILABLE');
  assert.ok(!JSON.stringify(replay.body).includes('Pg Idem'), 'no result metadata leaks once the revision is gone');

  const stillThere = await repository.pool.query('SELECT count(*)::int AS n FROM pages WHERE id = $1', [shareId]);
  assert.equal(stillThere.rows[0].n, 1, 'the refusal never rebuilds or mutates anything');
});

test('real HTTP response loss after COMMIT: the client-unknown retry recovers the same single Share', async () => {
  const key = 'pg-response-loss-0123456';
  const net = require('node:net');

  // Fault injection (explicit): a one-way raw TCP proxy between THIS client
  // and the app. Request bytes are fully forwarded (the server commits), but
  // response bytes are NEVER delivered — the client socket is destroyed
  // after the request ends, so the caller genuinely cannot know the outcome.
  const appPort = new URL(origin).port;
  const proxy = net.createServer((clientSocket) => {
    const upstream = net.connect(appPort, '127.0.0.1');
    // client → server only. Server → client bytes are drained, never piped:
    // the caller can never learn the outcome. Keep-alive means the client
    // never sends FIN, so the proxy itself parses Content-Length and severs
    // the client socket shortly after the full request has been forwarded.
    let buffered = Buffer.alloc(0);
    let headerEnd = -1;
    let contentLength = 0;
    let severTimer = null;
    clientSocket.pipe(upstream);
    upstream.on('data', () => {});
    clientSocket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (headerEnd === -1) {
        const index = buffered.indexOf('\r\n\r\n');
        if (index === -1) return;
        headerEnd = index + 4;
        const match = /content-length:\s*(\d+)/i.exec(buffered.slice(0, index).toString());
        contentLength = match ? Number.parseInt(match[1], 10) : 0;
      }
      if (severTimer === null && (buffered.length - headerEnd) >= contentLength) {
        severTimer = setTimeout(() => clientSocket.destroy(), 50);
      }
    });
    clientSocket.on('error', () => {});
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  const lostResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': LEGACY, 'Idempotency-Key': key },
    body: JSON.stringify(API_BODY)
  }).then(() => 'responded', () => 'connection-lost');
  proxy.close();

  assert.equal(lostResponse, 'connection-lost', 'the client must end up without the response');

  // Meanwhile the operation committed server-side.
  const committed = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key]);
  assert.equal(committed.rows[0].n, 1, 'exactly one committed operation record exists');

  // The unknown-outcome retry with the original id recovers the SAME result.
  const retry = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true, 'the retry confirms the committed result instead of recreating');

  const shares = await repository.pool.query(
    'SELECT count(*)::int AS n FROM pages WHERE title = $1', ['Pg Idem']);
  const sharesWithKey = await repository.pool.query(
    'SELECT count(*)::int AS n FROM pages p JOIN publish_operations o ON o.result_share_id = p.id WHERE o.request_id = $1', [key]);
  assert.equal(sharesWithKey.rows[0].n, 1, 'exactly one Share exists for this request id');
  assert.ok(shares.rows[0].n >= 1);
});

test('a severed database connection mid-transaction leaves no half state and no running record', async () => {
  const key = 'pg-conn-loss-012345678';

  // Fault injection (explicit): after the operation record is written inside
  // the transaction, the transaction's OWN backend is terminated — the
  // database severs the connection before COMMIT. PostgreSQL must roll
  // everything back. A dedicated throwaway repository instance drives the
  // REAL adapter transaction path (same client, same lock order) so the
  // deliberately killed connection cannot pollute the main suite pool.
  const faultRepo = new PostgresPageRepository(url.href, {
    POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '2',
    POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
    POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
  });
  // Every client the fault pool creates gets its own error absorber: pg
  // routes the first socket error to the pending query, but later emits from
  // the deliberately killed connection must not become uncaught exceptions.
  faultRepo.pool.on('connect', (client) => client.on('error', () => {}));
  const before = {
    audits: (await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
  };
  let failed = false;
  try {
    await faultRepo.withPublishingTransaction(async (tx) => {
      await tx.create({
        id: 'pgconnloss000001',
        htmlContent: '<h1>Conn loss body</h1>',
        createdAt: Date.now(),
        passwordHash: null,
        encryptedPassword: null,
        isProtected: false,
        codeType: 'html',
        title: 'Pg Idem',
        description: null,
        expiresAt: null,
        markdownTheme: null
      });
      await tx.createAuditLog({
        action: 'page.create',
        pageId: 'pgconnloss000001',
        details: JSON.stringify({ codeType: 'html', isProtected: false, source: 'api' }),
        ip: '127.0.0.1'
      });
      await tx.createPublishingOperation({
        actor_namespace: 'legacy-key:conn-loss-fixture',
        request_id: key,
        action: 'create',
        request_digest: 'c'.repeat(64),
        target_id: null,
        result_share_id: 'pgconnloss000001',
        result_revision: '1',
        result_access_revision: '1',
        receipt_encrypted: null,
        created_at: Date.now()
      });
      const pid = await tx.pool.query('SELECT pg_backend_pid() AS pid');
      await tx.pool.query('SELECT pg_terminate_backend($1)', [pid.rows[0].pid]);
    });
    assert.fail('a severed connection must surface as an error, never as success');
  } catch {
    failed = true; // the severed connection surfaces as an unknown outcome
  }
  await faultRepo.pool.end().catch(() => {});
  assert.equal(failed, true, 'fault injection ran and was observed as a failure surface');

  const pages = await repository.pool.query(
    'SELECT count(*)::int AS n FROM pages p JOIN publish_operations o ON o.result_share_id = p.id WHERE o.request_id = $1', [key]);
  assert.equal(pages.rows[0].n, 0, 'no Share/Revision/audit half state survives');

  const operations = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [key]);
  assert.equal(operations.rows[0].n, 0, 'no half-committed operation record and no running record exists');

  const auditsAfter = await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs');
  assert.equal(auditsAfter.rows[0].n, before.audits, 'no half-committed audit entry survives');

  // The request id was never committed: the retry succeeds exactly once.
  const retry = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, undefined);
});
