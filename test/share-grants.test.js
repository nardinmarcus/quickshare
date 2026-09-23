// #36 — Per-Share read grants: dashboard grant/revoke, the 401/403/404
// permission matrix, rotation survival, list non-leakage, management reads
// of unpublished/protected Shares, and response hygiene (no password,
// encrypted password, grant tables or Favorite state; private caching).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'owner36';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard36';
process.env.SHARE_API_KEY = 'issue36-legacy-key';
process.env.SESSION_SECRET = 'issue36-grants-session-secret';

const app = require('../app');

let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function loginDashboard() {
  const response = await fetch(base + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard36',
    redirect: 'manual'
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^dashboard_admin_session=/);
  return cookie;
}

async function dashboardHeaders(cookie) {
  const page = await request('/admin/apis', { headers: { Cookie: cookie } });
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  return { Cookie: cookie, 'X-CSRF-Token': csrf };
}

async function createKey(name) {
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);
  const created = await request('/admin/apis/keys', { method: 'POST', headers, body: { name } });
  assert.equal(created.status, 201);
  return created.body.apiKey;
}

async function createShare(title, extra = {}) {
  const created = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': 'issue36-legacy-key' },
    body: { htmlContent: `<h1>${title}</h1><p>SECRET_BODY_36</p>`, title, ...extra }
  });
  assert.equal(created.status, 200);
  return created.body;
}

test('grant then read: scope, grant, content, state and list all agree', async () => {
  const key = await createKey('read-grant happy path');
  const share = await createShare('Grant Happy Path');
  const dashboard = await dashboardHeaders(await loginDashboard());

  // Create-only key: the whole read family is 403 before any grant.
  for (const path of ['/api/v1/shares', `/api/v1/shares/${share.urlId}/content`, `/api/v1/shares/${share.urlId}/state`]) {
    assert.equal((await request(path, { headers: { 'X-API-Key': key.secret } })).status, 403);
  }

  const granted = await request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: dashboard, body: { shareId: share.urlId }
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.changed, true);

  // /me now advertises the read scope the grant unlocked.
  const me = await request('/api/v1/me', { headers: { 'X-API-Key': key.secret } });
  assert.deepEqual(me.body.scopes.sort(), ['share:create', 'share:read']);

  const list = await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } });
  assert.equal(list.status, 200);
  assert.equal(list.body.shares.length, 1);
  assert.equal(list.body.shares[0].id, share.urlId);
  assert.equal(list.body.shares[0].title, 'Grant Happy Path');

  const content = await request(`/api/v1/shares/${share.urlId}/content`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(content.status, 200);
  assert.equal(content.body.revision, '1');
  assert.equal(content.body.title, 'Grant Happy Path');
  assert.ok(content.body.htmlContent.includes('SECRET_BODY_36'));
  assert.match(content.headers.get('etag'), /^"content:.+:1"$/);

  const state = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, {
    success: true, id: share.urlId, published: true, isProtected: false, expiresAt: null, accessRevision: '1'
  });
  assert.match(state.headers.get('etag'), /^"access:.+:1"$/);

  // Duplicate grant is a no-op, not a second audit row.
  const duplicate = await request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: dashboard, body: { shareId: share.urlId }
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.changed, false);
});

