const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Per-Share read grants for managed API Keys (T12, issue #36): the
// owner assigns scopes to a named Key and grants it specific Shares;
// the Key can then list and read back exactly those Shares through the
// v1 resource API. Authorization is the conjunction of the Key's
// current scope and the matching grant — 401 without a valid
// credential, 403 without the operation scope, 404 without a grant
// (indistinguishable from a nonexistent Share). Public visibility
// (unpublished/expired/locked) never judges management reads, and
// neither cookies nor public access rights authorize this surface.

const DASHBOARD_PASSWORD = ['t12', 'dashboard', 'pass', '1'].join('-') + '!';

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = ['t12', 'auth', 'pass', '1'].join('-') + '!';
process.env.ADMIN_DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
process.env.SHARE_API_KEY = ['legacy', 'test', 'key', '345'].join('-');
process.env.SESSION_SECRET = ['t12', 'session', 'secret'].join('-');
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

async function seedPage({ id, createdAt = Date.now(), password = null, expiresAt = null, codeType = 'html', markdownTheme = null }) {
  await repository.create({
    id,
    htmlContent: `<h1>body-${id}</h1>`,
    createdAt,
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType,
    title: `title-${id}`,
    description: `description-${id}`,
    expiresAt,
    markdownTheme
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

test('management reads refuse missing, invalid, legacy and cookie-only callers', async () => {
  await seedPage({ id: 't12-auth-share' });
  const managed = await seedKey('t12-auth-key', { scopes: ['share:create', 'share:read'] });

  for (const path of ['/api/v1/shares', '/api/v1/shares/t12-auth-share/content', '/api/v1/shares/t12-auth-share/state']) {
    const missing = await jsonRequest(path);
    assert.equal(missing.status, 401, `${path} without a credential`);

    const invalid = await jsonRequest(path, { headers: { 'X-API-Key': 'not-a-key' } });
    assert.equal(invalid.status, 401, `${path} with an invalid credential`);

    // The legacy environment Key is create-only by construction: it is
    // authenticated, but holds no management scope.
    const legacy = await jsonRequest(path, { headers: { 'X-API-Key': 'legacy-test-key-345' } });
    assert.equal(legacy.status, 403, `${path} with the legacy Key`);
    assert.equal(legacy.json.code, 'insufficient_scope');

    // A dashboard session cookie is not an API credential.
    const cookie = await loginDashboard();
    const cookieOnly = await jsonRequest(path, { headers: { Cookie: cookie } });
    assert.equal(cookieOnly.status, 401, `${path} with only a dashboard cookie`);
  }

  // A share-access (unlock) cookie does not authorize management reads.
  const protectedShare = 't12-auth-protected';
  await seedPage({ id: protectedShare, password: 'First1!' });
  const unlockResponse = await jsonRequest(`/view/${protectedShare}/password`, {
    method: 'POST',
    body: { password: 'First1!' }
  });
  assert.equal(unlockResponse.status, 200);
  const accessCookie = unlockResponse.headers['set-cookie']
    ?.find(value => value.startsWith(`page_access_${protectedShare}=`))
    ?.split(';')[0];
  assert.ok(accessCookie);
  const withAccessCookie = await jsonRequest(`/api/v1/shares/${protectedShare}/content`, {
    headers: { Cookie: accessCookie }
  });
  assert.equal(withAccessCookie.status, 401);

  // The managed Key, scoped but ungranted, is past authentication and
  // scope: list is an empty 200, targeted reads are 404.
  const list = await jsonRequest('/api/v1/shares', { headers: managed.headers });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.shares, []);
  assert.equal(list.json.nextCursor, null);

  const content = await jsonRequest('/api/v1/shares/t12-auth-share/content', { headers: managed.headers });
  assert.equal(content.status, 404);
  assert.equal(content.json.code, 'share_not_found');
});

test('a create-only managed Key is refused with 403 until the owner assigns the read scope', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const key = await seedKey('t12-scope-key');

  const meBefore = await jsonRequest('/api/v1/me', { headers: key.headers });
  assert.deepEqual(meBefore.json.credential.scopes, ['share:create']);

  const refused = await jsonRequest('/api/v1/shares', { headers: key.headers });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'insufficient_scope');
  assert.equal(refused.json.retryable, false);

  const capsBefore = await jsonRequest('/api/v1/capabilities', { headers: key.headers });
  assert.deepEqual(
    capsBefore.json.capabilities.operations.map(operation => operation.id),
    ['share.create', 'connection.me', 'connection.capabilities', 'operation.status']
  );

  // The publish scope became assignable with T15, when its API
  // operations shipped (the update scope had become assignable with
  // T13). Before their tickets, both were refused rather than stored
  // as dead switches; T15's own suite exercises the publish
  // operations end to end.
  const publishScope = await jsonRequest('/admin/apis/keys/t12-scope-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: ['share:create', 'share:publish'] }
  });
  assert.equal(publishScope.status, 200, publishScope.text);
  assert.deepEqual(publishScope.json.apiKey.scopes, ['share:create', 'share:publish']);

  const unknown = await jsonRequest('/admin/apis/keys/t12-scope-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: ['share:fly'] }
  });
  assert.equal(unknown.status, 400);

  const noCsrf = await jsonRequest('/admin/apis/keys/t12-scope-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie },
    body: { scopes: ['share:read'] }
  });
  assert.equal(noCsrf.status, 403);

  const widened = await jsonRequest('/admin/apis/keys/t12-scope-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: ['share:create', 'share:read'] }
  });
  assert.equal(widened.status, 200);
  assert.deepEqual(widened.json.apiKey.scopes, ['share:create', 'share:read']);
  assert.equal(widened.json.apiKey.auto_grant_new_share_edit, false);

  const meAfter = await jsonRequest('/api/v1/me', { headers: key.headers });
  assert.deepEqual(meAfter.json.credential.scopes, ['share:create', 'share:read']);

  const capsAfter = await jsonRequest('/api/v1/capabilities', { headers: key.headers });
  // T14 (issue #38) deliberately extends this T12 shape: the read
  // scope now also advertises the granted history reads, and the
  // single-Revision read joins conditionalReads with the content
  // ETag family. The restore stays absent — it needs the update
  // scope as well.
  assert.deepEqual(
    capsAfter.json.capabilities.operations.map(operation => operation.id),
    ['share.create', 'connection.me', 'connection.capabilities', 'operation.status', 'share.list', 'share.content.read', 'share.state.read', 'share.history.read', 'share.revision.read']
  );
  assert.deepEqual(
    capsAfter.json.capabilities.conditionalReads.map(entry => entry.operation),
    ['share.content.read', 'share.state.read', 'share.revision.read']
  );

  const listAfter = await jsonRequest('/api/v1/shares', { headers: key.headers });
  assert.equal(listAfter.status, 200);

  const missingKey = await jsonRequest('/admin/apis/keys/no-such-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: ['share:read'] }
  });
  assert.equal(missingKey.status, 404);
});

