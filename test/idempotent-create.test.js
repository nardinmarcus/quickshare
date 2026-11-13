const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { randomUUID } = require('node:crypto');
const { hashSecret } = require('../utils/security');

// Idempotent Share creation (T08, issue #32): a create carrying an
// Idempotency-Key can lose its response and still be confirmed and
// safely retried — same key + same input replays the original result,
// same key + different input is a 409, and a genuinely new intent (new
// key) creates a new Share even with identical content. The legacy
// no-header create keeps its historical behavior and is not idempotent.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'legacy-test-key-456';

const app = require('../app');

let server;
let baseUrl;

const MANAGED_ID = 'idem-managed-key';
const MANAGED_SECRET = 'idem-managed-secret-12345';
const ROTATED_SECRET = 'idem-rotated-secret-67890';
let repository;

test.before(async () => {
  repository = app.locals.pageRepository;
  await repository.createApiKey({
    id: MANAGED_ID,
    name: 'Idempotency managed key',
    keyHash: await hashSecret(MANAGED_SECRET),
    keyPrefix: 'qs_idem…',
    createdAt: Date.now()
  });

  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

function request(path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = rawBody !== undefined ? rawBody : (body === undefined ? '' : JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
        resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const managedHeaders = { 'X-API-Key': `qs.${MANAGED_ID}.${MANAGED_SECRET}` };
const legacyHeaders = { 'X-API-Key': 'legacy-test-key-456' };

function apiCreate(headers, body, idempotencyKey) {
  return request('/api/v1/share', {
    method: 'POST',
    headers: idempotencyKey ? { ...headers, 'Idempotency-Key': idempotencyKey } : headers,
    body
  });
}

async function shareCount() {
  return repository.countPages({});
}

test('legacy create without Idempotency-Key keeps its shape and is not idempotent', async () => {
  const body = { htmlContent: '<h1>Plain legacy</h1>', codeType: 'html', title: 'Plain legacy' };
  const before = await shareCount();

  const first = await apiCreate(managedHeaders, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.ok(first.body.urlId);
  assert.equal(first.body.requestId, undefined);

  const second = await apiCreate(managedHeaders, body);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.urlId, first.body.urlId);
  assert.equal(await shareCount(), before + 2);
});

test('same key + same input replays the original result and creates exactly one Share', async () => {
  const key = randomUUID();
  const body = {
    htmlContent: '<h1>Idempotent</h1>',
    codeType: 'html',
    title: 'Idempotent original',
    isProtected: true
  };
  const before = await shareCount();

  const first = await apiCreate(managedHeaders, body, key);
  assert.equal(first.status, 200);
  assert.equal(first.body.requestId, key);
  assert.equal(first.body.replayed, undefined);
  assert.ok(first.body.password, 'first create returns the generated password');

  const replay = await apiCreate(managedHeaders, body, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, first.body.urlId);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.password, first.body.password);
  assert.equal(replay.body.title, 'Idempotent original');
  assert.equal(replay.body.contentRevision, '1');
  assert.equal(replay.body.contentEtag, first.body.contentEtag);
  assert.equal(await shareCount(), before + 1);

  // A different key with identical content is a new publish intent.
  const fresh = await apiCreate(managedHeaders, body, randomUUID());
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.urlId, first.body.urlId);
  assert.equal(await shareCount(), before + 2);
});

test('same key + different input is a 409 and creates nothing', async () => {
  const key = randomUUID();
  const before = await shareCount();

  const first = await apiCreate(managedHeaders, { htmlContent: '<p>one</p>', codeType: 'html' }, key);
  assert.equal(first.status, 200);

  const conflict = await apiCreate(managedHeaders, { htmlContent: '<p>two</p>', codeType: 'html' }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(conflict.body.requestId, key);
  assert.equal(conflict.body.retryable, false);
  assert.equal(await shareCount(), before + 1);
});

test('malformed Idempotency-Key values are rejected before any create', async () => {
  const before = await shareCount();

  for (const bad of ['short', 'has spaces in it........', 'bad!chars-padding-pad', 'x'.repeat(129)]) {
    const res = await apiCreate(managedHeaders, { htmlContent: '<p>x</p>' }, bad);
    assert.equal(res.status, 400, `key ${JSON.stringify(bad)} must be rejected`);
    assert.equal(res.body.code, 'invalid_idempotency_key');
  }

  assert.equal(await shareCount(), before);
});

test('operation status confirms only identifiers, scoped to the caller namespace', async () => {
  const key = randomUUID();
  const created = await apiCreate(managedHeaders, {
    htmlContent: '<p>confirm me</p>',
    codeType: 'html',
    title: 'Confirm title',
    isProtected: true
  }, key);
  assert.equal(created.status, 200);

  const status = await request(`/api/v1/operations/${key}`, { headers: managedHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'committed');
  assert.equal(status.body.shareId, created.body.urlId);
  assert.equal(status.body.contentRevision, '1');
  assert.equal(status.body.accessRevision, '1');
  assert.ok(!status.text.includes(created.body.password), 'status must not leak the password');
  assert.ok(!status.text.includes('Confirm title'), 'status must not leak the title');
  assert.ok(!status.text.includes('confirm me'), 'status must not leak the body');

  // The legacy Key lives in a different namespace: it cannot confirm a
  // managed Key's operation.
  const foreign = await request(`/api/v1/operations/${key}`, { headers: legacyHeaders });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'operation_not_found');

  const unknown = await request(`/api/v1/operations/${randomUUID()}`, { headers: managedHeaders });
  assert.equal(unknown.status, 404);

  const malformed = await request('/api/v1/operations/short', { headers: managedHeaders });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'invalid_request_id');
});

test('a legacy Key confirms its own creates in its own namespace', async () => {
  const key = randomUUID();
  const created = await apiCreate(legacyHeaders, { htmlContent: '<p>legacy idem</p>' }, key);
  assert.equal(created.status, 200);
  assert.equal(created.body.requestId, key);

  const replay = await apiCreate(legacyHeaders, { htmlContent: '<p>legacy idem</p>' }, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, created.body.urlId);
  assert.equal(replay.body.replayed, true);

  const status = await request(`/api/v1/operations/${key}`, { headers: legacyHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.body.shareId, created.body.urlId);

  const foreign = await request(`/api/v1/operations/${key}`, { headers: managedHeaders });
  assert.equal(foreign.status, 404);
});

test('Key rotation keeps the logical namespace: the new secret confirms and replays', async () => {
  const key = randomUUID();
  const body = { htmlContent: '<p>rotation</p>', codeType: 'html', isProtected: true };

  const created = await apiCreate(managedHeaders, body, key);
  assert.equal(created.status, 200);

  await repository.rotateApiKey(MANAGED_ID, {
    keyHash: await hashSecret(ROTATED_SECRET),
    keyPrefix: 'qs_idem…'
  });
  const rotatedHeaders = { 'X-API-Key': `qs.${MANAGED_ID}.${ROTATED_SECRET}` };

  try {
    const replay = await apiCreate(rotatedHeaders, body, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.urlId, created.body.urlId);
    assert.equal(replay.body.password, created.body.password);

    const status = await request(`/api/v1/operations/${key}`, { headers: rotatedHeaders });
    assert.equal(status.status, 200);
    assert.equal(status.body.shareId, created.body.urlId);
  } finally {
    // Restore the original secret for the remaining tests.
    await repository.rotateApiKey(MANAGED_ID, {
      keyHash: await hashSecret(MANAGED_SECRET),
      keyPrefix: 'qs_idem…'
    });
  }
});

test('an operation whose Share has since expired can still be confirmed', async () => {
  const key = randomUUID();
  const body = {
    htmlContent: '<p>short lived</p>',
    codeType: 'html',
    expiresAt: Date.now() + 1200
  };

  const created = await apiCreate(managedHeaders, body, key);
  assert.equal(created.status, 200);

  // Let the Share expire; the replay lookup runs before any timeliness
  // validation, so the committed result is still returned.
  await new Promise(resolve => setTimeout(resolve, 1400));

  const replay = await apiCreate(managedHeaders, body, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, created.body.urlId);
  assert.equal(replay.body.replayed, true);

  const status = await request(`/api/v1/operations/${key}`, { headers: managedHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'committed');

  // A genuinely fresh create with that same (now past) expiry is still
  // refused by the timeliness check.
  const fresh = await apiCreate(managedHeaders, body, randomUUID());
  assert.equal(fresh.status, 400);
});

test('replay returns the ORIGINAL receipt after owner edits, and withholds the password after a policy change', async () => {
  const key = randomUUID();
  const body = {
    htmlContent: '<p>receipt</p>',
    codeType: 'html',
    title: 'Original title',
    isProtected: true
  };

  const created = await apiCreate(managedHeaders, body, key);
  assert.equal(created.status, 200);
  const shareId = created.body.urlId;

  // The owner edits the title afterwards; the replay must still serve
  // the original result, not the Share's current state.
  await repository.updatePageWithAccessPolicy(shareId, { title: 'Edited later' });
  const afterEdit = await apiCreate(managedHeaders, body, key);
  assert.equal(afterEdit.status, 200);
  assert.equal(afterEdit.body.title, 'Original title');
  assert.equal(afterEdit.body.password, created.body.password);

  // An access-policy change (revocation bumps the access revision)
  // stops the password from being returned again, while the operation
  // itself still confirms.
  await repository.revokeAccess(shareId, null);
  const afterPolicy = await apiCreate(managedHeaders, body, key);
  assert.equal(afterPolicy.status, 200);
  assert.equal(afterPolicy.body.urlId, shareId);
  assert.equal(afterPolicy.body.password, null);
});

test('deleting the result Share tombstones the operation: replay is 410 and never resurrects', async () => {
  const key = randomUUID();
  const body = { htmlContent: '<p>delete me</p>', codeType: 'html' };

  const created = await apiCreate(managedHeaders, body, key);
  assert.equal(created.status, 200);
  const before = await shareCount();

  await repository.deletePage(created.body.urlId);
  assert.equal(await shareCount(), before - 1);

  const replay = await apiCreate(managedHeaders, body, key);
  assert.equal(replay.status, 410);
  assert.equal(replay.body.code, 'operation_result_unavailable');
  assert.equal(await shareCount(), before - 1, 'a tombstoned retry must not recreate the Share');

  const status = await request(`/api/v1/operations/${key}`, { headers: managedHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'result_unavailable');
  assert.equal(status.body.shareId, created.body.urlId);
});

test('concurrent identical creates with one key produce exactly one Share', async () => {
  const key = randomUUID();
  const body = { htmlContent: '<p>race</p>', codeType: 'html', title: 'Race' };
  const before = await shareCount();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => apiCreate(managedHeaders, body, key))
  );

  for (const res of results) {
    assert.equal(res.status, 200);
  }
  const ids = new Set(results.map(res => res.body.urlId));
  assert.equal(ids.size, 1);
  assert.equal(await shareCount(), before + 1);
});

test('write maintenance refuses idempotent creates retryably; confirmation reads stay up and the same key confirms after', async () => {
  const committedKey = randomUUID();
  const committed = await apiCreate(managedHeaders, { htmlContent: '<p>before pause</p>' }, committedKey);
  assert.equal(committed.status, 200);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const refused = await apiCreate(managedHeaders, { htmlContent: '<p>during pause</p>' }, randomUUID());
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'maintenance');
    assert.equal(refused.body.retryable, true);

    // The status read is not a publishing write: the earlier operation
    // stays confirmable during the pause.
    const status = await request(`/api/v1/operations/${committedKey}`, { headers: managedHeaders });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'committed');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  // After the pause, the same key + input replays the original result.
  const replay = await apiCreate(managedHeaders, { htmlContent: '<p>before pause</p>' }, committedKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, committed.body.urlId);
  assert.equal(replay.body.replayed, true);
});

test('anonymous publish sessions isolate namespaces; the owner lookup reports the actor kind', async () => {
  // First visit mints a signed publish session and exposes only its tag.
  const home = await request('/');
  assert.equal(home.status, 200);
  const setCookie = [].concat(home.headers['set-cookie'] || []);
  const sessionCookie = setCookie.find(value => value.startsWith('publish_session='));
  assert.ok(sessionCookie, 'homepage visit must mint a publish session cookie');
  assert.match(home.text, /<meta name="publish-session-tag" content="[0-9a-f]{16}">/);
  const cookieA = sessionCookie.split(';')[0];

  const key = randomUUID();
  const body = { htmlContent: '<p>browser create</p>', codeType: 'html' };
  const createHeaders = { 'Idempotency-Key': key, Cookie: cookieA };

  const first = await request('/api/pages/create', { method: 'POST', headers: createHeaders, body });
  assert.equal(first.status, 200);
  assert.equal(first.body.requestId, key);

  const replay = await request('/api/pages/create', { method: 'POST', headers: createHeaders, body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, first.body.urlId);
  assert.equal(replay.body.replayed, true);

  // A different browser session presenting the same request identifier
  // is a different namespace: it creates its own Share, never replays
  // the first session's result.
  const homeB = await request('/');
  const setCookieB = [].concat(homeB.headers['set-cookie'] || []);
  const cookieB = setCookieB.find(value => value.startsWith('publish_session=')).split(';')[0];
  assert.notEqual(cookieB, cookieA);

  const foreign = await request('/api/pages/create', {
    method: 'POST',
    headers: { 'Idempotency-Key': key, Cookie: cookieB },
    body
  });
  assert.equal(foreign.status, 200);
  assert.notEqual(foreign.body.urlId, first.body.urlId);

  // The owner can confirm the operation by identifier across namespaces
  // and learns only the actor kind.
  const ownerView = await request(`/admin/operations/${key}`);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body.actorKind, 'publish_session');
  assert.equal(ownerView.body.status, 'committed');

  const ownerMissing = await request(`/admin/operations/${randomUUID()}`);
  assert.equal(ownerMissing.status, 404);
});

test('clone with a request identifier replays to the same clone and sets the completion cookie', async () => {
  const source = await apiCreate(managedHeaders, { htmlContent: '<p>clone source</p>', title: 'Clone source' });
  assert.equal(source.status, 200);
  const before = await shareCount();

  const requestId = randomUUID();
  const formBody = new URLSearchParams({ requestId }).toString();
  const cloneOnce = () => request(`/admin/pages/${source.body.urlId}/clone`, {
    method: 'POST',
    rawBody: formBody,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const first = await cloneOnce();
  assert.equal(first.status, 302);
  const firstLocation = first.headers.location;
  assert.ok(firstLocation.startsWith('/admin/pages/'));
  const doneCookie = [].concat(first.headers['set-cookie'] || [])
    .find(value => value.startsWith('clone_intent_done='));
  assert.ok(doneCookie && doneCookie.includes(requestId), 'clone response must mark the intent done');

  const replay = await cloneOnce();
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.location, firstLocation);
  assert.equal(await shareCount(), before + 1, 'the retry must not mint a second clone');

  // A new identifier is a genuinely new clone intent.
  const second = await request(`/admin/pages/${source.body.urlId}/clone`, {
    method: 'POST',
    rawBody: new URLSearchParams({ requestId: randomUUID() }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  assert.equal(second.status, 302);
  assert.notEqual(second.headers.location, firstLocation);
  assert.equal(await shareCount(), before + 2);
});
