const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue32-legacy-shared-key';
process.env.SESSION_SECRET = 'issue32-idem-secret-0123456789abcdef';

const app = require('../app');

let server;
let baseUrl;

test.before(async () => {
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

function rawRequest(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookies: res.headers['set-cookie'] || [],
        text,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const postJson = (path, body, headers = {}) =>
  rawRequest(path, { method: 'POST', headers, body: JSON.stringify(body) });

async function createManagedKey(name) {
  const res = await postJson('/admin/apis/keys', { name });
  assert.equal(res.status, 201);
  return res.body.apiKey;
}

async function publishSessionCookie() {
  const home = await rawRequest('/');
  const pair = home.setCookies.find(value => value.startsWith('publish_session='))?.split(';')[0];
  assert.ok(pair, 'the homepage must establish the publish session before any submit');
  return pair;
}

const API_BODY = { htmlContent: '<h1>Idem</h1>', codeType: 'html', title: 'Idem' };
const LEGACY = 'issue32-legacy-shared-key';
const ID = 'idem-key-0123456789abcd';

test('Share API: same Idempotency-Key and input confirms the original result', async () => {
  const first = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': ID });
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);

  const replay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': ID });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, first.body.urlId, 'the replay must confirm the original share');
  assert.equal(replay.body.replayed, true);
  const pages = await app.locals.pageRepository.listAdminPages({ limit: null });
  assert.equal(pages.filter(page => page.id === first.body.urlId).length, 1, 'exactly one share exists');
});

test('Share API: same key with different input is a 409 conflict and creates nothing', async () => {
  const before = (await app.locals.pageRepository.listAdminPages({ limit: null })).length;
  const conflict = await postJson('/api/v1/share', { ...API_BODY, title: 'Different' },
    { 'X-API-Key': LEGACY, 'Idempotency-Key': ID });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_ID_CONFLICT');
  assert.equal(conflict.body.retryable, false);
  const after = (await app.locals.pageRepository.listAdminPages({ limit: null })).length;
  assert.equal(after, before, 'a conflicting replay must not create anything');
});

test('Share API: same content with a new request id is a new explicit publish intent', async () => {
  const firstId = ID;
  const replay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': firstId });
  const first = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': 'intent-two-0123456789' });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.urlId, replay.body.urlId, 'same content, new intent => new share');
  assert.equal(first.body.replayed, undefined);
});

test('Share API: legacy request without the header still creates and keeps original fields', async () => {
  const res = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.url.includes('/view/'));
  assert.equal(res.body.replayed, undefined, 'legacy behavior is not claimed idempotent');
  assert.equal(res.body.requestId, undefined);
});

test('Share API: malformed Idempotency-Key values are rejected with 400', async () => {
  for (const key of ['short7', 'a'.repeat(129), 'has space-0123456', 'exclamation-012345!']) {
    const res = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
    assert.equal(res.status, 400, `key ${JSON.stringify(key)} must be rejected`);
    assert.equal(res.body.code, 'INVALID_REQUEST_ID');
  }
});

test('an already-committed request whose expiry has since passed still confirms its result', async () => {
  const key = 'expiry-replay-012345678';
  const body = { ...API_BODY, expiresAt: Date.now() + 80 };
  const first = await postJson('/api/v1/share', body, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  await new Promise(resolve => setTimeout(resolve, 200));
  const replay = await postJson('/api/v1/share', body, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 200, 'the past expiry must not turn a committed request into a fresh one');
  assert.equal(replay.body.urlId, first.body.urlId);
});

test('web creation namespaces replay by an independently signed publish session', async () => {
  const cookiePair = await publishSessionCookie();
  const create = (key) => postJson('/api/pages/create', API_BODY, {
    Cookie: cookiePair,
    'Idempotency-Key': key,
    Origin: baseUrl
  });

  const first = await create('web-create-0123456789000');
  assert.equal(first.status, 200);
  const replay = await create('web-create-0123456789000');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, first.body.urlId, 'the same web session and request id confirm one share');
  const pages = await app.locals.pageRepository.listAdminPages({ limit: null });
  assert.equal(pages.filter(page => page.id === first.body.urlId).length, 1);
});

test('a protected web creation replays the generated password only while the policy is unchanged', async () => {
  const cookiePair = await publishSessionCookie();
  const key = 'protected-replay-0123456';
  const body = { ...API_BODY, isProtected: true };
  const headers = { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl };

  const first = await postJson('/api/pages/create', body, headers);
  assert.equal(first.status, 200);
  assert.ok(first.body.password, 'the original response returns the generated password');
  const shareId = first.body.urlId;

  const replay = await postJson('/api/pages/create', body, headers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, shareId);
  assert.equal(replay.body.password, first.body.password, 'unchanged policy may replay the original password');

  // Owner changes the access policy through the normal management entry.
  const page = await app.locals.pageRepository.getById(shareId);
  const protect = await postJson(`/api/pages/${shareId}/protect`,
    { isProtected: false, expectedAccessRevision: String(page.access_revision) }, { Origin: baseUrl });
  assert.equal(protect.status, 200);

  const afterPolicyChange = await postJson('/api/pages/create', body, headers);
  assert.equal(afterPolicyChange.status, 200);
  assert.equal(afterPolicyChange.body.urlId, shareId);
  assert.ok(!afterPolicyChange.body.password, 'a changed policy must not return the old password');
  assert.equal(afterPolicyChange.body.isProtected, true,
    'isProtected reports the ORIGINAL committed result, not the owner\'s later change');
});

async function tombstoneScenario(batch) {
  const cookiePair = await publishSessionCookie();
  const key = batch ? 'tombstone-batch-0123456' : 'tombstone-web-012345678';
  const headers = { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl };

  const first = await postJson('/api/pages/create', API_BODY, headers);
  assert.equal(first.status, 200);
  const shareId = first.body.urlId;

  const del = batch
    ? await rawRequest('/admin/pages/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ ids: [shareId] })
      })
    : await rawRequest(`/admin/pages/${shareId}`, { method: 'DELETE', headers: { Origin: baseUrl } });
  assert.equal(del.status, 200);

  const replay = await postJson('/api/pages/create', API_BODY, headers);
  assert.equal(replay.status, 410, 'a late replay must not silently rebuild the share');
  assert.equal(replay.body.code, 'RESULT_UNAVAILABLE');

  const pages = await app.locals.pageRepository.listAdminPages({ limit: null });
  assert.equal(pages.filter(page => page.id === shareId).length, 0, 'the share stays deleted');
}