test('admin grant makes exactly one Share readable: list, content and state with separate ETags', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't12-main-share', password: 'First1!' });
  await repository.setFavorite('t12-main-share', true);
  await seedPage({ id: 't12-other-share' });
  const key = await seedKey('t12-main-key', { scopes: ['share:create', 'share:read'] });

  const noCsrf = await grantViaAdmin(cookie, '', 't12-main-key', 't12-main-share');
  assert.equal(noCsrf.status, 403);

  const created = await grantViaAdmin(cookie, csrf, 't12-main-key', 't12-main-share');
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.created, true);
  assert.deepEqual(created.json.grant.permissions, { read: true, update: false, publish: false });

  const repeated = await grantViaAdmin(cookie, csrf, 't12-main-key', 't12-main-share');
  assert.equal(repeated.status, 200);
  assert.equal(repeated.json.created, false);

  const unknownShare = await grantViaAdmin(cookie, csrf, 't12-main-key', 'no-such-share');
  assert.equal(unknownShare.status, 404);

  const unknownKey = await grantViaAdmin(cookie, csrf, 'no-such-key', 't12-main-share');
  assert.equal(unknownKey.status, 404);

  // The publish permission is grantable since T15, when the
  // unpublish/republish endpoints shipped (edit grants became
  // available with T13). It is granted here on a separate Key/Share
  // pair so this test's read flow stays untouched — a grant replaces
  // the permission set — and T15's own suite exercises the publish
  // operations end to end. Publish alone implies neither read nor
  // update.
  await seedKey('t12-publish-grant-key');
  const publishGrant = await grantViaAdmin(cookie, csrf, 't12-publish-grant-key', 't12-other-share', { publish: true });
  assert.equal(publishGrant.status, 201, publishGrant.text);
  assert.deepEqual(publishGrant.json.grant.permissions, { read: false, update: false, publish: true });

  const grants = await jsonRequest('/admin/apis/keys/t12-main-key/grants', {
    headers: { Cookie: cookie }
  });
  assert.equal(grants.status, 200);
  assert.deepEqual(grants.json.grants.map(grant => grant.shareId), ['t12-main-share']);
  assert.equal(grants.json.grants[0].shareTitle, 'title-t12-main-share');

  // List: only the granted Share, with its real metadata, and no
  // password material, grant internals or Favorite flag anywhere.
  const list = await jsonRequest('/api/v1/shares', { headers: key.headers });
  assert.equal(list.status, 200);
  assert.equal(list.json.shares.length, 1);
  const entry = list.json.shares[0];
  assert.equal(entry.id, 't12-main-share');
  assert.equal(entry.title, 'title-t12-main-share');
  assert.equal(entry.description, 'description-t12-main-share');
  assert.equal(entry.isProtected, true);
  assert.equal(entry.published, true);
  assert.equal(entry.contentRevision, '1');
  assert.equal(entry.accessRevision, '1');
  assert.deepEqual(entry.permissions, { read: true, update: false, publish: false });
  assert.ok(!list.text.includes('password'));
  assert.ok(!list.text.includes('isFavorite'));
  assert.ok(!list.text.includes('can_read'));

  // Content: the exact snapshot representation under its strong ETag.
  const content = await jsonRequest('/api/v1/shares/t12-main-share/content', { headers: key.headers });
  assert.equal(content.status, 200);
  assert.equal(content.headers.etag, '"content:t12-main-share:1"');
  assert.equal(content.headers['cache-control'], 'private, no-store');
  assert.deepEqual(content.json.share, {
    id: 't12-main-share',
    contentRevision: '1',
    htmlContent: '<h1>body-t12-main-share</h1>',
    codeType: 'html',
    title: 'title-t12-main-share',
    description: 'description-t12-main-share',
    markdownTheme: null
  });
  assert.ok(!content.text.includes('password'));

  // State: the restricted field model ONLY — no title, description or
  // body keys at all — under the separate access ETag.
  const state = await jsonRequest('/api/v1/shares/t12-main-share/state', { headers: key.headers });
  assert.equal(state.status, 200);
  assert.equal(state.headers.etag, '"access:t12-main-share:1"');
  assert.equal(state.headers['cache-control'], 'private, no-store');
  assert.deepEqual(state.json.share, {
    id: 't12-main-share',
    published: true,
    isProtected: true,
    expiresAt: null,
    accessRevision: '1'
  });
  assert.ok(!state.text.includes('title-t12-main-share'));
  assert.ok(!state.text.includes('body-t12-main-share'));

  // The ungranted Share stays a plain 404 on both targeted reads.
  const otherContent = await jsonRequest('/api/v1/shares/t12-other-share/content', { headers: key.headers });
  assert.equal(otherContent.status, 404);
  const otherState = await jsonRequest('/api/v1/shares/t12-other-share/state', { headers: key.headers });
  assert.equal(otherState.status, 404);
  const ghostContent = await jsonRequest('/api/v1/shares/never-existed/content', { headers: key.headers });
  assert.equal(ghostContent.status, 404);
  assert.deepEqual(ghostContent.json, otherContent.json);
});

