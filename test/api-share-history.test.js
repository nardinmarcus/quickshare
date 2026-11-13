const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Granted history reads and conditional restore for managed API Keys
// (T14, issue #38): after the owner grants read on a Share, a Key can
// page its Revision metadata and read one canonical snapshot; with an
// edit grant (read+update) it can also restore a Revision — through
// the SAME restore transaction the dashboard uses (shared operation
// ledger, replay-before-precondition, no-op rule, audit), in the
// Key's own operation namespace. Purged tombstones stay visible as
// metadata but their payload is 410 everywhere, and no Key-facing
// purge surface exists. Every purge/restore interaction in this file
// goes through the real HTTP endpoints — the purge is committed by
// the dashboard purge route, never by hand-editing repository state.

const DASHBOARD_PASSWORD = 'History1!';

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'test-password';
process.env.ADMIN_DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
process.env.SHARE_API_KEY = 't14-legacy-key';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.TZ = 'UTC';

const app = require('../app');
const repository = app.locals.pageRepository;
const { hashSecret, encryptSecret } = require('../utils/security');

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

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const body = options.body || '';
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        json: res.headers['content-type']?.includes('application/json') && text
          ? JSON.parse(text)
          : null
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? '' : JSON.stringify(body)
  });
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(DASHBOARD_PASSWORD)}`
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCsrf(cookie, pagePath = '/admin/apis') {
  const page = await request(pagePath, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const match = page.text.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match, 'admin page must carry a csrf meta token');
  return match[1];
}

async function seedPage({ id, createdAt = Date.now(), password = null, expiresAt = null, htmlContent = null }) {
  await repository.create({
    id,
    htmlContent: htmlContent ?? `<h1>body-v1-${id}</h1>`,
    createdAt,
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: `title-${id}`,
    description: `description-${id}`,
    expiresAt,
    markdownTheme: null
  });
}

async function seedKey(id, { scopes = null } = {}) {
  const secret = `secret-for-${id}-0123456789abcdef`;
  await repository.createApiKey({
    id,
    name: `Key ${id}`,
    keyHash: await hashSecret(secret),
    keyPrefix: `qs.${id.slice(0, 8)}…`,
    createdAt: Date.now()
  });

  if (scopes) {
    await repository.updateApiKeyScopes(id, scopes);
  }

  return { secret, headers: { 'X-API-Key': `qs.${id}.${secret}` } };
}

async function grantViaAdmin(cookie, csrf, keyId, shareId, permissions = { read: true }) {
  return jsonRequest(`/admin/apis/keys/${keyId}/grants`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { shareId, permissions }
  });
}

async function revokeViaAdmin(cookie, csrf, keyId, shareId) {
  return jsonRequest(`/admin/apis/keys/${keyId}/grants/${shareId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf }
  });
}

function etagFor(id, revision) {
  return `"content:${id}:${revision}"`;
}

async function currentEtag(id) {
  const page = await repository.getById(id);
  return etagFor(id, page.current_revision);
}

// Dashboard content save (the legacy combined route) — advances the
// Share to a new Revision with the given body.
async function dashboardEdit(cookie, csrf, id, htmlContent) {
  const res = await jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': await currentEtag(id) },
    body: { title: `title-${id}`, htmlContent }
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

// Builds one Share with three Revisions; current is Revision 3.
async function threeRevisionShare(cookie, csrf, id) {
  await seedPage({ id, htmlContent: `<h1>body-v1-${id}</h1>` });
  await dashboardEdit(cookie, csrf, id, `<h1>body-v2-${id}</h1>`);
  await dashboardEdit(cookie, csrf, id, `<h1>body-v3-${id}</h1>`);
}

async function purgeViaDashboard(cookie, csrf, id, revision) {
  return jsonRequest(`/admin/pages/${id}/revisions/${revision}/purge`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { confirmRevision: revision }
  });
}

function getHistory(keyHeaders, shareId, query = '') {
  return jsonRequest(`/api/v1/shares/${shareId}/revisions${query}`, { headers: keyHeaders });
}

function getRevision(keyHeaders, shareId, revision, headers = {}) {
  return jsonRequest(`/api/v1/shares/${shareId}/revisions/${revision}`, {
    headers: { ...keyHeaders, ...headers }
  });
}