test('deleting a share leaves a tombstone: late replay reports 410 and never revives it', async () => {
  await tombstoneScenario(false);
});

test('batch deletion also tombstones the operation against late replays', async () => {
  await tombstoneScenario(true);
});

test('namespace isolation: another credential with the same request id cannot see or reuse the result', async () => {
  const managed = await createManagedKey('ns-isolation');
  const key = 'cross-ns-0123456789012';
  const legacyFirst = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(legacyFirst.status, 200);

  const managedCreate = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(managedCreate.status, 200, 'the same request id in another namespace is a legitimate new operation');
  assert.notEqual(managedCreate.body.urlId, legacyFirst.body.urlId);

  const legacyReplay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(legacyReplay.body.urlId, legacyFirst.body.urlId, 'each namespace confirms its own result');
});

test('GET /api/v1/operations/:requestId returns status metadata only, scoped to the caller namespace', async () => {
  const managed = await createManagedKey('ops-status');
  const key = 'ops-status-012345678901';
  const created = await postJson('/api/v1/share', { ...API_BODY, isProtected: true },
    { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(created.status, 200);
  assert.ok(created.body.password);

  const res = await rawRequest(`/api/v1/operations/${key}`, { headers: { 'X-API-Key': managed.secret } });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.operations.length, 1);
  const entry = res.body.operations[0];
  assert.equal(entry.shareId, created.body.urlId);
  assert.equal(entry.status, 'succeeded');
  assert.equal(entry.revision, '1');
  assert.equal(entry.accessRevision, '1');
  assert.ok(!res.text.includes('password'), 'operation status never returns password material');
  assert.ok(!res.text.includes('htmlContent'), 'operation status never returns a body');
  assert.ok(!res.text.includes('title'), 'operation status never returns title metadata');
  assert.ok(!res.text.includes('description'), 'operation status never returns description metadata');

  const foreign = await rawRequest(`/api/v1/operations/${key}`, { headers: { 'X-API-Key': LEGACY } });
  assert.equal(foreign.status, 404, 'another namespace cannot see this operation');

  const unknown = await rawRequest('/api/v1/operations/no-such-operation-01', { headers: { 'X-API-Key': managed.secret } });
  assert.equal(unknown.status, 404);
});

test('legacy key operation status is part of the create capability with metadata only', async () => {
  const key = 'legacy-status-012345678';
  await postJson('/api/v1/share', API_BODY, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  const res = await rawRequest(`/api/v1/operations/${key}`, { headers: { 'X-API-Key': LEGACY } });
  assert.equal(res.status, 200);
  assert.equal(res.body.operations.length, 1);
  assert.equal(res.body.operations[0].status, 'succeeded');
  assert.ok(!res.text.includes('password'));
});

test('managed key rotation keeps the logical namespace: the new secret confirms the old operation', async () => {
  const managed = await createManagedKey('rotate-confirm');
  const key = 'rotation-confirm-012345';
  const created = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(created.status, 200);

  const rotated = await postJson(`/admin/apis/keys/${managed.id}/rotate`, {});
  assert.equal(rotated.status, 200);
  const newSecret = rotated.body.apiKey.secret;

  const oldReplay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });
  assert.equal(oldReplay.status, 401, 'the old secret is dead after rotation');

  const newReplay = await postJson('/api/v1/share', API_BODY, { 'X-API-Key': newSecret, 'Idempotency-Key': key });
  assert.equal(newReplay.status, 200);
  assert.equal(newReplay.body.urlId, created.body.urlId, 'the rotated key confirms the old logical operation');
  assert.equal(newReplay.body.replayed, true);
});