test('conditional reads: weak If-None-Match and * answer 304, tag families are not interchangeable', async () => {
  const key = await seedKey('t12-etag-key', { scopes: ['share:read'] });
  await seedPage({ id: 't12-etag-share' });
  await repository.grantShareAccess({
    keyId: 't12-etag-key',
    shareId: 't12-etag-share',
    permissions: { read: true, update: false, publish: false }
  });

  const contentPath = '/api/v1/shares/t12-etag-share/content';
  const statePath = '/api/v1/shares/t12-etag-share/state';

  const strongHit = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '"content:t12-etag-share:1"' }
  });
  assert.equal(strongHit.status, 304);
  assert.equal(strongHit.headers.etag, '"content:t12-etag-share:1"');
  assert.equal(strongHit.text, '');

  const weakHit = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': 'W/"content:t12-etag-share:1"' }
  });
  assert.equal(weakHit.status, 304);

  const starHit = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '*' }
  });
  assert.equal(starHit.status, 304);

  const listHit = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '"content:t12-etag-share:99", W/"content:t12-etag-share:1"' }
  });
  assert.equal(listHit.status, 304);

  const miss = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '"content:t12-etag-share:99"' }
  });
  assert.equal(miss.status, 200);

  // The access tag does not validate the content representation and
  // vice versa: the two families are distinct by design.
  const wrongFamily = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '"access:t12-etag-share:1"' }
  });
  assert.equal(wrongFamily.status, 200);

  const stateHit = await jsonRequest(statePath, {
    headers: { ...key.headers, 'If-None-Match': 'W/"access:t12-etag-share:1"' }
  });
  assert.equal(stateHit.status, 304);

  const stateWrongFamily = await jsonRequest(statePath, {
    headers: { ...key.headers, 'If-None-Match': '"content:t12-etag-share:1"' }
  });
  assert.equal(stateWrongFamily.status, 200);

  // A content edit advances the content Revision: the old content tag
  // stops matching and the read returns the new snapshot.
  await repository.updatePage('t12-etag-share', { htmlContent: '<h1>body-v2</h1>' });

  const afterEdit = await jsonRequest(contentPath, {
    headers: { ...key.headers, 'If-None-Match': '"content:t12-etag-share:1"' }
  });
  assert.equal(afterEdit.status, 200);
  assert.equal(afterEdit.headers.etag, '"content:t12-etag-share:2"');
  assert.equal(afterEdit.json.share.htmlContent, '<h1>body-v2</h1>');
  assert.equal(afterEdit.json.share.contentRevision, '2');

  // The state tag did NOT move with a content-only edit.
  const stateAfterEdit = await jsonRequest(statePath, {
    headers: { ...key.headers, 'If-None-Match': '"access:t12-etag-share:1"' }
  });
  assert.equal(stateAfterEdit.status, 304);
});