test('permission matrix: 401 invalid credential, 403 missing scope, 404 ungranted target is indistinguishable', async () => {
  const key = await createKey('matrix key');
  const grantedShare = await createShare('Matrix Granted');
  const otherShare = await createShare('Matrix Other');
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: grantedShare.urlId } });

  for (const path of ['/api/v1/shares', `/api/v1/shares/${otherShare.urlId}/content`, `/api/v1/shares/${otherShare.urlId}/state`]) {
    assert.equal((await request(path, {})).status, 401, `${path}: no credential`);
    assert.equal((await request(path, { headers: { 'X-API-Key': 'not-a-real-key' } })).status, 401, `${path}: invalid credential`);
    // Cookies never authorize management APIs.
    assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 401, `${path}: dashboard cookie`);
  }

  // Legacy key: authenticated but create-only → 403 on the read family.
  for (const path of ['/api/v1/shares', `/api/v1/shares/${grantedShare.urlId}/content`]) {
    const legacy = await request(path, { headers: { 'X-API-Key': 'issue36-legacy-key' } });
    assert.equal(legacy.status, 403);
    assert.equal(legacy.body.code, 'SCOPE_REQUIRED');
  }

  // Scope present, target ungranted: same 404 body as a missing Share.
  const ungranted = await request(`/api/v1/shares/${otherShare.urlId}/content`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(ungranted.status, 404);
  const missing = await request('/api/v1/shares/does-not-exist-00/content', { headers: { 'X-API-Key': key.secret } });
  assert.equal(missing.status, 404);
  assert.deepEqual(ungranted.body, missing.body);

  const stateUngranted = await request(`/api/v1/shares/${otherShare.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(stateUngranted.status, 404);
  // And the granted Share still answers with its state.
  assert.equal((await request(`/api/v1/shares/${grantedShare.urlId}/state`, { headers: { 'X-API-Key': key.secret } })).status, 200);
});

test('grant writes require dashboard identity, CSRF and honest 404s; audit rows are written', async () => {
  const key = await createKey('csrf grant key');
  const share = await createShare('CSRF Grant');
  const ownerCookie = await loginDashboard();
  const frontLogin = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=owner36',
    redirect: 'manual'
  });
  const frontCookie = frontLogin.headers.get('set-cookie').split(';')[0];

  assert.equal((await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId: share.urlId } })).status, 302, 'no session redirects');
  assert.equal((await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers: { Cookie: frontCookie }, body: { shareId: share.urlId } })).status, 302, 'front-end login is not a dashboard session');
  assert.equal((await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers: { Cookie: ownerCookie }, body: { shareId: share.urlId } })).status, 403, 'missing CSRF');
  assert.equal((await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers: { Cookie: ownerCookie, 'X-CSRF-Token': 'nope' }, body: { shareId: share.urlId } })).status, 403, 'wrong CSRF');
  assert.equal((await request(`/admin/apis/keys/missing-key000/grants`, { method: 'POST', headers: await dashboardHeaders(ownerCookie), body: { shareId: share.urlId } })).status, 404, 'unknown key');
  const badShare = await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers: await dashboardHeaders(ownerCookie), body: { shareId: 'no-such-share0' } });
  assert.equal(badShare.status, 404, 'unknown share');
  assert.equal(badShare.body.code, 'SHARE_NOT_FOUND');
  assert.equal((await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers: await dashboardHeaders(ownerCookie), body: { shareId: 'bad id with spaces!' } })).status, 400, 'malformed shareId');
  assert.equal((await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'DELETE', headers: { Cookie: ownerCookie } })).status, 403, 'revoke needs CSRF');

  const headers = await dashboardHeaders(ownerCookie);
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
  const revoked = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'DELETE', headers });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.changed, true);
  const revokedAgain = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'DELETE', headers });
  assert.equal(revokedAgain.status, 200, 'revoke is idempotent');
  assert.equal(revokedAgain.body.changed, false);

  const audit = await request('/admin/audit?limit=50', { headers: { Cookie: ownerCookie } });
  assert.ok(audit.text.includes('api_key.grant'), 'grant audited');
  assert.ok(audit.text.includes('api_key.revoke'), 'revoke audited');
  assert.ok(!audit.text.includes(key.secret), 'audit never carries the secret');
});

test('rotation preserves grants and scope; old secret dies; deletion makes grants inert', async () => {
  const key = await createKey('rotation grant key');
  const share = await createShare('Rotation Grant');
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });

  const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, { method: 'POST', headers });
  assert.equal(rotated.status, 200);
  const newSecret = rotated.body.apiKey.secret;
  assert.deepEqual([...rotated.body.apiKey.scopes].sort(), ['share:create', 'share:read'], 'scope travels with rotation');

  assert.equal((await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } })).status, 401, 'old secret dead');
  const after = await request('/api/v1/shares', { headers: { 'X-API-Key': newSecret } });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.shares.map(row => row.id), [share.urlId], 'grants survive rotation');

  await request(`/admin/apis/keys/${key.id}`, { method: 'DELETE', headers });
  assert.equal((await request('/api/v1/shares', { headers: { 'X-API-Key': newSecret } })).status, 401, 'deleted key is 401, grants inert');
  const leftover = app.locals.pageRepository.listShareGrantsForKey
    ? await app.locals.pageRepository.listShareGrantsForKey(key.id)
    : [];
  assert.equal(leftover.length, 0, 'memory adapter cascades grants when the key row goes (PG does it via FK)');
});

test('share deletion removes its grants and revoke refuses to strand an edit grant (#36/#37 boundary)', async () => {
  const key = await createKey('cascade boundary key');
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);

  const share = await createShare('Cascade Source Share');
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
  let scopes = (await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'DELETE', headers })).body.scopes;
  assert.deepEqual(scopes, ['share:create'], 'last revoke drops the read scope in the response');

  // Re-grant, then delete the Share: the grant disappears with it (memory
  // mirrors the PG FK cascade) and the API key loses read again.
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
  assert.deepEqual((await app.locals.pageRepository.getApiKeyById(key.id)).scopes, ['share:create', 'share:read']);
  await app.locals.pageRepository.deletePage(share.urlId);
  assert.equal((await app.locals.pageRepository.listShareGrantsForKey(key.id)).length, 0, 'share deletion cascades its grant');
  assert.deepEqual((await app.locals.pageRepository.getApiKeyById(key.id)).scopes, ['share:create', 'share:read'], 'explicit grant history keeps the scope (owner decides)');

  // can_update=true future grant must not be silently downgraded (#37 prep).
  // #36 has no API surface to write can_update, so set the bit the way #37
  // will, then assert revoke refuses instead of violating update ⇒ read.
  await app.locals.pageRepository.create({
    id: 'issue36-dependent-grant',
    htmlContent: '<h1>Dependent</h1>',
    createdAt: Date.now(),
    isProtected: false,
    codeType: 'html',
    title: 'Dependent',
    markdownTheme: null
  });
  await app.locals.pageRepository.grantShareRead({ apiKeyId: key.id, shareId: 'issue36-dependent-grant' });
  app.locals.pageRepository.shareGrants.get(`${key.id}\u0000issue36-dependent-grant`).can_update = true;
  const dependent = await request(`/admin/apis/keys/${key.id}/grants/issue36-dependent-grant`, { method: 'DELETE', headers });
  assert.equal(dependent.status, 409, 'an edit-dependent read grant cannot be singly revoked');
  assert.equal(dependent.body.error, '编辑授权依赖读取授权，不能单独撤回');
  const intact = await app.locals.pageRepository.getShareGrant(key.id, 'issue36-dependent-grant');
  assert.equal(intact.can_read, true, 'dependent grant left intact, not downgraded');
  await app.locals.pageRepository.deletePage('issue36-dependent-grant');
});

test('management reads work on unpublished, protected and expired Shares; public visibility is not reused', async () => {
  const key = await createKey('management visibility key');
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);

  const unpublished = await createShare('Unpublished But Granted');
  await request(`/admin/pages/${unpublished.urlId}/unpublish`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'issue36-unpublish-00000001' },
    body: { expectedAccessRevision: '1' }
  });

  const protectedShare = await createShare('Protected But Granted', { isProtected: true });

  // A Share expiring in the past can't be born through the create API (400
  // by design); seed it through the repository like publication-state does.
  const expiredId = 'issue36-expired-grant';
  await app.locals.pageRepository.create({
    id: expiredId,
    htmlContent: '<h1>Expired But Granted</h1><p>SECRET_BODY_36</p>',
    createdAt: Date.now(),
    isProtected: false,
    codeType: 'html',
    title: 'Expired But Granted',
    expiresAt: Date.now() - 60_000,
    markdownTheme: null
  });
  const expired = { urlId: expiredId };

  for (const share of [unpublished, protectedShare, expired]) {
    await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
    const content = await request(`/api/v1/shares/${share.urlId}/content`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(content.status, 200, `${share.urlId}: granted management read`);
    assert.ok(content.body.htmlContent.includes('SECRET_BODY_36'));
    const state = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(state.status, 200);
  }

  // The public surface still refuses the unpublished Share.
  assert.equal((await request(`/api/pages/${unpublished.urlId}`)).status, 404);
});

test('read responses never leak password material, grant tables or Favorite state; caches are private', async () => {
  const key = await createKey('leak check key');
  const share = await createShare('Leak Check', { isProtected: true });
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });

  const repository = app.locals.pageRepository;
  const stored = await repository.getById(share.urlId);
  assert.ok(stored.password_hash || stored.passwordHash, 'fixture actually carries a password hash');

  for (const path of ['/api/v1/shares', `/api/v1/shares/${share.urlId}/content`, `/api/v1/shares/${share.urlId}/state`]) {
    const response = await request(path, { headers: { 'X-API-Key': key.secret } });
    assert.match(response.headers.get('cache-control'), /no-store/);
    const payload = response.text;
    for (const forbidden of ['password_hash', 'passwordHash', 'encrypted_password', 'encryptedPassword', 'is_favorite', 'isFavorite', 'share_grants', 'can_read', key.secret]) {
      assert.equal(payload.includes(forbidden), false, `${path} must not contain ${forbidden}`);
    }
  }

  const state = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(state.body.isProtected, true, 'boolean protection flag is fine');
  assert.equal('title' in state.body, false, 'state model never carries the title');
  assert.equal('description' in state.body, false);
  assert.equal('htmlContent' in state.body, false);
});

test('grant writes respect the publishing maintenance gate like every other write', async () => {
  const key = await createKey('maintenance grant key');
  const share = await createShare('Maintenance Grant');
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);

  await app.locals.pageRepository.setPublishingWritesPaused(true);
  try {
    const paused = await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
    assert.equal(paused.status, 503);
    assert.equal(paused.body.code, 'PUBLISHING_MAINTENANCE');
  } finally {
    await app.locals.pageRepository.setPublishingWritesPaused(false);
  }

  const granted = await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: share.urlId } });
  assert.equal(granted.status, 201, 'gate releases after maintenance');
});

test('memory cursor traversal is deterministic for same-timestamp mixed-case IDs (S1)', async () => {
  const key = await createKey('case cursor key');
  const repository = app.locals.pageRepository;

  // Same created_at, IDs that JS `>` and localeCompare order differently:
  // the cursor filter and the ORDER BY must use one byte-wise order or a
  // page walk silently drops a granted Share.
  const seeded = [];
  for (const id of ['ACaseCursor', 'aCaseCursor']) {
    await repository.create({
      id,
      htmlContent: `<h1>${id}</h1>`,
      createdAt: 1700000000000,
      isProtected: false,
      codeType: 'html',
      title: id,
      markdownTheme: null
    });
    seeded.push(id);
  }
  const cookie = await loginDashboard();
  const headers = await dashboardHeaders(cookie);
  for (const id of seeded) {
    const granted = await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', headers, body: { shareId: id } });
    assert.ok(granted.status === 201 || granted.status === 200);
  }

  // Walk with limit=1 until exhaustion; every seeded ID must appear exactly
  // once and the walk must terminate.
  const visited = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const url = `/api/v1/shares?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await request(url, { headers: { 'X-API-Key': key.secret } });
    assert.equal(response.status, 200);
    for (const row of response.body.shares) {
      if (seeded.includes(row.id)) visited.push(row.id);
    }
    if (!response.body.nextCursor) break;
    cursor = response.body.nextCursor;
  }
  assert.deepEqual([...visited].sort(), [...seeded].sort(), 'every granted Share is visited exactly once');
  for (const id of seeded) await repository.deletePage(id);
});