test('owner dashboard can review operation results by request id across namespaces', async () => {
  const key = 'owner-review-0123456789';
  const cookiePair = await publishSessionCookie();
  await postJson('/api/pages/create', API_BODY, { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl });
  const managed = await createManagedKey('owner-review');
  await postJson('/api/v1/share', API_BODY, { 'X-API-Key': managed.secret, 'Idempotency-Key': key });

  const res = await rawRequest(`/admin/operations?requestId=${encodeURIComponent(key)}`, { headers: { Origin: baseUrl } });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.operations.length, 2, 'same request id in two namespaces is listed separately');
  const kinds = res.body.operations.map(op => op.namespaceKind).sort();
  assert.ok(kinds.includes('managed-key'));
  assert.ok(kinds.includes('publish-session'));
  for (const entry of res.body.operations) {
    assert.equal(entry.status, 'succeeded');
    assert.ok(entry.shareId, 'the owner sees the resulting share');
    assert.ok(!('password' in entry), 'owner review metadata never includes password material');
  }
});

test('clone with a request id replays the original clone without re-reading the source', async () => {
  const cookiePair = await publishSessionCookie();
  const src = await postJson('/api/pages/create', { htmlContent: '<h1>CloneSource</h1>', codeType: 'html' },
    { Cookie: cookiePair, Origin: baseUrl });
  const sourceId = src.body.urlId;
  const key = 'clone-replay-01234567890';

  const form = (k) => rawRequest(`/admin/pages/${sourceId}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseUrl },
    body: `requestId=${encodeURIComponent(k)}`
  });

  const first = await form(key);
  assert.equal(first.status, 302);
  const cloneId = first.headers.location.split('/').pop();

  const replay = await form(key);
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.location.split('/').pop(), cloneId, 'the same clone intent confirms the original result');

  // The source is deleted; the replay must still confirm the ORIGINAL result
  // rather than re-reading the source to build a fresh copy.
  await rawRequest(`/admin/pages/${sourceId}`, { method: 'DELETE', headers: { Origin: baseUrl } });
  const afterDelete = await form(key);
  assert.equal(afterDelete.status, 302);
  assert.equal(afterDelete.headers.location.split('/').pop(), cloneId);

  // A NEW clone intent after the source is gone must not resurrect anything:
  // it re-reads the (missing) source and 404s like a first-time clone.
  const secondIntent = await form('clone-second-012345678');
  assert.equal(secondIntent.status, 404);

  const pages = await app.locals.pageRepository.listAdminPages({ limit: null });
  assert.equal(pages.filter(page => (page.title || '').endsWith('(Copy)')).length, 1,
    'exactly one clone exists across both attempts');

  // If the CLONE RESULT itself is deleted, the same intent must answer 410 —
  // it checks its own result availability, never re-clones the source.
  await rawRequest(`/admin/pages/${cloneId}`, { method: 'DELETE', headers: { Origin: baseUrl } });
  const afterResultDeleted = await form(key);
  assert.equal(afterResultDeleted.status, 410);
  assert.equal(afterResultDeleted.body.code, 'RESULT_UNAVAILABLE');
  const pagesAfterDelete = await app.locals.pageRepository.listAdminPages({ limit: null });
  assert.equal(pagesAfterDelete.filter(page => (page.title || '').endsWith('(Copy)')).length, 0,
    'sanity: the deleted clone is gone and nothing was rebuilt');
});

// The public-mode PUBLISH_SESSION_REQUIRED branch requires auth ENABLED and
// lives in homepage-access-control.test.js; in auth-disabled mode the
// browser-publish middleware lazily mints a session instead.
test('publishing maintenance pause also stops idempotent creation attempts', async () => {
  const cookiePair = await publishSessionCookie();
  const key = 'maintenance-01234567890';

  await app.locals.pageRepository.setPublishingWritesPaused(true);

  try {
    const blocked = await postJson('/api/pages/create', API_BODY, { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.retryable, true);
  } finally {
    await app.locals.pageRepository.setPublishingWritesPaused(false);
  }

  const after = await postJson('/api/pages/create', API_BODY, { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl });
  assert.equal(after.status, 200, 'the same request id succeeds after maintenance ends');
});

// ---- Rework closure: original-result replay privacy (review A / M1) ----

const OWNER_EDITED_TITLE = 'OWNER_ONLY_TITLE';
const OWNER_EDITED_DESCRIPTION = 'OWNER_ONLY_DESCRIPTION';

async function ownerEditsShareMetadata(shareId, edits) {
  const page = await app.locals.pageRepository.getById(shareId);
  const response = await rawRequest(`/admin/pages/${shareId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'If-Match': `"content:${shareId}:${page.current_revision}"` },
    body: JSON.stringify(edits)
  });
  assert.equal(response.status, 200, `owner edit failed: ${response.text}`);
}