function postRestore(keyHeaders, shareId, body, { ifMatch, idempotencyKey } = {}) {
  const headers = { ...keyHeaders };

  if (ifMatch !== undefined) {
    headers['If-Match'] = ifMatch;
  }

  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return jsonRequest(`/api/v1/shares/${shareId}/restore`, {
    method: 'POST',
    headers,
    body
  });
}

const FULL_SCOPES = ['share:create', 'share:read', 'share:update'];
const READ_SCOPES = ['share:create', 'share:read'];

test('history reads refuse missing, invalid, legacy and under-scoped credentials', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-auth-share');
  const createOnly = await seedKey('t14-auth-createonly');
  const reader = await seedKey('t14-auth-reader', { scopes: READ_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-auth-reader', 't14-auth-share', { read: true });

  for (const call of [
    headers => getHistory(headers, 't14-auth-share'),
    headers => getRevision(headers, 't14-auth-share', '1')
  ]) {
    const missing = await call({});
    assert.equal(missing.status, 401);

    const invalid = await call({ 'X-API-Key': 'qs.nope.invalidsecret0123456789' });
    assert.equal(invalid.status, 401);

    const legacy = await call({ 'X-API-Key': process.env.SHARE_API_KEY });
    assert.equal(legacy.status, 403);
    assert.equal(legacy.json.code, 'insufficient_scope');

    const underScoped = await call(createOnly.headers);
    assert.equal(underScoped.status, 403);
    assert.equal(underScoped.json.code, 'insufficient_scope');
  }

  // A read grant on ANOTHER Share does not leak this one, and the 404
  // for an ungranted Share is byte-identical to a nonexistent one.
  const stranger = await seedKey('t14-auth-stranger', { scopes: READ_SCOPES });
  await seedPage({ id: 't14-auth-other' });
  await grantViaAdmin(cookie, csrf, 't14-auth-stranger', 't14-auth-other', { read: true });

  const ungranted = await getHistory(stranger.headers, 't14-auth-share');
  assert.equal(ungranted.status, 404);
  assert.equal(ungranted.json.code, 'share_not_found');

  const nonexistent = await getHistory(stranger.headers, 't14-no-such-share');
  assert.equal(nonexistent.status, 404);
  assert.deepEqual(nonexistent.json, ungranted.json);

  const ungrantedSingle = await getRevision(stranger.headers, 't14-auth-share', '1');
  assert.equal(ungrantedSingle.status, 404);
  assert.deepEqual(ungrantedSingle.json, ungranted.json);
});

test('a publish-only grant does not imply history read', async () => {
  const key = await seedKey('t14-publish-key', { scopes: ['share:publish'] });
  await seedPage({ id: 't14-publish-share' });
  await repository.grantShareAccess({
    keyId: 't14-publish-key', shareId: 't14-publish-share',
    permissions: { read: false, update: false, publish: true }
  });

  // The publish scope alone does not even pass the scope guard for a
  // read operation.
  const list = await getHistory(key.headers, 't14-publish-share');
  assert.equal(list.status, 403);

  // Holding the read scope cannot rescue a publish-only grant: the
  // grant half of the conjunction still refuses, as a plain 404.
  await repository.updateApiKeyScopes('t14-publish-key', ['share:create', 'share:read', 'share:publish']);
  const listWithScope = await getHistory(key.headers, 't14-publish-share');
  assert.equal(listWithScope.status, 404);
  assert.equal(listWithScope.json.code, 'share_not_found');

  const single = await getRevision(key.headers, 't14-publish-share', '1');
  assert.equal(single.status, 404);
});

test('history list is metadata-only, newest first, with coherent current flags and pagination', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-list-share');
  const reader = await seedKey('t14-list-reader', { scopes: READ_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-list-reader', 't14-list-share', { read: true });

  const list = await getHistory(reader.headers, 't14-list-share');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.shareId, 't14-list-share');
  assert.equal(list.json.currentRevision, '3');
  assert.equal(list.json.total, 3);
  assert.equal(list.json.limit, 20);
  assert.equal(list.json.offset, 0);
  assert.deepEqual(list.json.revisions.map(entry => entry.revision), ['3', '2', '1']);
  assert.deepEqual(list.json.revisions.map(entry => entry.current), [true, false, false]);
  assert.deepEqual(list.json.revisions.map(entry => entry.purged), [false, false, false]);
  // Metadata only: no snapshot body anywhere in the payload.
  assert.ok(!list.text.includes('body-v1'));
  assert.ok(!list.text.includes('htmlContent'));
  for (const entry of list.json.revisions) {
    assert.equal(typeof entry.createdAt, 'number');
    assert.equal(entry.restoredFromRevision, null);
    assert.equal(entry.purgedAt, null);
  }

  const page1 = await getHistory(reader.headers, 't14-list-share', '?limit=2');
  assert.deepEqual(page1.json.revisions.map(entry => entry.revision), ['3', '2']);
  assert.equal(page1.json.total, 3);

  const page2 = await getHistory(reader.headers, 't14-list-share', '?limit=2&offset=2');
  assert.deepEqual(page2.json.revisions.map(entry => entry.revision), ['1']);
  assert.equal(page2.json.offset, 2);

  const clamped = await getHistory(reader.headers, 't14-list-share', '?limit=500');
  assert.equal(clamped.status, 200);
  assert.equal(clamped.json.limit, 100);

  const badLimit = await getHistory(reader.headers, 't14-list-share', '?limit=0');
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.json.code, 'invalid_limit');

  const badLimitText = await getHistory(reader.headers, 't14-list-share', '?limit=abc');
  assert.equal(badLimitText.status, 400);

  const badOffset = await getHistory(reader.headers, 't14-list-share', '?offset=-1');
  assert.equal(badOffset.status, 400);
  assert.equal(badOffset.json.code, 'invalid_offset');

  // Coherence: after a concurrent edit commits, the next list's flag
  // and pointer have moved together — exactly one current entry, and
  // it is the one currentRevision names.
  await dashboardEdit(cookie, csrf, 't14-list-share', '<h1>body-v4-t14-list-share</h1>');
  const after = await getHistory(reader.headers, 't14-list-share');
  assert.equal(after.json.currentRevision, '4');
  assert.deepEqual(after.json.revisions.map(entry => entry.current), [true, false, false, false]);
  assert.equal(after.json.revisions[0].revision, '4');
});