test('unpublished and expired Shares stay readable under management authorization', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie, '/admin/apis');
  const key = await seedKey('t12-visibility-key', { scopes: ['share:read'] });

  await seedPage({ id: 't12-down-share' });
  await seedPage({ id: 't12-expired-share', expiresAt: Date.now() - 60000 });
  await grantViaAdmin(cookie, csrf, 't12-visibility-key', 't12-down-share');
  await grantViaAdmin(cookie, csrf, 't12-visibility-key', 't12-expired-share');

  // Unpublish through the real dashboard operation (T11).
  const page = await repository.getById('t12-down-share');
  const unpublish = await jsonRequest('/admin/pages/t12-down-share/publish-state', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'Idempotency-Key': randomUUID()
    },
    body: { published: false, expectedAccessRevision: String(page.access_revision) }
  });
  assert.equal(unpublish.status, 200, unpublish.text);

  const publicView = await request('/view/t12-down-share');
  assert.equal(publicView.status, 404);
  const publicExpired = await request('/view/t12-expired-share');
  assert.equal(publicExpired.status, 410);

  // Management reads do not reuse the public visibility judgment.
  const downContent = await jsonRequest('/api/v1/shares/t12-down-share/content', { headers: key.headers });
  assert.equal(downContent.status, 200);
  assert.equal(downContent.json.share.htmlContent, '<h1>body-t12-down-share</h1>');

  const downState = await jsonRequest('/api/v1/shares/t12-down-share/state', { headers: key.headers });
  assert.equal(downState.status, 200);
  assert.equal(downState.json.share.published, false);
  // Unpublishing advanced the access revision, so the state ETag moved.
  assert.equal(downState.json.share.accessRevision, '2');
  assert.equal(downState.headers.etag, '"access:t12-down-share:2"');

  const expiredContent = await jsonRequest('/api/v1/shares/t12-expired-share/content', { headers: key.headers });
  assert.equal(expiredContent.status, 200);
  const expiredState = await jsonRequest('/api/v1/shares/t12-expired-share/state', { headers: key.headers });
  assert.equal(expiredState.status, 200);
  assert.equal(expiredState.json.share.published, true);
  assert.ok(expiredState.json.share.expiresAt < Date.now());
});

