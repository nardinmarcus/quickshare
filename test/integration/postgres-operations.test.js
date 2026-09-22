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

// ---- #33 owner restore on real PostgreSQL: races, atomicity, replay ----

async function pgCreateShare(body, headers = {}) {
  const response = await postJson('/api/pages/create', body, headers);
  assert.equal(response.status, 200);
  return response.body.urlId;
}

async function pgSaveBody(id, revision, newBody) {
  const response = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': `"content:${id}:${revision}"` },
    body: JSON.stringify({ htmlContent: newBody })
  });
  assert.equal(response.status, 200, await response.text());
}

async function pgRestore(id, sourceRevision, expectedRevision, requestId) {
  const response = await fetch(`${origin}/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: origin,
      'If-Match': `"content:${id}:${expectedRevision}"`,
      ...(requestId ? { 'Idempotency-Key': requestId } : {})
    },
    body: JSON.stringify({ revision: String(sourceRevision) })
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

test('restore and content update racing from the same baseline let exactly one writer win', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 RACE BASE</h1>', codeType: 'html', title: 'Pg race' });
  await pgSaveBody(id, '1', '<h1>PG33 RACE V2</h1>');

  // Rendezvous INSIDE two live transactions, before either Share lock.
  // Backend PID evidence prevents a serial pool from masquerading as a race.
  const runTransaction = repository.withPublishingTransaction;
  const backendPids = new Set();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  repository.withPublishingTransaction = function (operation) {
    return runTransaction.call(this, async tx => {
      backendPids.add((await tx.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      if (backendPids.size === 2) release();
      await barrier;
      return operation(tx);
    });
  };
  const [restored, updated] = await Promise.all([
    pgRestore(id, '1', '2', 'pg33-race-restore-012'),
    fetch(`${origin}/admin/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': '"content:' + id + ':2"' },
      body: JSON.stringify({ htmlContent: '<h1>PG33 RACE UPDATE</h1>' })
    }).then(async response => ({ status: response.status, body: await response.json() }))
  ]).finally(() => { repository.withPublishingTransaction = runTransaction; });
  assert.equal(backendPids.size, 2, 'two distinct PostgreSQL connections reached the barrier');
  console.log('issue33 restore/update backend PIDs:', [...backendPids]);

  const statuses = [restored.status, updated.status].sort();
  assert.deepEqual(statuses, [200, 412], `exactly one writer wins: restore=${restored.status} update=${updated.status}`);
  const loser = restored.status === 412 ? restored : updated;
  assert.equal(loser.body.code, 'CONTENT_REVISION_CONFLICT');
  assert.ok(loser.body.current, 'the loser sees the committed current projection');

  const live = await repository.pool.query('SELECT current_revision, html_content FROM pages WHERE id = $1', [id]);
  assert.equal(String(live.rows[0].current_revision), '3', 'exactly ONE revision increment happened');
  const count = await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id]);
  assert.equal(count.rows[0].n, 3, 'the losing transaction left no revision behind');

  if (restored.status === 200) {
    assert.equal(live.rows[0].html_content, '<h1>PG33 RACE BASE</h1>', 'the restore result content is the source snapshot');
  } else {
    assert.equal(live.rows[0].html_content, '<h1>PG33 RACE UPDATE</h1>');
  }
});