test('single revision read returns the canonical snapshot with its own ETag and conditional GET', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-single-share');
  const reader = await seedKey('t14-single-reader', { scopes: READ_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-single-reader', 't14-single-share', { read: true });

  const old = await getRevision(reader.headers, 't14-single-share', '2');
  assert.equal(old.status, 200, old.text);
  assert.equal(old.json.revision.htmlContent, '<h1>body-v2-t14-single-share</h1>');
  assert.equal(old.json.revision.revision, '2');
  assert.equal(old.json.revision.current, false);
  assert.equal(old.json.revision.contentEtag, etagFor('t14-single-share', '2'));
  assert.equal(old.headers.etag, etagFor('t14-single-share', '2'));
  assert.equal(old.headers['cache-control'], 'private, no-store');

  const current = await getRevision(reader.headers, 't14-single-share', '3');
  assert.equal(current.json.revision.current, true);
  assert.equal(current.json.revision.contentEtag, etagFor('t14-single-share', '3'));

  const notModified = await getRevision(reader.headers, 't14-single-share', '2', {
    'If-None-Match': etagFor('t14-single-share', '2')
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.text, '');

  const weak = await getRevision(reader.headers, 't14-single-share', '2', {
    'If-None-Match': `W/${etagFor('t14-single-share', '2')}`
  });
  assert.equal(weak.status, 304);

  const star = await getRevision(reader.headers, 't14-single-share', '2', {
    'If-None-Match': '*'
  });
  assert.equal(star.status, 304);

  // The CURRENT revision's tag does not validate an older snapshot.
  const wrongTag = await getRevision(reader.headers, 't14-single-share', '2', {
    'If-None-Match': etagFor('t14-single-share', '3')
  });
  assert.equal(wrongTag.status, 200);

  const unknown = await getRevision(reader.headers, 't14-single-share', '99');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'revision_not_found');

  const malformed = await getRevision(reader.headers, 't14-single-share', 'abc');
  assert.equal(malformed.status, 404);
  assert.equal(malformed.json.code, 'revision_not_found');
});

test('purged tombstone stays visible in the list, its payload is 410, and it cannot be restored', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-tomb-share');
  const editor = await seedKey('t14-tomb-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-tomb-editor', 't14-tomb-share', { update: true });

  // The purge itself goes through the real dashboard endpoint.
  const purged = await purgeViaDashboard(cookie, csrf, 't14-tomb-share', '1');
  assert.equal(purged.status, 200, purged.text);

  const list = await getHistory(editor.headers, 't14-tomb-share');
  assert.equal(list.status, 200);
  const tombstone = list.json.revisions.find(entry => entry.revision === '1');
  assert.equal(tombstone.purged, true);
  assert.equal(typeof tombstone.purgedAt, 'number');
  assert.equal(tombstone.current, false);
  assert.ok(!list.text.includes('body-v1-t14-tomb-share'));

  const single = await getRevision(editor.headers, 't14-tomb-share', '1');
  assert.equal(single.status, 410);
  assert.equal(single.json.code, 'revision_unavailable');
  assert.equal(single.json.revision.revision, '1');
  assert.equal(single.json.revision.purged, true);
  assert.ok(!single.text.includes('body-v1-t14-tomb-share'));

  const restore = await postRestore(editor.headers, 't14-tomb-share', { revision: '1' }, {
    ifMatch: etagFor('t14-tomb-share', '3'),
    idempotencyKey: randomUUID()
  });
  assert.equal(restore.status, 410);
  assert.equal(restore.json.code, 'revision_unavailable');

  // The failed restore changed nothing: current is still Revision 3
  // with its original body.
  const content = await jsonRequest('/api/v1/shares/t14-tomb-share/content', { headers: editor.headers });
  assert.equal(content.json.share.htmlContent, '<h1>body-v3-t14-tomb-share</h1>');
  assert.equal(content.json.share.contentRevision, '3');
});

