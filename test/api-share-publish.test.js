const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Granted unpublish / republish for managed API Keys (T15, issue
// #39): publish is an INDEPENDENT permission. A Key that can edit
// cannot change the publish state unless the owner separately grants
// publish, and a publish-only Key gains no read of the body, the
// history or the list metadata. The transitions reuse the dashboard's
// publish-state transaction (T11) — the same operation ledger,
// access-version compare-and-swap, no-op rule and audit — in the
// Key's own operation namespace, guarded by the current STATE
// If-Match (the access-family tag; a content tag can never stand in
// for it) and a mandatory Idempotency-Key. The credential version and
// the publish grant are re-verified inside the write transaction
// before any replay is honored, so a rotation or revocation that
// committed first refuses the transition. All authorization grants in
// this file are made through the real dashboard endpoints; the one
// purge interaction goes through the real dashboard purge route.

const DASHBOARD_PASSWORD = 't15-dashboard-password';

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = DASHBOARD_PASSWORD;
process.env.ADMIN_DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
process.env.SHARE_API_KEY = 't15-legacy-api-key-0123456789abcdef';
process.env.SESSION_SECRET = 't15-test-session-secret';
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

const PUBLISH_SCOPES = ['share:create', 'share:publish'];
const EDITOR_SCOPES = ['share:create', 'share:read', 'share:update'];

function accessEtagFor(id, revision) {
  return `"access:${id}:${revision}"`;
}

function contentEtagFor(id, revision) {
  return `"content:${id}:${revision}"`;
}

async function getState(keyHeaders, shareId, headers = {}) {
  return jsonRequest(`/api/v1/shares/${shareId}/state`, {
    headers: { ...keyHeaders, ...headers }
  });
}

async function currentAccessEtag(keyHeaders, shareId) {
  const state = await getState(keyHeaders, shareId);
  assert.equal(state.status, 200, state.text);
  return state.headers.etag;
}

function postPublishState(keyHeaders, shareId, action, { ifMatch, idempotencyKey, body = {} } = {}) {
  const headers = { ...keyHeaders };

  if (ifMatch !== undefined) {
    headers['If-Match'] = ifMatch;
  }

  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return jsonRequest(`/api/v1/shares/${shareId}/${action}`, {
    method: 'POST',
    headers,
    body
  });
}

async function unlock(id, password) {
  const response = await jsonRequest(`/view/${id}/password`, {
    method: 'POST',
    body: { password }
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.valid, true);
  const cookieHeader = response.headers['set-cookie']?.find(cookie => cookie.startsWith(`page_access_${id}=`));
  assert.ok(cookieHeader);
  return cookieHeader.split(';')[0];
}

async function publishAuditCount(id) {
  const logs = await repository.listAuditLogs({ limit: 500 });
  return logs.filter(log => log.action === 'page.publish.update' && log.pageId === id).length;
}

test('authorization matrix: editor is refused, publish scope without grant is 404, grant completes the conjunction', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-matrix-share' });
  const editor = await seedKey('t15-matrix-editor', { scopes: EDITOR_SCOPES });
  const publisher = await seedKey('t15-matrix-publisher', { scopes: PUBLISH_SCOPES });
  const creator = await seedKey('t15-matrix-creator');
  await grantViaAdmin(cookie, csrf, 't15-matrix-editor', 't15-matrix-share', { update: true });

  const attempt = { ifMatch: accessEtagFor('t15-matrix-share', '1'), idempotencyKey: randomUUID() };

  const anonymous = await postPublishState({}, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(anonymous.status, 401);

  const invalid = await postPublishState({ 'X-API-Key': 'qs.nope.invalid' }, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(invalid.status, 401);

  const legacy = await postPublishState({ 'X-API-Key': process.env.SHARE_API_KEY }, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(legacy.status, 403);
  assert.equal(legacy.json.code, 'insufficient_scope');

  const createOnly = await postPublishState(creator.headers, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(createOnly.status, 403);
  assert.equal(createOnly.json.code, 'insufficient_scope');

  // The ticket's core rule: a Key that can EDIT still cannot publish.
  // The editor holds read+update scopes and an edit grant on this very
  // Share — the publish operation refuses it at the scope guard.
  const editorAttempt = await postPublishState(editor.headers, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(editorAttempt.status, 403);
  assert.equal(editorAttempt.json.code, 'insufficient_scope');
  const editorRepublish = await postPublishState(editor.headers, 't15-matrix-share', 'republish', attempt);
  assert.equal(editorRepublish.status, 403);

  // Publish scope but no grant on the target: the same 404 as a
  // nonexistent Share — the surface cannot probe existence.
  const noGrant = await postPublishState(publisher.headers, 't15-matrix-share', 'unpublish', attempt);
  assert.equal(noGrant.status, 404);
  assert.equal(noGrant.json.code, 'share_not_found');
  const noShare = await postPublishState(publisher.headers, 't15-no-such-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-no-such-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(noShare.status, 404);
  assert.deepEqual(noShare.json, noGrant.json);

  // A read grant does not complete the publish conjunction either.
  await grantViaAdmin(cookie, csrf, 't15-matrix-publisher', 't15-matrix-share', { read: true });
  const readGrantOnly = await postPublishState(publisher.headers, 't15-matrix-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-matrix-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(readGrantOnly.status, 404);
  assert.equal(readGrantOnly.json.code, 'share_not_found');

  // The publish grant completes it: the request now reaches the
  // transition and succeeds.
  await grantViaAdmin(cookie, csrf, 't15-matrix-publisher', 't15-matrix-share', { publish: true });
  const granted = await postPublishState(publisher.headers, 't15-matrix-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-matrix-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(granted.status, 200, granted.text);
  assert.equal(granted.json.published, false);
});

test('unpublish and republish reuse dashboard semantics: cookies die, password and URL survive, state advances', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-resume-share', password: 'First1!', htmlContent: '<h1>secret-body-t15-resume-share</h1>' });
  const publisher = await seedKey('t15-resume-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-resume-key', 't15-resume-share', { publish: true });

  const oldCookie = await unlock('t15-resume-share', 'First1!');
  assert.equal((await request('/view/t15-resume-share', { headers: { Cookie: oldCookie } })).status, 200);

  const down = await postPublishState(publisher.headers, 't15-resume-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-resume-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(down.status, 200, down.text);
  assert.equal(down.json.success, true);
  assert.equal(down.json.action, 'share.unpublish');
  assert.equal(down.json.shareId, 't15-resume-share');
  assert.equal(down.json.published, false);
  assert.equal(down.json.changed, true);
  assert.equal(down.json.unchanged, false);
  assert.equal(down.json.accessRevision, '2');
  assert.equal(down.json.accessEtag, accessEtagFor('t15-resume-share', '2'));
  assert.equal(await publishAuditCount('t15-resume-share'), 1);

  // While unpublished the public surface is the uniform 404, cookie
  // or not, and the password endpoint mints nothing.
  assert.equal((await request('/view/t15-resume-share', { headers: { Cookie: oldCookie } })).status, 404);
  const passwordAttempt = await jsonRequest('/view/t15-resume-share/password', {
    method: 'POST',
    body: { password: 'First1!' }
  });
  assert.equal(passwordAttempt.status, 404);

  const up = await postPublishState(publisher.headers, 't15-resume-share', 'republish', {
    ifMatch: accessEtagFor('t15-resume-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.action, 'share.republish');
  assert.equal(up.json.published, true);
  assert.equal(up.json.accessRevision, '3');
  assert.equal(await publishAuditCount('t15-resume-share'), 2);

  // The pre-unpublish cookie stays dead after republish; the same
  // password unlocks again on the same URL.
  const staleView = await request('/view/t15-resume-share', { headers: { Cookie: oldCookie } });
  assert.equal(staleView.status, 200);
  assert.equal(staleView.text.includes('secret-body-t15-resume-share'), false);
  const freshCookie = await unlock('t15-resume-share', 'First1!');
  const freshView = await request('/view/t15-resume-share', { headers: { Cookie: freshCookie } });
  assert.equal(freshView.status, 200);
  assert.equal(freshView.text.includes('secret-body-t15-resume-share'), true);

  const page = await repository.getById('t15-resume-share');
  assert.equal(page.is_protected, 1);
  assert.equal(String(page.current_revision), '1');
  assert.equal(String(page.access_revision), '3');
  assert.equal(page.published, true);
});

test('setting the state the Share already has is a recorded unchanged success', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-unchanged-share' });
  const publisher = await seedKey('t15-unchanged-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-unchanged-key', 't15-unchanged-share', { publish: true });

  const requestId = randomUUID();
  const republish = await postPublishState(publisher.headers, 't15-unchanged-share', 'republish', {
    ifMatch: accessEtagFor('t15-unchanged-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(republish.status, 200, republish.text);
  assert.equal(republish.json.published, true);
  assert.equal(republish.json.changed, false);
  assert.equal(republish.json.unchanged, true);
  assert.equal(republish.json.accessRevision, '1');
  assert.equal(await publishAuditCount('t15-unchanged-share'), 0);

  // The no-op still recorded its operation: it replays and confirms.
  const replay = await postPublishState(publisher.headers, 't15-unchanged-share', 'republish', {
    ifMatch: accessEtagFor('t15-unchanged-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.changed, false);

  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: publisher.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.republish');
  assert.equal(confirmation.json.status, 'committed');
  assert.equal(confirmation.json.accessRevision, '1');

  const page = await repository.getById('t15-unchanged-share');
  assert.equal(String(page.access_revision), '1');
});

test('precondition matrix: state tag only — missing 428, content/weak/wildcard/other-share tags 412, stale 412', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-precond-share' });
  await seedPage({ id: 't15-precond-other' });
  const publisher = await seedKey('t15-precond-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-precond-key', 't15-precond-share', { publish: true });

  const missing = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    idempotencyKey: randomUUID()
  });
  assert.equal(missing.status, 428);
  assert.equal(missing.json.code, 'access_precondition_required');
  assert.equal(missing.json.accessRevision, '1');
  assert.equal(missing.json.accessEtag, accessEtagFor('t15-precond-share', '1'));
  assert.equal(missing.json.retryable, false);

  // A content tag can never stand in for the access tag (§7).
  const contentTag = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: contentEtagFor('t15-precond-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(contentTag.status, 412);
  assert.equal(contentTag.json.code, 'access_conflict');

  const weakTag = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: `W/${accessEtagFor('t15-precond-share', '1')}`,
    idempotencyKey: randomUUID()
  });
  assert.equal(weakTag.status, 412);

  const wildcard = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: '*',
    idempotencyKey: randomUUID()
  });
  assert.equal(wildcard.status, 412);

  const tagList = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: `${accessEtagFor('t15-precond-share', '1')}, ${accessEtagFor('t15-precond-share', '2')}`,
    idempotencyKey: randomUUID()
  });
  assert.equal(tagList.status, 412);

  const otherShare = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-precond-other', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(otherShare.status, 412);

  // Failed preconditions record nothing: the current tag still works
  // for a fresh identifier afterwards.
  const down = await postPublishState(publisher.headers, 't15-precond-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-precond-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(down.status, 200, down.text);

  const stale = await postPublishState(publisher.headers, 't15-precond-share', 'republish', {
    ifMatch: accessEtagFor('t15-precond-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'access_conflict');
  assert.equal(stale.json.accessRevision, '2');
  assert.equal(stale.json.accessEtag, accessEtagFor('t15-precond-share', '2'));
});

test('request shape: Idempotency-Key is mandatory and the body carries no fields', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-shape-share' });
  const publisher = await seedKey('t15-shape-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-shape-key', 't15-shape-share', { publish: true });

  const noKey = await postPublishState(publisher.headers, 't15-shape-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-shape-share', '1')
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.code, 'invalid_idempotency_key');

  const badKey = await postPublishState(publisher.headers, 't15-shape-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-shape-share', '1'),
    idempotencyKey: 'short'
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.code, 'invalid_idempotency_key');

  // A field naming anything else — including a password or an expiry
  // a caller might hope to smuggle through — is refused by name.
  const smuggled = await postPublishState(publisher.headers, 't15-shape-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-shape-share', '1'),
    idempotencyKey: randomUUID(),
    body: { expiresAt: null }
  });
  assert.equal(smuggled.status, 400);
  assert.equal(smuggled.json.code, 'invalid_field');
  assert.equal(smuggled.json.field, 'expiresAt');

  const page = await repository.getById('t15-shape-share');
  assert.equal(page.published, true);
  assert.equal(String(page.access_revision), '1');
});

test('idempotency: replay has no duplicate side effects; a different action or baseline under one identifier is a 409', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-idem-share' });
  const publisher = await seedKey('t15-idem-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-idem-key', 't15-idem-share', { publish: true });

  const requestId = randomUUID();
  const first = await postPublishState(publisher.headers, 't15-idem-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-idem-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.accessRevision, '2');
  assert.equal(await publishAuditCount('t15-idem-share'), 1);

  // A network retry with the same identifier and the same (now
  // stale) baseline replays the committed result instead of failing
  // or flipping anything twice.
  const replay = await postPublishState(publisher.headers, 't15-idem-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-idem-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.published, false);
  assert.equal(replay.json.changed, true);
  assert.equal(replay.json.accessRevision, '2');
  assert.equal(await publishAuditCount('t15-idem-share'), 1);

  const page = await repository.getById('t15-idem-share');
  assert.equal(String(page.access_revision), '2');

  const differentBaseline = await postPublishState(publisher.headers, 't15-idem-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-idem-share', '2'),
    idempotencyKey: requestId
  });
  assert.equal(differentBaseline.status, 409);
  assert.equal(differentBaseline.json.code, 'idempotency_conflict');
  assert.equal(differentBaseline.json.requestId, requestId);

  const differentAction = await postPublishState(publisher.headers, 't15-idem-share', 'republish', {
    ifMatch: accessEtagFor('t15-idem-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(differentAction.status, 409);
  assert.equal(differentAction.json.code, 'idempotency_conflict');

  // Operation records live in the caller's own namespace: another
  // publish Key on the same Share can neither confirm nor replay it,
  // and its own use of the same identifier is an independent record.
  const other = await seedKey('t15-idem-other', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-idem-other', 't15-idem-share', { publish: true });
  const foreign = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: other.headers });
  assert.equal(foreign.status, 404);
  const ownUse = await postPublishState(other.headers, 't15-idem-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-idem-share', '2'),
    idempotencyKey: requestId
  });
  assert.equal(ownUse.status, 200, ownUse.text);
  assert.equal(ownUse.json.replayed, undefined);
  assert.equal(ownUse.json.changed, false);
});

test('publish-only Key reads the minimal state and nothing more', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-minimal-share', password: 'First1!' });
  const publisher = await seedKey('t15-minimal-key', { scopes: PUBLISH_SCOPES });
  const reader = await seedKey('t15-minimal-reader', { scopes: ['share:create', 'share:read'] });
  await grantViaAdmin(cookie, csrf, 't15-minimal-key', 't15-minimal-share', { publish: true });
  await grantViaAdmin(cookie, csrf, 't15-minimal-reader', 't15-minimal-share', { read: true });

  // The state response is identical for every authorized caller
  // (parent spec #24 §6) and carries only the restricted fields.
  const viaPublish = await getState(publisher.headers, 't15-minimal-share');
  assert.equal(viaPublish.status, 200, viaPublish.text);
  assert.deepEqual(Object.keys(viaPublish.json.share).sort(), ['accessRevision', 'expiresAt', 'id', 'isProtected', 'published']);
  assert.equal(viaPublish.json.share.isProtected, true);
  const viaRead = await getState(reader.headers, 't15-minimal-share');
  assert.equal(viaRead.status, 200);
  assert.deepEqual(viaPublish.json.share, viaRead.json.share);
  assert.equal(viaPublish.headers.etag, viaRead.headers.etag);

  // No expansion: body, single snapshot and history stay shut (the
  // scope guard answers 403 — the Key holds no read scope at all).
  const content = await jsonRequest('/api/v1/shares/t15-minimal-share/content', { headers: publisher.headers });
  assert.equal(content.status, 403);
  assert.equal(content.json.code, 'insufficient_scope');
  const history = await jsonRequest('/api/v1/shares/t15-minimal-share/revisions', { headers: publisher.headers });
  assert.equal(history.status, 403);
  const single = await jsonRequest('/api/v1/shares/t15-minimal-share/revisions/1', { headers: publisher.headers });
  assert.equal(single.status, 403);
  const update = await jsonRequest('/api/v1/shares/t15-minimal-share/content', {
    method: 'PUT',
    headers: publisher.headers,
    body: { htmlContent: '<p>x</p>', title: 'x', description: 'x', markdownTheme: null }
  });
  assert.equal(update.status, 403);

  // The list still shows the Share (the publish grant matches the
  // list's scope filter) but with neutralized metadata.
  const list = await jsonRequest('/api/v1/shares', { headers: publisher.headers });
  assert.equal(list.status, 200);
  const entry = list.json.shares.find(share => share.id === 't15-minimal-share');
  assert.ok(entry);
  assert.equal(entry.title, null);
  assert.equal(entry.description, null);
  assert.equal(entry.permissions.publish, true);
  assert.equal(entry.permissions.read, false);
  assert.ok(!list.text.includes('title-t15-minimal-share'));
});

test('expired Shares transition under grant and stay expired; republish never extends expiry', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const expiresAt = Date.now() - 60000;
  await seedPage({ id: 't15-expired-share', expiresAt });
  const publisher = await seedKey('t15-expired-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-expired-key', 't15-expired-share', { publish: true });

  const down = await postPublishState(publisher.headers, 't15-expired-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-expired-share', '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(down.status, 200, down.text);

  const up = await postPublishState(publisher.headers, 't15-expired-share', 'republish', {
    ifMatch: accessEtagFor('t15-expired-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.published, true);

  const state = await getState(publisher.headers, 't15-expired-share');
  assert.equal(Number(state.json.share.expiresAt), expiresAt);

  // Publicly the Share is still simply expired (410), not resurrected.
  assert.equal((await request('/view/t15-expired-share')).status, 410);

  const page = await repository.getById('t15-expired-share');
  assert.equal(Number(page.expires_at), expiresAt);
});

test('revocation and rotation refuse later writes and replays', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-revoke-share' });
  const publisher = await seedKey('t15-revoke-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-revoke-key', 't15-revoke-share', { publish: true });

  const requestId = randomUUID();
  const down = await postPublishState(publisher.headers, 't15-revoke-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-revoke-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(down.status, 200, down.text);

  const revoked = await revokeViaAdmin(cookie, csrf, 't15-revoke-key', 't15-revoke-share');
  assert.equal(revoked.status, 200, revoked.text);

  // A fresh write after revocation is the same 404 as no grant.
  const afterRevoke = await postPublishState(publisher.headers, 't15-revoke-share', 'republish', {
    ifMatch: accessEtagFor('t15-revoke-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(afterRevoke.status, 404);
  assert.equal(afterRevoke.json.code, 'share_not_found');

  // Even the earlier committed operation cannot be replayed by the
  // revoked Key: revocation is re-verified before replay.
  const replayAfterRevoke = await postPublishState(publisher.headers, 't15-revoke-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-revoke-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(replayAfterRevoke.status, 404);

  // Rotation keeps the grant (same logical Key); the old secret dies
  // immediately and the new secret can drive the next transition.
  await grantViaAdmin(cookie, csrf, 't15-revoke-key', 't15-revoke-share', { publish: true });
  const rotated = await jsonRequest('/admin/apis/keys/t15-revoke-key/rotate', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });
  assert.equal(rotated.status, 200, rotated.text);

  const oldSecret = await postPublishState(publisher.headers, 't15-revoke-share', 'republish', {
    ifMatch: accessEtagFor('t15-revoke-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(oldSecret.status, 401);

  const newHeaders = { 'X-API-Key': rotated.json.apiKey.secret };
  const withNewSecret = await postPublishState(newHeaders, 't15-revoke-share', 'republish', {
    ifMatch: accessEtagFor('t15-revoke-share', '2'),
    idempotencyKey: randomUUID()
  });
  assert.equal(withNewSecret.status, 200, withNewSecret.text);
  assert.equal(withNewSecret.json.published, true);

  // And the pre-rotation operation stays confirmable by the rotated
  // credential — rotation preserves the logical identity.
  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: newHeaders });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.unpublish');
});

test('write maintenance refuses the transition and its replay; the operation stays confirmable', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-maintenance-share' });
  const publisher = await seedKey('t15-maintenance-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-maintenance-key', 't15-maintenance-share', { publish: true });

  const requestId = randomUUID();
  const down = await postPublishState(publisher.headers, 't15-maintenance-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-maintenance-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(down.status, 200, down.text);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const freshWrite = await postPublishState(publisher.headers, 't15-maintenance-share', 'republish', {
      ifMatch: accessEtagFor('t15-maintenance-share', '2'),
      idempotencyKey: randomUUID()
    });
    assert.equal(freshWrite.status, 503);
    assert.equal(freshWrite.json.code, 'maintenance');
    assert.equal(freshWrite.json.retryable, true);

    const replay = await postPublishState(publisher.headers, 't15-maintenance-share', 'unpublish', {
      ifMatch: accessEtagFor('t15-maintenance-share', '1'),
      idempotencyKey: requestId
    });
    assert.equal(replay.status, 503);

    const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: publisher.headers });
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.json.action, 'share.unpublish');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }
});

test('a content purge never scrubs a publish-state operation: it stays confirmable and replayable', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't15-purge-share' });
  const publisher = await seedKey('t15-purge-key', { scopes: PUBLISH_SCOPES });
  await grantViaAdmin(cookie, csrf, 't15-purge-key', 't15-purge-share', { publish: true });

  const requestId = randomUUID();
  const down = await postPublishState(publisher.headers, 't15-purge-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-purge-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(down.status, 200, down.text);

  // The owner edits the content (Revision 1 stops being current) and
  // then permanently purges Revision 1 through the real purge route.
  // A state operation's receipt carries no content payload and its
  // record has no result version, so the purge must leave it intact —
  // unlike a content operation whose result IS the purged version.
  const edit = await jsonRequest('/admin/pages/t15-purge-share', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': contentEtagFor('t15-purge-share', '1') },
    body: { title: 'title-t15-purge-share', htmlContent: '<h1>body-v2-t15-purge-share</h1>' }
  });
  assert.equal(edit.status, 200, edit.text);

  const purged = await jsonRequest('/admin/pages/t15-purge-share/revisions/1/purge', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { confirmRevision: '1' }
  });
  assert.equal(purged.status, 200, purged.text);

  const confirmation = await jsonRequest(`/api/v1/operations/${requestId}`, { headers: publisher.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.unpublish');
  assert.equal(confirmation.json.status, 'committed');
  assert.equal(confirmation.json.accessRevision, '2');

  const replay = await postPublishState(publisher.headers, 't15-purge-share', 'unpublish', {
    ifMatch: accessEtagFor('t15-purge-share', '1'),
    idempotencyKey: requestId
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.published, false);
  assert.equal(replay.json.accessRevision, '2');
});

test('auto-edit opt-in never mints a publish grant on the Key\'s own creations', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const creator = await seedKey('t15-auto-key', { scopes: [...EDITOR_SCOPES, 'share:publish'] });

  const enabled = await jsonRequest('/admin/apis/keys/t15-auto-key/auto-grant', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { enabled: true }
  });
  assert.equal(enabled.status, 200, enabled.text);

  const created = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: creator.headers,
    body: { htmlContent: '<h1>auto-created</h1>', codeType: 'html', title: 'Auto created' }
  });
  assert.equal(created.status, 200, created.text);
  const shareId = created.json.urlId;
  assert.ok(shareId, created.text);

  // The create transaction minted read+update only — even though this
  // Key also holds the publish scope, auto-edit never grants publish.
  const grant = await repository.getShareGrant('t15-auto-key', shareId);
  assert.ok(grant);
  assert.deepEqual(grant.permissions, { read: true, update: true, publish: false });

  // So the Key can edit its creation but cannot unpublish it.
  const attempt = await postPublishState(creator.headers, shareId, 'unpublish', {
    ifMatch: accessEtagFor(shareId, '1'),
    idempotencyKey: randomUUID()
  });
  assert.equal(attempt.status, 404);
  assert.equal(attempt.json.code, 'share_not_found');
});

test('capabilities advertise publish transitions only to a publish-scoped managed Key', async () => {
  const publisher = await seedKey('t15-caps-publisher', { scopes: PUBLISH_SCOPES });
  const editor = await seedKey('t15-caps-editor', { scopes: EDITOR_SCOPES });
  const full = await seedKey('t15-caps-full', { scopes: [...EDITOR_SCOPES, 'share:publish'] });

  const publisherCaps = (await jsonRequest('/api/v1/capabilities', { headers: publisher.headers })).json.capabilities;
  const publisherIds = publisherCaps.operations.map(operation => operation.id);
  assert.ok(publisherIds.includes('share.unpublish'));
  assert.ok(publisherIds.includes('share.republish'));
  assert.ok(publisherIds.includes('share.state.read'));
  assert.ok(!publisherIds.includes('share.content.read'));
  assert.ok(!publisherIds.includes('share.content.update'));
  assert.ok(!publisherIds.includes('share.history.read'));
  assert.ok(!publisherIds.includes('share.restore'));
  for (const operationId of ['share.unpublish', 'share.republish']) {
    const entry = publisherCaps.conditionalWrites.find(write => write.operation === operationId);
    assert.ok(entry, operationId);
    assert.equal(entry.requiresIfMatch, true);
    assert.equal(entry.requiresIdempotencyKey, true);
    assert.equal(entry.idempotency.required, true);
  }

  // An editor is never told it can publish.
  const editorCaps = (await jsonRequest('/api/v1/capabilities', { headers: editor.headers })).json.capabilities;
  const editorIds = editorCaps.operations.map(operation => operation.id);
  assert.ok(!editorIds.includes('share.unpublish'));
  assert.ok(!editorIds.includes('share.republish'));
  assert.ok(!editorCaps.conditionalWrites.some(write => write.operation === 'share.unpublish'));

  const fullCaps = (await jsonRequest('/api/v1/capabilities', { headers: full.headers })).json.capabilities;
  const fullIds = fullCaps.operations.map(operation => operation.id);
  assert.ok(fullIds.includes('share.unpublish'));
  assert.ok(fullIds.includes('share.content.update'));

  const legacyCaps = (await jsonRequest('/api/v1/capabilities', {
    headers: { 'X-API-Key': process.env.SHARE_API_KEY }
  })).json.capabilities;
  assert.ok(!legacyCaps.operations.map(operation => operation.id).includes('share.unpublish'));
});