test('replay returns the ORIGINAL committed result metadata, not owner-later edits (protected)', async () => {
  const home = await rawRequest('/');
  const cookiePair = home.setCookies.find(value => value.startsWith('publish_session='))?.split(';')[0];
  const key = 'privacy-protected-012345678';
  const original = {
    htmlContent: '<h1>Original protected body</h1>',
    codeType: 'html',
    title: 'Original Protected Title',
    description: 'Original protected description',
    isProtected: true
  };
  const headers = { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl };

  const first = await postJson('/api/pages/create', original, headers);
  assert.equal(first.status, 200);
  assert.ok(first.body.password);
  assert.equal(first.body.title, 'Original Protected Title');
  const shareId = first.body.urlId;

  // Owner later edits title/description/body and rotates the password through
  // the normal management entries.
  await ownerEditsShareMetadata(shareId, {
    title: OWNER_EDITED_TITLE,
    description: OWNER_EDITED_DESCRIPTION,
    htmlContent: '<h1>Owner replacement body</h1>'
  });
  const page = await app.locals.pageRepository.getById(shareId);
  const protect = await postJson(`/api/pages/${shareId}/protect`,
    { isProtected: true, password: 'NewPass456!', expectedAccessRevision: String(page.access_revision) },
    { Origin: baseUrl });
  assert.equal(protect.status, 200);

  const replay = await postJson('/api/pages/create', original, headers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, shareId);
  assert.equal(replay.body.replayed, true);
  // The replay confirms the ORIGINAL committed result — never the owner's
  // later private metadata — while the rotated password stays withheld.
  assert.equal(replay.body.title, 'Original Protected Title');
  assert.equal(replay.body.description, 'Original protected description');
  assert.equal(replay.body.codeType, 'html');
  assert.equal(replay.body.isProtected, true, 'the original committed result was protected');
  assert.ok(!replay.body.password, 'changed access policy withholds the receipt password');
  assert.ok(!JSON.stringify(replay.body).includes(OWNER_EDITED_TITLE));
  assert.ok(!JSON.stringify(replay.body).includes(OWNER_EDITED_DESCRIPTION));
});