test('restore makes an old revision current as a NEW revision with API provenance and zero state drift', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't14-restore-share', password: 'First1!' });
  await dashboardEdit(cookie, csrf, 't14-restore-share', '<h1>body-v2-t14-restore-share</h1>');
  await dashboardEdit(cookie, csrf, 't14-restore-share', '<h1>body-v3-t14-restore-share</h1>');
  await repository.setFavorite('t14-restore-share', true);
  const editor = await seedKey('t14-restore-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-restore-editor', 't14-restore-share', { update: true });

  const stateBefore = await jsonRequest('/api/v1/shares/t14-restore-share/state', { headers: editor.headers });
  assert.equal(stateBefore.json.share.isProtected, true);

  const requestId = randomUUID();
  const restored = await postRestore(editor.headers, 't14-restore-share', { revision: '1' }, {
    ifMatch: etagFor('t14-restore-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.success, true);
  assert.equal(restored.json.action, 'share.restore');
  assert.equal(restored.json.requestId, requestId);
  assert.equal(restored.json.sourceRevision, '1');
  assert.equal(restored.json.previousRevision, '3');
  assert.equal(restored.json.contentRevision, '4');
  assert.equal(restored.json.contentEtag, etagFor('t14-restore-share', '4'));
  assert.equal(restored.json.contentChanged, true);
  assert.equal(restored.json.unchanged, false);

  // The restored content is live, as a new Revision whose provenance
  // names the API actor and its restore source.
  const content = await jsonRequest('/api/v1/shares/t14-restore-share/content', { headers: editor.headers });
  assert.equal(content.json.share.htmlContent, '<h1>body-v1-t14-restore-share</h1>');
  assert.equal(content.json.share.contentRevision, '4');

  const meta = await repository.listContentRevisionMeta('t14-restore-share', { limit: 20, offset: 0 });
  const rev4 = meta.revisions.find(entry => entry.revision === '4');
  assert.equal(rev4.source, 'api-restore');
  assert.equal(rev4.actor_type, 'api_key');
  assert.equal(rev4.restored_from_revision, '1');

  // Zero drift outside content: access version, publish state,
  // protection and favorite are exactly as before.
  const stateAfter = await jsonRequest('/api/v1/shares/t14-restore-share/state', { headers: editor.headers });
  assert.equal(stateAfter.json.share.accessRevision, stateBefore.json.share.accessRevision);
  assert.equal(stateAfter.json.share.published, stateBefore.json.share.published);
  assert.equal(stateAfter.json.share.isProtected, true);
  const page = await repository.getById('t14-restore-share');
  assert.equal(Number(page.is_favorite), 1);

  // The outcome is confirmable in the Key's OWN namespace only.
  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: editor.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.restore');
  assert.equal(confirmation.json.contentRevision, '4');
  assert.equal(confirmation.json.shareId, 't14-restore-share');

  const otherKey = await seedKey('t14-restore-other', { scopes: FULL_SCOPES });
  const foreign = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: otherKey.headers });
  assert.equal(foreign.status, 404);
});