test('revoke removes access immediately and is audited; rotation keeps grants', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const key = await seedKey('t12-revoke-key', { scopes: ['share:read'] });
  await seedPage({ id: 't12-revoke-share' });
  await grantViaAdmin(cookie, csrf, 't12-revoke-key', 't12-revoke-share');

  const before = await jsonRequest('/api/v1/shares/t12-revoke-share/content', { headers: key.headers });
  assert.equal(before.status, 200);

  // Rotation first: the grant belongs to the logical Key, so the new
  // secret reads immediately and the old one dies.
  const rotated = await jsonRequest('/admin/apis/keys/t12-revoke-key/rotate', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });
  assert.equal(rotated.status, 200, rotated.text);
  assert.deepEqual(rotated.json.apiKey.scopes, ['share:read']);
  const newHeaders = { 'X-API-Key': rotated.json.apiKey.secret };

  const oldDead = await jsonRequest('/api/v1/shares/t12-revoke-share/content', { headers: key.headers });
  assert.equal(oldDead.status, 401);
  const newReads = await jsonRequest('/api/v1/shares/t12-revoke-share/content', { headers: newHeaders });
  assert.equal(newReads.status, 200);

  const revoked = await jsonRequest('/admin/apis/keys/t12-revoke-key/grants/t12-revoke-share', {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf }
  });
  assert.equal(revoked.status, 200);

  const after = await jsonRequest('/api/v1/shares/t12-revoke-share/content', { headers: newHeaders });
  assert.equal(after.status, 404);
  const listAfter = await jsonRequest('/api/v1/shares', { headers: newHeaders });
  assert.deepEqual(listAfter.json.shares, []);

  const revokeAgain = await jsonRequest('/admin/apis/keys/t12-revoke-key/grants/t12-revoke-share', {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf }
  });
  assert.equal(revokeAgain.status, 404);
  assert.equal(revokeAgain.json.code, 'grant_not_found');

  const logs = await repository.listAuditLogs({ limit: 200 });
  const revokeEvents = logs.filter(log => log.action === 'api_key.grant_revoke' && log.pageId === 't12-revoke-share');
  assert.equal(revokeEvents.length, 1);
  assert.equal(JSON.parse(revokeEvents[0].details).apiKeyId, 't12-revoke-key');
});