test('an injected COMMIT-time failure rolls back restore, revision, audit and operation as one unit', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 ATOMIC BASE</h1>', codeType: 'html', title: 'Pg atomic' });
  await pgSaveBody(id, '1', '<h1>PG33 ATOMIC V2</h1>');
  const requestId = 'pg33-atomic-restore-012';

  const observer = await repository.pool.connect();
  try {
    await observer.query(`
      CREATE FUNCTION issue33_restore_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue33 injected restore failure'; END $$;
      CREATE CONSTRAINT TRIGGER issue33_restore_barrier AFTER INSERT ON publish_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue33_restore_barrier();
    `);

    const before = {
      revisions: (await observer.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n,
      current: String((await observer.query('SELECT current_revision FROM pages WHERE id = $1', [id])).rows[0].current_revision),
      audits: (await observer.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
    };

    const response = await pgRestore(id, '1', '2', requestId);
    assert.equal(response.status, 500, 'the injected failure surfaces as an error, never success');

    const after = {
      revisions: (await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n,
      current: String((await repository.pool.query('SELECT current_revision FROM pages WHERE id = $1', [id])).rows[0].current_revision),
      audits: (await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
    };
    assert.equal(after.revisions, before.revisions, 'no half-committed revision survives');
    assert.equal(after.current, before.current, 'the current pointer never moved');
    assert.equal(after.audits, before.audits, 'no half-committed audit entry survives');
    const operations = await repository.pool.query(
      'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [requestId]);
    assert.equal(operations.rows[0].n, 0, 'no half-committed operation record survives');
  } finally {
    await observer.query('DROP TRIGGER IF EXISTS issue33_restore_barrier ON publish_operations; DROP FUNCTION IF EXISTS issue33_restore_barrier()')
      .catch(() => {});
    observer.release();
  }

  // The request id was never committed: the same retry succeeds exactly once.
  const retry = await pgRestore(id, '1', '2', requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, undefined);
  assert.equal(retry.body.changed, true);
});

test('a severed database connection mid-restore leaves no half state', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 CONN BASE</h1>', codeType: 'html', title: 'Pg conn' });
  await pgSaveBody(id, '1', '<h1>PG33 CONN V2</h1>');
  const requestId = 'pg33-conn-restore-0123';

  const faultRepo = new PostgresPageRepository(url.href, {
    POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '2',
    POSTGRES_STATEMENT_TIMEOUT_MS: '8000', POSTGRES_QUERY_TIMEOUT_MS: '9000',
    POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '15000'
  });
  faultRepo.pool.on('connect', (client) => client.on('error', () => {}));
  const auditsBefore = (await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE page_id = $1', [id])).rows[0].n;
  let severed = false;
  try {
    await assert.rejects(faultRepo.withPublishingTransaction(async (tx) => {
      const result = await tx.restorePageRevision(id, {
        sourceRevision: '1', expectedContentRevision: '2',
        actorSource: 'dashboard-restore', actorIdentity: 'owner-dashboard'
      });
      assert.equal(result.changed, true);
      await tx.createAuditLog({ action: 'page.restore', pageId: id, details: '{}', ip: '127.0.0.1' });
      await tx.createPublishingOperation({
        actor_namespace: 'dashboard-session:conn-loss-fixture',
        request_id: requestId,
        action: 'restore',
        request_digest: 'a'.repeat(64),
        target_id: id,
        result_share_id: id,
        result_revision: String(result.page.current_revision),
        result_access_revision: String(result.page.access_revision),
        receipt_encrypted: null,
        created_at: Date.now()
      });
      const pid = await tx.pool.query('SELECT pg_backend_pid() AS pid');
      severed = true;
      await tx.pool.query('SELECT pg_terminate_backend($1)', [pid.rows[0].pid]);
    }), error => error.code === '57P01' || /connection|terminat/i.test(error.message));
  } finally {
    await faultRepo.pool.end();
  }
  assert.equal(severed, true, 'failure occurred at the named connection-cut injection');
  assert.equal((await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE page_id = $1', [id])).rows[0].n, auditsBefore);

  const current = String((await repository.pool.query('SELECT current_revision FROM pages WHERE id = $1', [id])).rows[0].current_revision);
  assert.equal(current, '2', 'the current pointer never moved');
  const revisions = (await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n;
  assert.equal(revisions, 2, 'no half-committed revision survives');
  const operations = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [requestId]);
  assert.equal(operations.rows[0].n, 0, 'no half-committed operation record exists');

  // The never-committed request id can still be used once, for real.
  const retry = await pgRestore(id, '1', '2', requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, undefined);
});

test('an already-committed restore replays its original result against a long-stale If-Match', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 REPLAY BASE</h1>', codeType: 'html', title: 'Pg replay' });
  await pgSaveBody(id, '1', '<h1>PG33 REPLAY V2</h1>');
  const requestId = 'pg33-replay-restore-012';

  const first = await pgRestore(id, '1', '2', requestId);
  assert.equal(first.status, 200);
  assert.equal(first.body.page.currentRevision, '3');

  // Two later edits move the Share to revision 5 — the original tag is long
  // stale and would 412 a FIRST attempt.
  await pgSaveBody(id, '3', '<h1>PG33 REPLAY V4</h1>');
  await pgSaveBody(id, '4', '<h1>PG33 REPLAY V5</h1>');

  const replay = await pgRestore(id, '1', '2', requestId);
  assert.equal(replay.status, 200, 'the stale tag must NOT turn the retry into a first failure');
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.changed, true);
  assert.equal(replay.body.page.currentRevision, '3', 'the ORIGINAL committed result is confirmed');
  assert.equal(replay.body.page.htmlContent, '<h1>PG33 REPLAY BASE</h1>');

  const live = String((await repository.pool.query('SELECT current_revision FROM pages WHERE id = $1', [id])).rows[0].current_revision);
  assert.equal(live, '5', 'the replay creates no additional revision and never rolls current back');
  const operations = await repository.pool.query(
    'SELECT result_revision FROM publish_operations WHERE request_id = $1', [requestId]);
  assert.equal(operations.rows.length, 1, 'still exactly one operation record');
  assert.equal(String(operations.rows[0].result_revision), '3');
});

test('a same-content restore records a successful operation without minting a revision', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 NOOP BASE</h1>', codeType: 'html', title: 'Pg noop' });
  await pgSaveBody(id, '1', '<h1>PG33 NOOP V2</h1>');

  const before = (await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n;
  const response = await pgRestore(id, '2', '2', 'pg33-noop-restore-0123');
  assert.equal(response.status, 200);
  assert.equal(response.body.changed, false);
  assert.equal(response.body.page.currentRevision, '2');

  const after = (await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n;
  assert.equal(after, before, 'no duplicate body version');

  const operations = await repository.pool.query(
    'SELECT action, result_revision FROM publish_operations WHERE request_id = $1', ['pg33-noop-restore-0123']);
  assert.equal(operations.rows.length, 1, 'the no-op still records a successful operation');
  assert.equal(operations.rows[0].action, 'restore');
  assert.equal(String(operations.rows[0].result_revision), '2');

  // The no-op result replays faithfully too.
  const replay = await pgRestore(id, '2', '2', 'pg33-noop-restore-0123');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.changed, false);
});

test('restore preserves the whole access surface on PostgreSQL: protection, expiry, favorite, views, publication', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 POLICY BASE</h1>', codeType: 'html', title: 'Pg policy' });
  await pgSaveBody(id, '1', '<h1>PG33 POLICY V2</h1>');

  const protect = await fetch(`${origin}/admin/pages/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': '"content:' + id + ':2"' },
    body: JSON.stringify({ isProtected: true, expectedAccessRevision: '1' })
  });
  assert.equal(protect.status, 200);
  await repository.pool.query('UPDATE pages SET expires_at = $2, view_count = 7, is_favorite = TRUE WHERE id = $1', [id, Date.now() + 86400000]);

  const before = (await repository.pool.query(
    'SELECT * FROM pages WHERE id = $1', [id])).rows[0];

  const response = await pgRestore(id, '1', '2', 'pg33-policy-restore-012');
  assert.equal(response.status, 200);

  const after = (await repository.pool.query(
    'SELECT * FROM pages WHERE id = $1', [id])).rows[0];
  const nonContent = row => Object.fromEntries(Object.entries(row).filter(([key]) =>
    !['html_content', 'title', 'description', 'markdown_theme', 'current_revision'].includes(key)));
  assert.deepEqual(nonContent(after), nonContent(before), 'every non-content column including password hash/ciphertext stays identical');
  assert.equal(String(after.access_revision), String(before.access_revision), 'access revision does not move');
  assert.equal(after.is_protected, before.is_protected);
  assert.equal(String(after.expires_at), String(before.expires_at), 'expiry is untouched');
  assert.equal(after.is_favorite, true, 'Favorite Share is untouched');
  assert.equal(Number(after.view_count), 7, 'view counts are untouched');
  assert.equal(after.published, true, 'publication state is untouched');
  assert.equal(after.id, id, 'the share URL identity is untouched');

  const restoredRow = await repository.pool.query(
    'SELECT source, actor, restored_from FROM share_revisions WHERE share_id = $1 ORDER BY revision DESC LIMIT 1', [id]);
  assert.equal(restoredRow.rows[0].source, 'dashboard-restore');
  assert.equal(restoredRow.rows[0].actor, 'owner-dashboard');
  assert.equal(String(restoredRow.rows[0].restored_from), '1');
});

test('restore of a revision beyond 2^53 writes exact decimal pointers on PostgreSQL', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 BIG BASE</h1>', codeType: 'html', title: 'Pg big' });
  await pgSaveBody(id, '1', '<h1>PG33 BIG V2</h1>');

  const bigSource = 9007199254740993n;
  await repository.pool.query(
    `INSERT INTO share_revisions (share_id, revision, html_content, code_type, title, description, markdown_theme, created_at, snapshot_hash, source, actor, restored_from)
     VALUES ($1, $2, '<h1>PG33 BIG ANCIENT</h1>', 'html', NULL, NULL, NULL, $3, 'synthetic', 'web', NULL, NULL)`,
    [id, bigSource, Date.now()]
  );

  const bigCurrent = (bigSource + 1n).toString();
  const bigResult = (bigSource + 2n).toString();
  await repository.pool.query('UPDATE share_revisions SET revision = $2 WHERE share_id = $1 AND revision = 2', [id, bigCurrent]);
  await repository.pool.query('UPDATE pages SET current_revision = $2 WHERE id = $1', [id, bigCurrent]);
  const response = await pgRestore(id, bigSource.toString(), bigCurrent, 'pg33-big-restore-0123');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.page.currentRevision, bigResult);
  assert.equal(response.body.page.htmlContent, '<h1>PG33 BIG ANCIENT</h1>');

  const row = await repository.pool.query(
    'SELECT restored_from::text AS restored_from, revision::text AS revision FROM share_revisions WHERE share_id = $1 AND revision = $2', [id, bigResult]);
  assert.equal(row.rows[0].restored_from, '9007199254740993', 'restored_from is the exact BIGINT source');
  assert.equal(row.rows[0].revision, bigResult);

  const replay = await pgRestore(id, bigSource.toString(), bigCurrent, 'pg33-big-restore-0123');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true, 'the big-source restore replays its committed result');
});

test('restore honours the maintenance gate and audit ordering on PostgreSQL', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG33 PAUSE BASE</h1>', codeType: 'html', title: 'Pg pause' });
  await pgSaveBody(id, '1', '<h1>PG33 PAUSE V2</h1>');
  await repository.setPublishingWritesPaused(true);
  try {
    const blocked = await pgRestore(id, '1', '2', 'pg33-pause-restore-012');
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.retryable, true);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }
  const operations = await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', ['pg33-pause-restore-012']);
  assert.equal(operations.rows[0].n, 0, 'a maintenance-refused attempt records no operation');

  const retried = await pgRestore(id, '1', '2', 'pg33-pause-restore-012');
  assert.equal(retried.status, 200);
  const audit = await repository.pool.query(
    "SELECT details FROM audit_logs WHERE action = 'page.restore' AND page_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
  assert.ok(audit.rows.length >= 1, 'the committed restore writes its audit entry');
  const details = JSON.parse(audit.rows[0].details);
  assert.equal(details.sourceRevision, '1');
  assert.equal(details.changed, true);
});

for (const action of ['content-update', 'restore']) {
  test(`${action}: injected failure AFTER a successful COMMIT confirms original result on retry`, async () => {
    const id = await pgCreateShare({ htmlContent: '<h1>COMMIT source</h1>', codeType: 'html' });
    await pgSaveBody(id, '1', '<h1>COMMIT current</h1>');
    const requestId = `pg33-after-commit-${action}`;
    const send = () => action === 'restore'
      ? pgRestore(id, '1', '2', requestId)
      : fetch(`${origin}/admin/pages/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin,
          'Idempotency-Key': requestId, 'If-Match': `"content:${id}:2"` },
        body: JSON.stringify({ htmlContent: '<h1>COMMIT update</h1>' })
      }).then(async response => ({ status: response.status, body: await response.json() }));
    const runTransaction = repository.withPublishingTransaction;
    let committed = false;
    repository.withPublishingTransaction = async function (...args) {
      const result = await runTransaction.apply(this, args);
      // Injection boundary: real PostgreSQL COMMIT completed; the app has
      // not invoked its response callback yet. Do not call this rollback.
      committed = true;
      throw new Error('issue33 injected response failure AFTER COMMIT');
    };
    try {
      const lost = await send();
      assert.equal(lost.status, 500);
      assert.equal(committed, true);
    } finally { repository.withPublishingTransaction = runTransaction; }
    const beforeRetry = (await repository.pool.query('SELECT * FROM pages WHERE id = $1', [id])).rows[0];
    assert.equal(String(beforeRetry.current_revision), '3', 'observer sees successful COMMIT despite failed response');
    const counts = async () => ({
      revisions: (await repository.pool.query('SELECT count(*)::int AS n FROM share_revisions WHERE share_id = $1', [id])).rows[0].n,
      audits: (await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE page_id = $1', [id])).rows[0].n,
      operations: (await repository.pool.query('SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [requestId])).rows[0].n
    });
    const before = await counts();
    assert.equal(before.operations, 1);
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.page.currentRevision, '3');
    assert.deepEqual(await counts(), before, 'no duplicate snapshot, audit, or result on retry');
    // Later current must not replace the operation's original result.
    await pgSaveBody(id, '3', '<h1>later fourth version</h1>');
    const late = await send();
    assert.equal(late.body.page.currentRevision, '3');
    assert.equal(late.body.page.htmlContent, beforeRetry.html_content);
    assert.equal(String((await repository.getById(id)).current_revision), '4');
  });
}

// ---- #35: owner publication transitions on real PostgreSQL ----

async function pgPublishState(id, action, expectedAccessRevision, requestId) {
  const response = await fetch(`${origin}/admin/pages/${id}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: origin,
      ...(requestId ? { 'Idempotency-Key': requestId } : {})
    },
    body: JSON.stringify({ expectedAccessRevision: String(expectedAccessRevision) })
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

test('unpublish/republish advance published+access_revision atomically and touch nothing else', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG35 ATOMIC</h1>', codeType: 'html', title: 'Pg35 atomic' });

  const down = await pgPublishState(id, 'unpublish', '1', 'pg35-unpub-atomic-001');
  assert.equal(down.status, 200);
  assert.equal(down.body.changed, true);
  assert.equal(down.body.accessRevision, '2');
  assert.equal(down.body.page.published, false);

  const row = (await repository.pool.query('SELECT published, access_revision, current_revision, is_protected, expires_at, view_count FROM pages WHERE id = $1', [id])).rows[0];
  assert.equal(row.published, false);
  assert.equal(String(row.access_revision), '2');
  assert.equal(String(row.current_revision), '1', 'content revision untouched');
  assert.equal(row.is_protected, 0, 'protection untouched');
  assert.equal(row.expires_at, null, 'expiry untouched');
  assert.equal(Number(row.view_count || 0), 0, 'view count untouched');

  const up = await pgPublishState(id, 'republish', '2', 'pg35-repub-atomic-001');
  assert.equal(up.status, 200);
  assert.equal(up.body.accessRevision, '3');
  assert.equal(up.body.published, true);

  const auditActions = (await repository.pool.query(
    'SELECT action FROM audit_logs WHERE page_id = $1 AND action IN ($2, $3) ORDER BY created_at ASC',
    [id, 'page.unpublish', 'page.republish']
  )).rows.map(row => row.action);
  assert.deepEqual(auditActions, ['page.unpublish', 'page.republish']);

  const ledger = (await repository.pool.query(
    "SELECT action, result_revision, result_access_revision FROM publish_operations WHERE request_id IN ('pg35-unpub-atomic-001', 'pg35-repub-atomic-001') ORDER BY created_at ASC"
  )).rows;
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].action, 'unpublish');
  assert.equal(String(ledger[0].result_access_revision), '2');
  assert.equal(ledger[1].action, 'republish');
  assert.equal(String(ledger[1].result_access_revision), '3');

  const sameState = await pgPublishState(id, 'republish', '3', 'pg35-repub-atomic-002');
  assert.equal(sameState.status, 200);
  assert.equal(sameState.body.changed, false, 'same-state repeat records unchanged');
  assert.equal(String((await repository.pool.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision), '3', 'same-state repeat does not bump');
});

test('two independent connections racing the same publication baseline let exactly one transition win', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG35 RACE</h1>', codeType: 'html', title: 'Pg35 race' });

  // Rendezvous INSIDE both transactions before the Share row lock; distinct
  // backend PIDs prove this is a real two-connection race.
  const runTransaction = repository.withPublishingTransaction;
  const backendPids = new Set();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  repository.withPublishingTransaction = function (operation) {
    return runTransaction.call(this, async tx => {
      backendPids.add((await tx.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      if (backendPids.size === 2) release();
      await barrier;
      return operation(tx);
    });
  };
  const requestIdA = 'pg35-race-a-0123456';
  const requestIdB = 'pg35-race-b-0123456';
  const [winner, loser] = await Promise.all([
    pgPublishState(id, 'unpublish', '1', requestIdA),
    pgPublishState(id, 'unpublish', '1', requestIdB)
  ]).finally(() => { repository.withPublishingTransaction = runTransaction; });
  assert.equal(backendPids.size, 2, 'two distinct PostgreSQL connections reached the barrier');
  console.log('issue35 publish-state race backend PIDs:', [...backendPids]);

  const statuses = [winner.status, loser.status].sort();
  assert.deepEqual(statuses, [200, 412], 'exactly one transition commits; the stale one answers 412');
  const committed = winner.status === 200 ? winner : loser;
  assert.equal(committed.body.accessRevision, '2');
  assert.equal(String((await repository.pool.query('SELECT access_revision, published FROM pages WHERE id = $1', [id])).rows[0].access_revision), '2');
  assert.equal((await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id LIKE $1', ['pg35-race-%'])).rows[0].n, 1,
    'only the committed transition leaves a ledger row');

  // The COMMITTED transition's client had its response lost: retrying with
  // the SAME id and ORIGINAL (now stale) baseline replays the committed
  // result instead of re-running the CAS.
  const winnerRequestId = winner.status === 200 ? requestIdA : requestIdB;
  const loserRequestId = winner.status === 200 ? requestIdB : requestIdA;
  const replay = await pgPublishState(id, 'unpublish', '1', winnerRequestId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true, 'the ledger confirms the committed result');
  assert.equal(replay.body.changed, true);
  assert.equal(replay.body.accessRevision, '2');

  // The REFUSED racer received a definitive 412 (not a lost response): its
  // id never committed, so retrying it stays a live CAS and answers 412
  // again against the new baseline — never a fabricated replay.
  const refusedRetry = await pgPublishState(id, 'unpublish', '1', loserRequestId);
  assert.equal(refusedRetry.status, 412);
  assert.equal(String((await repository.pool.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision), '2', 'replays and refusals never re-bump');
});

test('a publish-state transition never blocks or moves the content family: unpublish and content save coexist', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG35 FAMILY</h1>', codeType: 'html', title: 'Pg35 family' });
  const baseline = String((await repository.pool.query('SELECT current_revision FROM pages WHERE id = $1', [id])).rows[0].current_revision);

  // A publication transition while a content save is in flight: the two
  // families touch the same row but different columns; the content CAS is
  // unaffected by the access_revision bump.
  const runTransaction = repository.withPublishingTransaction;
  const backendPids = new Set();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  repository.withPublishingTransaction = function (operation) {
    return runTransaction.call(this, async tx => {
      backendPids.add((await tx.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      if (backendPids.size === 2) release();
      await barrier;
      return operation(tx);
    });
  };
  const [down, save] = await Promise.all([
    pgPublishState(id, 'unpublish', '1', 'pg35-family-unpub-01'),
    fetch(`${origin}/admin/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'If-Match': `"content:${id}:${baseline}"` },
      body: JSON.stringify({ htmlContent: '<h1>PG35 FAMILY V2</h1>' })
    }).then(async response => ({ status: response.status, body: await response.json() }))
  ]).finally(() => { repository.withPublishingTransaction = runTransaction; });
  assert.equal(backendPids.size, 2, 'two distinct PostgreSQL connections reached the barrier');
  assert.equal(down.status, 200);
  assert.equal(save.status, 200, 'the content save wins its own CAS against the unpublish');

  const row = (await repository.pool.query('SELECT published, access_revision, current_revision FROM pages WHERE id = $1', [id])).rows[0];
  assert.equal(row.published, false);
  assert.equal(String(row.access_revision), '2', 'exactly one access bump');
  assert.equal(String(row.current_revision), '2', 'exactly one content revision');
  assert.equal(save.body.page.htmlContent, '<h1>PG35 FAMILY V2</h1>');
});