test('restoring identical content is a recorded no-op (unchanged, no new revision)', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-noop-share');
  const editor = await seedKey('t14-noop-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-noop-editor', 't14-noop-share', { update: true });

  const requestId = randomUUID();
  const restored = await postRestore(editor.headers, 't14-noop-share', { revision: '3' }, {
    ifMatch: etagFor('t14-noop-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.contentChanged, false);
  assert.equal(restored.json.unchanged, true);
  assert.equal(restored.json.contentRevision, '3');

  const list = await getHistory(editor.headers, 't14-noop-share');
  assert.equal(list.json.total, 3);

  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: editor.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.restore');
  assert.equal(confirmation.json.contentRevision, '3');
});

test('restore precondition and identifier discipline: 428, 412 family, 400, 409', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-cond-share');
  const editor = await seedKey('t14-cond-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-cond-editor', 't14-cond-share', { update: true });

  const missingTag = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    idempotencyKey: randomUUID()
  });
  assert.equal(missingTag.status, 428);
  assert.equal(missingTag.json.code, 'content_precondition_required');
  assert.equal(missingTag.json.contentRevision, '3');

  const stale = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: etagFor('t14-cond-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'content_conflict');
  assert.equal(stale.json.current.htmlContent, '<h1>body-v3-t14-cond-share</h1>');

  // The access tag family never satisfies a content precondition.
  const accessTag = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: '"access:t14-cond-share:1"',
    idempotencyKey: randomUUID()
  });
  assert.equal(accessTag.status, 412);

  const wildcard = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: '*',
    idempotencyKey: randomUUID()
  });
  assert.equal(wildcard.status, 412);

  const weak = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: `W/${etagFor('t14-cond-share', '3')}`,
    idempotencyKey: randomUUID()
  });
  assert.equal(weak.status, 412);

  const missingKey = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: etagFor('t14-cond-share', '3')
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.code, 'invalid_idempotency_key');

  const malformedKey = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: etagFor('t14-cond-share', '3'),
    idempotencyKey: 'short'
  });
  assert.equal(malformedKey.status, 400);
  assert.equal(malformedKey.json.code, 'invalid_idempotency_key');

  // Same identifier, different source: 409. Same identifier, same
  // source, different baseline: also 409 — the digest binds both.
  const requestId = randomUUID();
  const first = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: etagFor('t14-cond-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(first.status, 200, first.text);

  const differentSource = await postRestore(editor.headers, 't14-cond-share', { revision: '2' }, {
    ifMatch: etagFor('t14-cond-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(differentSource.status, 409);
  assert.equal(differentSource.json.code, 'idempotency_conflict');

  const differentBaseline = await postRestore(editor.headers, 't14-cond-share', { revision: '1' }, {
    ifMatch: etagFor('t14-cond-share', '4'),
    idempotencyKey: requestId
  });
  assert.equal(differentBaseline.status, 409);
  assert.equal(differentBaseline.json.code, 'idempotency_conflict');
});

test('response-loss replay returns the committed restore even after the tag went stale and history moved on', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-replay-share');
  const editor = await seedKey('t14-replay-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-replay-editor', 't14-replay-share', { update: true });

  const requestId = randomUUID();
  const attempt = () => postRestore(editor.headers, 't14-replay-share', { revision: '1' }, {
    ifMatch: etagFor('t14-replay-share', '3'),
    idempotencyKey: requestId
  });

  const first = await attempt();
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.contentRevision, '4');

  const replay = await attempt();
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.contentRevision, '4');
  assert.equal(replay.json.sourceRevision, '1');
  assert.equal(replay.json.previousRevision, '3');

  // Even after a later edit moved the Share to Revision 5, the same
  // request still replays the Revision-4 outcome and mints nothing.
  await dashboardEdit(cookie, csrf, 't14-replay-share', '<h1>body-v5-t14-replay-share</h1>');
  const replayLater = await attempt();
  assert.equal(replayLater.status, 200);
  assert.equal(replayLater.json.replayed, true);
  assert.equal(replayLater.json.contentRevision, '4');

  const list = await getHistory(editor.headers, 't14-replay-share');
  assert.equal(list.json.total, 5);
  assert.equal(list.json.currentRevision, '5');
});