test('multiple Keys and Shares stay isolated; deleting a Key or a Share removes its grants', async () => {
  const keyA = await seedKey('t12-iso-key-a', { scopes: ['share:read'] });
  const keyB = await seedKey('t12-iso-key-b', { scopes: ['share:read'] });
  await seedPage({ id: 't12-iso-share-1' });
  await seedPage({ id: 't12-iso-share-2' });

  await repository.grantShareAccess({
    keyId: 't12-iso-key-a', shareId: 't12-iso-share-1',
    permissions: { read: true, update: false, publish: false }
  });
  await repository.grantShareAccess({
    keyId: 't12-iso-key-b', shareId: 't12-iso-share-2',
    permissions: { read: true, update: false, publish: false }
  });

  const listA = await jsonRequest('/api/v1/shares', { headers: keyA.headers });
  assert.deepEqual(listA.json.shares.map(share => share.id), ['t12-iso-share-1']);
  const listB = await jsonRequest('/api/v1/shares', { headers: keyB.headers });
  assert.deepEqual(listB.json.shares.map(share => share.id), ['t12-iso-share-2']);

  assert.equal((await jsonRequest('/api/v1/shares/t12-iso-share-2/content', { headers: keyA.headers })).status, 404);
  assert.equal((await jsonRequest('/api/v1/shares/t12-iso-share-1/state', { headers: keyB.headers })).status, 404);

  // Deleting the Share retires its grants.
  await repository.deletePage('t12-iso-share-1');
  assert.equal(await repository.getShareGrant('t12-iso-key-a', 't12-iso-share-1'), null);
  const listAAfter = await jsonRequest('/api/v1/shares', { headers: keyA.headers });
  assert.deepEqual(listAAfter.json.shares, []);

  // Deleting the Key retires its grants.
  await repository.deleteApiKey('t12-iso-key-b');
  assert.equal(await repository.getShareGrant('t12-iso-key-b', 't12-iso-share-2'), null);
  assert.equal((await jsonRequest('/api/v1/shares', { headers: keyB.headers })).status, 401);
});

test('a publish-only grant exposes state and a neutralized list entry, never content', async () => {
  // Seeded through the repository: this ticket's dashboard grants read
  // only, but the authorization model (and later tickets) also know
  // publish grants — their read surface must already behave exactly
  // per spec today.
  const key = await seedKey('t12-publish-key', { scopes: ['share:publish'] });
  await seedPage({ id: 't12-publish-share' });
  await repository.grantShareAccess({
    keyId: 't12-publish-key', shareId: 't12-publish-share',
    permissions: { read: false, update: false, publish: true }
  });

  const me = await jsonRequest('/api/v1/me', { headers: key.headers });
  assert.deepEqual(me.json.credential.scopes, ['share:publish']);

  const caps = await jsonRequest('/api/v1/capabilities', { headers: key.headers });
  const operationIds = caps.json.capabilities.operations.map(operation => operation.id);
  assert.ok(operationIds.includes('share.state.read'));
  assert.ok(operationIds.includes('share.list'));
  assert.ok(!operationIds.includes('share.content.read'));
  assert.ok(!operationIds.includes('share.create'));

  const state = await jsonRequest('/api/v1/shares/t12-publish-share/state', { headers: key.headers });
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.share, {
    id: 't12-publish-share',
    published: true,
    isProtected: false,
    expiresAt: null,
    accessRevision: '1'
  });

  const content = await jsonRequest('/api/v1/shares/t12-publish-share/content', { headers: key.headers });
  assert.equal(content.status, 403);
  assert.equal(content.json.code, 'insufficient_scope');

  const list = await jsonRequest('/api/v1/shares', { headers: key.headers });
  assert.equal(list.status, 200);
  assert.equal(list.json.shares.length, 1);
  assert.equal(list.json.shares[0].title, null);
  assert.equal(list.json.shares[0].description, null);
  assert.deepEqual(list.json.shares[0].permissions, { read: false, update: false, publish: true });

  // The update-implies-read invariant holds at the model layer: an
  // update grant is stored (and reported) with read.
  const updated = await repository.grantShareAccess({
    keyId: 't12-publish-key', shareId: 't12-publish-share',
    permissions: { read: false, update: true, publish: false }
  });
  assert.deepEqual(updated.grant.permissions, { read: true, update: true, publish: false });
});