test('an injected COMMIT-time failure rolls back the publication transition, audit and ledger as one unit', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG35 ROLLBACK</h1>', codeType: 'html', title: 'Pg35 rollback' });
  const requestId = 'pg35-rollback-unpub-01';

  const observer = await repository.pool.connect();
  let observerReleased = false;
  try {
    await observer.query(`
      CREATE FUNCTION issue35_unpub_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue35 injected unpublish failure'; END $$;
      CREATE CONSTRAINT TRIGGER issue35_unpub_barrier AFTER INSERT ON publish_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issue35_unpub_barrier();
    `);

    const before = {
      published: (await observer.query('SELECT published FROM pages WHERE id = $1', [id])).rows[0].published,
      access: String((await observer.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision),
      audits: (await observer.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
    };

    const response = await pgPublishState(id, 'unpublish', '1', requestId);
    assert.equal(response.status, 500, 'the injected failure surfaces as an error, never success');

    const after = {
      published: (await repository.pool.query('SELECT published FROM pages WHERE id = $1', [id])).rows[0].published,
      access: String((await repository.pool.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision),
      audits: (await repository.pool.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n
    };
    assert.equal(after.published, before.published, 'no half-committed publication state survives');
    assert.equal(after.access, before.access, 'the access revision never moved');
    assert.equal(after.audits, before.audits, 'no half-committed audit entry survives');
    assert.equal((await repository.pool.query(
      'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [requestId])).rows[0].n, 0,
      'no half-committed ledger row survives');

    // Remove the injection BEFORE the unknown-outcome client retries: the
    // retry runs as a fresh request and commits exactly once.
    await observer.query('DROP FUNCTION IF EXISTS issue35_unpub_barrier() CASCADE');
    await observer.release();
    observerReleased = true;
  } finally {
    if (!observerReleased) {
      await observer.query('DROP FUNCTION IF EXISTS issue35_unpub_barrier() CASCADE').catch(() => {});
      observer.release();
    }
  }

  const retry = await pgPublishState(id, 'unpublish', '1', requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.changed, true);
  assert.equal(retry.body.accessRevision, '2');
  assert.equal(String((await repository.pool.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision), '2');
  assert.equal((await repository.pool.query(
    'SELECT count(*)::int AS n FROM publish_operations WHERE request_id = $1', [requestId])).rows[0].n, 1,
  'the retry commits exactly one ledger row');
});

test('access revision bumps stay exact past 2^53 and the stale unlock cookie loses every race', async () => {
  const id = await pgCreateShare({ htmlContent: '<h1>PG35 BIGINT</h1>', codeType: 'html', title: 'Pg35 bigint', isProtected: true, password: 'pg35pass' });
  const huge = '9007199254740993'; // 2^53 + 1
  await repository.pool.query('UPDATE pages SET access_revision = $1::bigint WHERE id = $2', [huge, id]);

  const down = await pgPublishState(id, 'unpublish', huge, 'pg35-bigint-unpub-001');
  assert.equal(down.status, 200);
  assert.equal(down.body.accessRevision, '9007199254740994', 'the bump is exact decimal arithmetic, never a float');
  assert.equal(down.body.page.accessRevision, '9007199254740994');

  const up = await pgPublishState(id, 'republish', '9007199254740994', 'pg35-bigint-repub-001');
  assert.equal(up.status, 200);
  assert.equal(up.body.accessRevision, '9007199254740995');

  const stored = String((await repository.pool.query('SELECT access_revision FROM pages WHERE id = $1', [id])).rows[0].access_revision);
  assert.equal(stored, '9007199254740995');
  assert.equal(BigInt(stored) > BigInt(Number.MAX_SAFE_INTEGER), true);

  // Cookie revival refusal at the database boundary: an unlock minted under
  // the pre-transition revision neither counts nor authorizes after BOTH
  // transitions moved the revision (protected Share: revision mismatch is
  // the refusal).
  const oldRevisionView = await repository.recordViewEvent(id, Date.now(), '9007199254740993');
  assert.equal(oldRevisionView, 'protected', 'the old-version cookie is refused (403 family)');
  assert.equal(Number((await repository.pool.query('SELECT view_count FROM pages WHERE id = $1', [id])).rows[0].view_count || 0), 0);

  // While unpublished, even the CURRENT revision cookie is refused as missing.
  await pgPublishState(id, 'unpublish', '9007199254740995', 'pg35-bigint-unpub-002');
  const unpublishedView = await repository.recordViewEvent(id, Date.now(), '9007199254740996');
  assert.equal(unpublishedView, 'not_found', 'unpublished never counts');
  assert.equal(Number((await repository.pool.query('SELECT view_count FROM pages WHERE id = $1', [id])).rows[0].view_count || 0), 0);
});