test('restore authorization: scope pair, update grant, and revocation refusing even a replay', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-authz-share');
  const readOnlyGrant = await seedKey('t14-authz-readgrant', { scopes: FULL_SCOPES });
  const noUpdateScope = await seedKey('t14-authz-noscope', { scopes: READ_SCOPES });
  const editor = await seedKey('t14-authz-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-authz-readgrant', 't14-authz-share', { read: true });
  await grantViaAdmin(cookie, csrf, 't14-authz-noscope', 't14-authz-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't14-authz-editor', 't14-authz-share', { update: true });

  const attempt = { ifMatch: etagFor('t14-authz-share', '3'), idempotencyKey: randomUUID() };

  // Full scopes but only a READ grant: 404, indistinguishable from a
  // nonexistent Share.
  const readGrant = await postRestore(readOnlyGrant.headers, 't14-authz-share', { revision: '1' }, attempt);
  assert.equal(readGrant.status, 404);
  assert.equal(readGrant.json.code, 'share_not_found');

  const noGrant = await postRestore(readOnlyGrant.headers, 't14-no-such-share', { revision: '1' }, {
    ifMatch: etagFor('t14-no-such-share', '3'),
    idempotencyKey: randomUUID()
  });
  assert.equal(noGrant.status, 404);
  assert.deepEqual(noGrant.json, readGrant.json);

  // Edit grant but missing the update scope: 403 at the scope guard.
  const noScope = await postRestore(noUpdateScope.headers, 't14-authz-share', { revision: '1' }, attempt);
  assert.equal(noScope.status, 403);
  assert.equal(noScope.json.code, 'insufficient_scope');

  // A successful restore, then revocation: the revoked Key cannot
  // replay its own committed result — the grant is re-verified
  // inside the transaction before replay resolution.
  const requestId = randomUUID();
  const committed = await postRestore(editor.headers, 't14-authz-share', { revision: '1' }, {
    ifMatch: etagFor('t14-authz-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(committed.status, 200, committed.text);

  const revoked = await revokeViaAdmin(cookie, csrf, 't14-authz-editor', 't14-authz-share');
  assert.equal(revoked.status, 200, revoked.text);

  const replayAfterRevoke = await postRestore(editor.headers, 't14-authz-share', { revision: '1' }, {
    ifMatch: etagFor('t14-authz-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(replayAfterRevoke.status, 404);
  assert.equal(replayAfterRevoke.json.code, 'share_not_found');
});

test('restore and history work on unpublished and expired Shares under grant', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-hidden-share');
  await seedPage({ id: 't14-expired-share', expiresAt: Date.now() - 60000 });
  await dashboardEdit(cookie, csrf, 't14-expired-share', '<h1>body-v2-t14-expired-share</h1>');
  const editor = await seedKey('t14-hidden-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-hidden-editor', 't14-hidden-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't14-hidden-editor', 't14-expired-share', { update: true });

  // Unpublish through the real dashboard endpoint.
  const page = await repository.getById('t14-hidden-share');
  const unpublished = await jsonRequest('/admin/pages/t14-hidden-share/publish-state', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { published: false, expectedAccessRevision: String(page.access_revision), requestId: randomUUID() }
  });
  assert.equal(unpublished.status, 200, unpublished.text);

  const hiddenList = await getHistory(editor.headers, 't14-hidden-share');
  assert.equal(hiddenList.status, 200);
  assert.equal(hiddenList.json.total, 3);

  const hiddenRestore = await postRestore(editor.headers, 't14-hidden-share', { revision: '2' }, {
    ifMatch: etagFor('t14-hidden-share', '3'),
    idempotencyKey: randomUUID()
  });
  assert.equal(hiddenRestore.status, 200, hiddenRestore.text);
  assert.equal(hiddenRestore.json.contentChanged, true);

  // The restore did not republish the Share.
  const state = await jsonRequest('/api/v1/shares/t14-hidden-share/state', { headers: editor.headers });
  assert.equal(state.json.share.published, false);

  const expiredRestore = await postRestore(editor.headers, 't14-expired-share', { revision: '1' }, {
    ifMatch: etagFor('t14-expired-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(expiredRestore.status, 200, expiredRestore.text);
});

test('no Key-facing purge surface exists, in routes or in capabilities', async () => {
  const editor = await seedKey('t14-nopurge-editor', { scopes: FULL_SCOPES });
  await seedPage({ id: 't14-nopurge-share' });
  await repository.grantShareAccess({
    keyId: 't14-nopurge-editor', shareId: 't14-nopurge-share',
    permissions: { read: true, update: true, publish: false }
  });

  const attempts = [
    ['POST', '/api/v1/shares/t14-nopurge-share/revisions/1/purge'],
    ['DELETE', '/api/v1/shares/t14-nopurge-share/revisions/1'],
    ['POST', '/api/v1/shares/t14-nopurge-share/purge'],
    ['DELETE', '/api/v1/shares/t14-nopurge-share/revisions']
  ];

  for (const [method, path] of attempts) {
    const res = await jsonRequest(path, {
      method,
      headers: { ...editor.headers, 'Idempotency-Key': randomUUID() },
      body: method === 'POST' ? { confirmRevision: '1' } : undefined
    });
    assert.equal(res.status, 404, `${method} ${path} must not exist`);
  }

  const caps = await jsonRequest('/api/v1/capabilities', { headers: editor.headers });
  assert.ok(!caps.text.includes('purge'));
});

test('write maintenance refuses the restore (even a replay) while history reads stay available', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-maint-share');
  const editor = await seedKey('t14-maint-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-maint-editor', 't14-maint-share', { update: true });

  const requestId = randomUUID();
  const committed = await postRestore(editor.headers, 't14-maint-share', { revision: '1' }, {
    ifMatch: etagFor('t14-maint-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(committed.status, 200, committed.text);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const replay = await postRestore(editor.headers, 't14-maint-share', { revision: '1' }, {
      ifMatch: etagFor('t14-maint-share', '3'),
      idempotencyKey: requestId
    });
    assert.equal(replay.status, 503);
    assert.equal(replay.json.code, 'maintenance');

    const fresh = await postRestore(editor.headers, 't14-maint-share', { revision: '2' }, {
      ifMatch: etagFor('t14-maint-share', '4'),
      idempotencyKey: randomUUID()
    });
    assert.equal(fresh.status, 503);

    const list = await getHistory(editor.headers, 't14-maint-share');
    assert.equal(list.status, 200);
    const single = await getRevision(editor.headers, 't14-maint-share', '1');
    assert.equal(single.status, 200);
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  // The committed outcome stayed confirmable throughout.
  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: editor.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.restore');
});

test('restore body discipline: small-parser 413, unknown fields, missing and malformed revision', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-body-share');
  const editor = await seedKey('t14-body-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-body-editor', 't14-body-share', { update: true });
  const attempt = { ifMatch: etagFor('t14-body-share', '3'), idempotencyKey: randomUUID() };

  const extraField = await postRestore(editor.headers, 't14-body-share', { revision: '1', published: true }, attempt);
  assert.equal(extraField.status, 400);
  assert.equal(extraField.json.code, 'invalid_field');
  assert.equal(extraField.json.field, 'published');

  const missing = await postRestore(editor.headers, 't14-body-share', {}, attempt);
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing_field');
  assert.equal(missing.json.field, 'revision');

  const malformed = await postRestore(editor.headers, 't14-body-share', { revision: 'abc' }, attempt);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, 'invalid_field');

  const zero = await postRestore(editor.headers, 't14-body-share', { revision: '0' }, attempt);
  assert.equal(zero.status, 400);

  const arrayBody = await request('/api/v1/shares/t14-body-share/restore', {
    method: 'POST',
    headers: {
      ...editor.headers,
      'Content-Type': 'application/json',
      'If-Match': etagFor('t14-body-share', '3'),
      'Idempotency-Key': randomUUID()
    },
    body: '["1"]'
  });
  assert.equal(arrayBody.status, 400);
  assert.equal(arrayBody.json.code, 'invalid_body');

  // The restore names a version; it does not carry content. The body
  // runs through the 16 KB small-request parser, not the 2 MB Share
  // parser: an oversized body is a 413 before any handler logic.
  const oversized = await request('/api/v1/shares/t14-body-share/restore', {
    method: 'POST',
    headers: {
      ...editor.headers,
      'Content-Type': 'application/json',
      'If-Match': etagFor('t14-body-share', '3'),
      'Idempotency-Key': randomUUID()
    },
    body: JSON.stringify({ revision: '1', pad: 'x'.repeat(20000) })
  });
  assert.equal(oversized.status, 413);
});

test('replay after the restore result revision is purged answers 410 and returns no receipt data', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await threeRevisionShare(cookie, csrf, 't14-scrub-share');
  const editor = await seedKey('t14-scrub-editor', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't14-scrub-editor', 't14-scrub-share', { update: true });

  const requestId = randomUUID();
  const committed = await postRestore(editor.headers, 't14-scrub-share', { revision: '1' }, {
    ifMatch: etagFor('t14-scrub-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(committed.status, 200, committed.text);
  assert.equal(committed.json.contentRevision, '4');

  // Move current past Revision 4, then purge Revision 4 through the
  // real dashboard endpoint: the purge scrubs the restore operation's
  // receipt in the same transaction (T10), across namespaces.
  await dashboardEdit(cookie, csrf, 't14-scrub-share', '<h1>body-v5-t14-scrub-share</h1>');
  const purged = await purgeViaDashboard(cookie, csrf, 't14-scrub-share', '4');
  assert.equal(purged.status, 200, purged.text);

  const replay = await postRestore(editor.headers, 't14-scrub-share', { revision: '1' }, {
    ifMatch: etagFor('t14-scrub-share', '3'),
    idempotencyKey: requestId
  });
  assert.equal(replay.status, 410);
  assert.equal(replay.json.code, 'operation_result_unavailable');
  assert.ok(!replay.text.includes('body-v1-t14-scrub-share'));
});

test('capabilities advertise history reads and restore only when genuinely usable', async () => {
  const full = await seedKey('t14-caps-full', { scopes: FULL_SCOPES });
  const readOnly = await seedKey('t14-caps-read', { scopes: READ_SCOPES });
  const publishOnly = await seedKey('t14-caps-publish', { scopes: ['share:create', 'share:publish'] });

  const fullCaps = (await jsonRequest('/api/v1/capabilities', { headers: full.headers })).json.capabilities;
  const fullIds = fullCaps.operations.map(operation => operation.id);
  assert.ok(fullIds.includes('share.history.read'));
  assert.ok(fullIds.includes('share.revision.read'));
  assert.ok(fullIds.includes('share.restore'));
  const restoreWrite = fullCaps.conditionalWrites.find(entry => entry.operation === 'share.restore');
  assert.ok(restoreWrite);
  assert.equal(restoreWrite.requiresIfMatch, true);
  assert.equal(restoreWrite.requiresIdempotencyKey, true);
  assert.equal(restoreWrite.idempotency.required, true);
  const revisionRead = fullCaps.conditionalReads.find(entry => entry.operation === 'share.revision.read');
  assert.ok(revisionRead);
  assert.equal(revisionRead.etagFormat, '"content:<Share ID>:<Revision>"');

  const readCaps = (await jsonRequest('/api/v1/capabilities', { headers: readOnly.headers })).json.capabilities;
  const readIds = readCaps.operations.map(operation => operation.id);
  assert.ok(readIds.includes('share.history.read'));
  assert.ok(readIds.includes('share.revision.read'));
  assert.ok(!readIds.includes('share.restore'));
  assert.ok(!readCaps.conditionalWrites.some(entry => entry.operation === 'share.restore'));

  const publishCaps = (await jsonRequest('/api/v1/capabilities', { headers: publishOnly.headers })).json.capabilities;
  const publishIds = publishCaps.operations.map(operation => operation.id);
  assert.ok(!publishIds.includes('share.history.read'));
  assert.ok(!publishIds.includes('share.revision.read'));
  assert.ok(!publishIds.includes('share.restore'));

  const legacyCaps = (await jsonRequest('/api/v1/capabilities', {
    headers: { 'X-API-Key': process.env.SHARE_API_KEY }
  })).json.capabilities;
  const legacyIds = legacyCaps.operations.map(operation => operation.id);
  assert.ok(!legacyIds.includes('share.history.read'));
  assert.ok(!legacyIds.includes('share.restore'));
});