test('list pagination: stable (createdAt, id) cursor, mixed-case IDs, invalid cursors refused', async () => {
  const key = await seedKey('t12-page-key', { scopes: ['share:read'] });
  const createdAt = 1760000000000;
  const ids = ['pgDelta', 'Pgalpha', 'pgcharlie', 'PgBravo', 'pgecho'];

  for (const id of ids) {
    await seedPage({ id, createdAt });
    await repository.grantShareAccess({
      keyId: 't12-page-key', shareId: id,
      permissions: { read: true, update: false, publish: false }
    });
  }

  // One comparison (code-unit order) drives sort AND cursor filtering,
  // so same-timestamp mixed-case IDs can neither repeat nor vanish
  // between pages.
  const expectedOrder = [...ids].sort((a, b) => (a < b ? -1 : 1));
  const seen = [];
  let cursor = null;

  for (let page = 0; page < 5; page += 1) {
    const path = cursor
      ? `/api/v1/shares?limit=2&cursor=${encodeURIComponent(cursor)}`
      : '/api/v1/shares?limit=2';
    const res = await jsonRequest(path, { headers: key.headers });
    assert.equal(res.status, 200, res.text);
    seen.push(...res.json.shares.map(share => share.id));
    cursor = res.json.nextCursor;

    if (!cursor) {
      break;
    }
  }

  assert.deepEqual(seen, expectedOrder);
  assert.equal(cursor, null);

  const everything = await jsonRequest('/api/v1/shares?limit=500', { headers: key.headers });
  assert.equal(everything.status, 200);
  assert.equal(everything.json.shares.length, 5);

  const badLimit = await jsonRequest('/api/v1/shares?limit=0', { headers: key.headers });
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.json.code, 'invalid_limit');

  const junkLimit = await jsonRequest('/api/v1/shares?limit=abc', { headers: key.headers });
  assert.equal(junkLimit.status, 400);

  const garbageCursor = await jsonRequest('/api/v1/shares?cursor=!!!nope!!!', { headers: key.headers });
  assert.equal(garbageCursor.status, 400);
  assert.equal(garbageCursor.json.code, 'invalid_cursor');

  const wrongShape = Buffer.from(JSON.stringify({ createdAt: 'soon', id: 42 }), 'utf8').toString('base64url');
  const wrongShapeRes = await jsonRequest(`/api/v1/shares?cursor=${wrongShape}`, { headers: key.headers });
  assert.equal(wrongShapeRes.status, 400);
  assert.equal(wrongShapeRes.json.code, 'invalid_cursor');

  const sqlCursor = Buffer.from(JSON.stringify({ createdAt: 1, id: 'x; DROP TABLE pages' }), 'utf8').toString('base64url');
  const sqlCursorRes = await jsonRequest(`/api/v1/shares?cursor=${sqlCursor}`, { headers: key.headers });
  // A well-formed cursor naming a position simply paginates from it;
  // its payload is data, never SQL.
  assert.equal(sqlCursorRes.status, 200);
});

test('grant writes pass the publishing gate while management reads stay up', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const key = await seedKey('t12-gate-key', { scopes: ['share:read'] });
  await seedPage({ id: 't12-gate-share' });
  await seedPage({ id: 't12-gate-share-2' });
  await grantViaAdmin(cookie, csrf, 't12-gate-key', 't12-gate-share');

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const grant = await grantViaAdmin(cookie, csrf, 't12-gate-key', 't12-gate-share-2');
    assert.equal(grant.status, 503);
    assert.equal(grant.json.code, 'maintenance');

    const read = await jsonRequest('/api/v1/shares/t12-gate-share/content', { headers: key.headers });
    assert.equal(read.status, 200);
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }
});