test('replay of an UNPROTECTED creation still returns the original result metadata', async () => {
  const home = await rawRequest('/');
  const cookiePair = home.setCookies.find(value => value.startsWith('publish_session='))?.split(';')[0];
  const key = 'privacy-unprotected-01234567';
  const original = {
    htmlContent: '<h1>Original public body</h1>',
    codeType: 'html',
    title: 'Original Public Title',
    description: 'Original public description'
  };
  const headers = { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl };

  const first = await postJson('/api/pages/create', original, headers);
  assert.equal(first.status, 200);
  const shareId = first.body.urlId;

  await ownerEditsShareMetadata(shareId, {
    title: OWNER_EDITED_TITLE,
    description: OWNER_EDITED_DESCRIPTION,
    htmlContent: '<h1>Owner replacement body two</h1>'
  });

  const replay = await postJson('/api/pages/create', original, headers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.urlId, shareId);
  assert.equal(replay.body.title, 'Original Public Title', 'no-password creations must not lose their original metadata either');
  assert.equal(replay.body.description, 'Original public description');
  assert.ok(!JSON.stringify(replay.body).includes(OWNER_EDITED_TITLE));
  assert.ok(!JSON.stringify(replay.body).includes(OWNER_EDITED_DESCRIPTION));
});

test('field presence is part of the request identity: absent vs explicit null conflict', async () => {
  const key = 'presence-identity-0123456';
  const withoutDescription = { htmlContent: '<h1>Presence</h1>', codeType: 'html', title: 'Presence' };
  const withExplicitNull = { ...withoutDescription, description: null };

  const first = await postJson('/api/v1/share', withoutDescription, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);

  const replay = await postJson('/api/v1/share', withExplicitNull, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 409, '#24 L211: presence is covered by the HMAC, absent != explicit null');
  assert.equal(replay.body.code, 'REQUEST_ID_CONFLICT');
});

// ---- Rework round 2 closures ----

test('field presence covers title as well: absent vs explicit null conflict', async () => {
  const key = 'title-presence-01234567';
  const withoutTitle = { htmlContent: '<h1>TitlePresence</h1>', codeType: 'html' };
  const withNullTitle = { ...withoutTitle, title: null };

  const first = await postJson('/api/v1/share', withoutTitle, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(first.status, 200);

  const replay = await postJson('/api/v1/share', withNullTitle, { 'X-API-Key': LEGACY, 'Idempotency-Key': key });
  assert.equal(replay.status, 409, 'absent vs explicit-null title are different literal requests');
  assert.equal(replay.body.code, 'REQUEST_ID_CONFLICT');
});

test('WEB entry: an already-committed request whose expiry has passed still confirms (non-PG)', async () => {
  const cookiePair = await publishSessionCookie();
  const key = 'web-expiry-confirm-012345';
  const body = { ...API_BODY, expiresAt: Date.now() + 80 };
  const headers = { Cookie: cookiePair, 'Idempotency-Key': key, Origin: baseUrl };

  const first = await postJson('/api/pages/create', body, headers);
  assert.equal(first.status, 200);
  await new Promise(resolve => setTimeout(resolve, 200));

  const replay = await postJson('/api/pages/create', body, headers);
  assert.equal(replay.status, 200, 'the server confirms the committed result despite the past expiry');
  assert.equal(replay.body.urlId, first.body.urlId);
  assert.equal(replay.body.replayed, true);
});

test('the homepage carries the CURRENT publish-session tag: stable within a session, fresh after rotation', async () => {
  const tagFrom = async (cookieHeader) => {
    const home = await rawRequest('/', cookieHeader ? { headers: { Cookie: cookieHeader } } : {});
    assert.equal(home.status, 200);
    const match = /documentElement\.dataset\.publishSessionTag='([0-9a-f]+)'/.exec(home.text);
    assert.ok(match, 'the homepage renders the publish-session tag');
    return { tag: match[1], cookie: home.setCookies.find(value => value.startsWith('publish_session='))?.split(';')[0] };
  };

  const firstVisit = await tagFrom();
  assert.ok(firstVisit.cookie);
  const sameSession = await tagFrom(firstVisit.cookie);
  assert.equal(sameSession.tag, firstVisit.tag, 'the same publish session renders the same tag');

  const freshSession = await tagFrom();
  assert.notEqual(freshSession.tag, firstVisit.tag, 'a new publish session renders a different tag');
});

// ---- Rework round 3 closure 1: clone replay completes the browser intent ----

test('a clone REPLAY also completes the intent: completion cookie rides the replay, next click rotates', async () => {
  const cookiePair = await publishSessionCookie();
  const src = await postJson('/api/pages/create', { htmlContent: '<h1>R3 Clone Source</h1>', codeType: 'html' },
    { Cookie: cookiePair, Origin: baseUrl });
  const sourceId = src.body.urlId;
  const key = 'r3-clone-replay-012345678';

  const form = (k) => rawRequest(`/admin/pages/${sourceId}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseUrl },
    body: `requestId=${encodeURIComponent(k)}`
  });

  const first = await form(key);
  assert.equal(first.status, 302);
  const cloneId = first.headers.location.split('/').pop();
  const doneValue = (cookies) => {
    const raw = cookies.find(value => value.startsWith('clone_intent_done=')) || '';
    return raw.split('=')[1]?.split(';')[0] || null;
  };
  assert.equal(doneValue(first.setCookies), key,
    'the first committed clone marks the intent completed');

  // Lost-response style retry: the same intent replays the original clone…
  const replay = await form(key);
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.location.split('/').pop(), cloneId);
  // …and the replay response MUST also carry the completion cookie, so the
  // browser reconciles the intent as completed and the NEXT click starts a
  // fresh explicit clone instead of replaying forever.
  assert.equal(doneValue(replay.setCookies), key, 'the replay marks the intent completed too');

  // Next explicit click (no stored id): a NEW clone intent → a new copy.
  const second = await form('r3-clone-next-012345678');
  assert.equal(second.status, 302);
  assert.notEqual(second.headers.location.split('/').pop(), cloneId, 'the fresh click clones again');

  const pages = await app.locals.pageRepository.listAdminPages({ limit: null });
  const copies = pages.filter(page => (page.title || '').includes('R3 Clone Source (Copy)'));
  assert.equal(copies.length, 2, 'exactly two copies exist: replayed original + fresh explicit clone');
});
