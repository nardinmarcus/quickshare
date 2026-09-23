// #39 managed-Key publication state: separate publish scope/grant, minimal
// publish-only state reads, conditional/idempotent transitions and revocation.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'owner39-front';
process.env.ADMIN_DASHBOARD_PASSWORD = 'owner39-dashboard';
process.env.SHARE_API_KEY = 'issue39-legacy-key';
process.env.SESSION_SECRET = 'issue39-publish-state-session-secret';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';

const app = require('../app');
let server;
let origin;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise(resolve => server.close(resolve)));

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  let requestBody;
  if (body !== undefined) {
    requestHeaders['Content-Type'] ||= 'application/json';
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(origin + path, { method, headers: requestHeaders, body: requestBody, redirect: 'manual' });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function loginDashboard() {
  const login = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=owner39-dashboard'
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await request('/admin/apis', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  assert.ok(csrf);
  return { Cookie: cookie, 'X-CSRF-Token': csrf };
}

async function createKey(name) {
  const created = await request('/admin/apis/keys', { method: 'POST', headers: await loginDashboard(), body: { name } });
  assert.equal(created.status, 201);
  return created.body.apiKey;
}

async function createShare(title, extra = {}) {
  const created = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent: `<h1>${title}</h1><p>PRIVATE_BODY_39</p>`, codeType: 'html', title, ...extra }
  });
  assert.equal(created.status, 200);
  return created.body;
}

async function grant(key, shareId, permissions, headers) {
  return request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: headers || await loginDashboard(), body: { shareId, ...permissions }
  });
}

async function transition(key, shareId, action, etag, requestId, body = {}) {
  return request(`/api/v1/shares/${shareId}/${action}`, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      ...(etag === undefined ? {} : { 'If-Match': etag }),
      ...(requestId === undefined ? {} : { 'Idempotency-Key': requestId })
    },
    ...(body === undefined ? {} : { body })
  });
}

test('legacy canUpdate:false grant payload still means a read-only grant', async () => {
  const key = await createKey('legacy explicit false remains read');
  const share = await createShare('Legacy false grant compatibility');
  const result = await grant(key, share.urlId, { canUpdate: false });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.grant, {
    apiKeyId: key.id, shareId: share.urlId, canRead: true, canUpdate: false
  });
  assert.deepEqual([...result.body.scopes].sort(), ['share:create', 'share:read']);
});

test('editor scope is not publish permission; a separate owner grant enables the exact state operation', async () => {
  const key = await createKey('editor needs publish separately');
  const share = await createShare('Separate publish authorization', { isProtected: true });
  const ownerHeaders = await loginDashboard();
  const editGrant = await grant(key, share.urlId, { canUpdate: true }, ownerHeaders);
  assert.equal(editGrant.status, 201);
  assert.deepEqual([...editGrant.body.scopes].sort(), ['share:create', 'share:read', 'share:update']);

  const stateBefore = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(stateBefore.status, 200, 'editor can read authorized minimal state');
  const denied = await transition(key.secret, share.urlId, 'unpublish', stateBefore.headers.get('etag'), 'issue39-editor-denied-0001');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'SCOPE_REQUIRED');
  assert.equal((await app.locals.pageRepository.getById(share.urlId)).published, true);

  const publishGrant = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: ownerHeaders, body: { canPublish: true }
  });
  assert.equal(publishGrant.status, 200);
  assert.equal(publishGrant.body.changed, true);
  assert.deepEqual({ read: publishGrant.body.grant.canRead, update: publishGrant.body.grant.canUpdate, publish: publishGrant.body.grant.canPublish },
    { read: true, update: true, publish: true }, 'publishing toggle preserves read/edit');
  assert.ok(publishGrant.body.scopes.includes('share:publish'));

  const before = await app.locals.pageRepository.getById(share.urlId);
  const unlocked = await request(`/view/${share.urlId}/password`, { method: 'POST', body: { password: share.password } });
  assert.equal(unlocked.status, 200);
  const oldAccessCookie = unlocked.headers.get('set-cookie').split(';')[0];
  const result = await transition(key.secret, share.urlId, 'unpublish', stateBefore.headers.get('etag'), 'issue39-editor-now-publisher-0001');
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.changed, true);
  assert.equal(result.body.published, false);
  assert.equal(result.body.accessRevision, '2');
  assert.match(result.headers.get('etag'), new RegExp(`^"access:${share.urlId}:2"$`));

  const after = await app.locals.pageRepository.getById(share.urlId);
  assert.equal(String(after.current_revision), String(before.current_revision), 'publication does not change content revision');
  assert.equal(after.password_hash, before.password_hash, 'password hash remains unchanged');
  assert.equal(after.expires_at, before.expires_at, 'expiry remains unchanged');
  assert.equal(after.published, false);
  assert.equal((await request(`/api/pages/${share.urlId}`)).status, 404, 'public metadata follows #35 neutral unpublished behavior');
  assert.equal((await request(`/view/${share.urlId}`, { headers: { Cookie: oldAccessCookie } })).status, 404, 'real transition invalidates an old password-access cookie');
});

test('publish-only sees minimal state but never enters readable list/content/history/metadata', async () => {
  const key = await createKey('publish-only key');
  const publishOnly = await createShare('PUBLISH_ONLY_PRIVATE_TITLE', { isProtected: true });
  const readable = await createShare('Readable for separate grant');
  const ownerHeaders = await loginDashboard();
  const publishGrant = await grant(key, publishOnly.urlId, { canPublish: true }, ownerHeaders);
  assert.equal(publishGrant.status, 201);
  assert.deepEqual([...publishGrant.body.scopes].sort(), ['share:create', 'share:publish']);
  assert.deepEqual(publishGrant.body.grant, {
    apiKeyId: key.id, shareId: publishOnly.urlId, canRead: false, canUpdate: false, canPublish: true
  });

  const state = await request(`/api/v1/shares/${publishOnly.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(state.status, 200);
  assert.match(state.headers.get('cache-control'), /no-store/);
  assert.match(state.headers.get('etag'), new RegExp(`^"access:${publishOnly.urlId}:1"$`));
  assert.deepEqual(Object.keys(state.body).sort(), ['accessRevision', 'expiresAt', 'id', 'isProtected', 'published', 'success'].sort());
  assert.deepEqual(state.body, {
    success: true, id: publishOnly.urlId, published: true, isProtected: true, expiresAt: null, accessRevision: '1'
  });
  assert.equal(state.text.includes('PUBLISH_ONLY_PRIVATE_TITLE'), false);
  assert.equal(state.text.includes('PRIVATE_BODY_39'), false);

  for (const path of [
    '/api/v1/shares',
    `/api/v1/shares/${publishOnly.urlId}/content`,
    `/api/v1/shares/${publishOnly.urlId}/revisions`,
    `/api/v1/shares/${publishOnly.urlId}/revisions/1`
  ]) assert.equal((await request(path, { headers: { 'X-API-Key': key.secret } })).status, 403, `${path}: no read scope`);

  const readGrant = await grant(key, readable.urlId, {}, ownerHeaders);
  assert.equal(readGrant.status, 201);
  const list = await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.shares.map(row => row.id), [readable.urlId], 'list selects can_read grants only');
  for (const path of [
    `/api/v1/shares/${publishOnly.urlId}/content`,
    `/api/v1/shares/${publishOnly.urlId}/revisions`,
    `/api/v1/shares/${publishOnly.urlId}/revisions/1`
  ]) assert.equal((await request(path, { headers: { 'X-API-Key': key.secret } })).status, 404, `${path}: scope exists, but target has no read grant`);
  const publicMetadata = await request(`/api/pages/${publishOnly.urlId}`);
  assert.equal(publicMetadata.status, 403, 'unlocked public metadata is not projected for this protected Share');
  assert.equal(publicMetadata.text.includes('PUBLISH_ONLY_PRIVATE_TITLE'), false);
});

test('state preconditions are access-family strong tags; replay is idempotent and never leaks stale state', async () => {
  const key = await createKey('publish replay key');
  const share = await createShare('Replay protected Share', { isProtected: true });
  await grant(key, share.urlId, { canPublish: true });
  const state1 = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  const etag1 = state1.headers.get('etag');
  const headers = { 'X-API-Key': key.secret, 'If-Match': etag1 };

  assert.equal((await request(`/api/v1/shares/${share.urlId}/unpublish`, { method: 'POST', headers, body: {} })).status, 428, 'missing idempotency key');
  assert.equal((await transition(key.secret, share.urlId, 'unpublish', undefined, 'issue39-missing-access-0001')).status, 428);
  for (const malformed of ['*', `W/${etag1}`, `${etag1}, ${etag1}`, `"content:${share.urlId}:1"`, 'access:bare']) {
    const bad = await transition(key.secret, share.urlId, 'unpublish', malformed, `issue39-bad-etag-${String(malformed).length}-0001`);
    assert.equal(bad.status, 400, `reject ${malformed}`);
  }
  const badBody = await transition(key.secret, share.urlId, 'unpublish', etag1, 'issue39-body-labels-0001', { htmlContent: '<p>no</p>' });
  assert.equal(badBody.status, 400);
  const wrongType = await request(`/api/v1/shares/${share.urlId}/unpublish`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'issue39-text-body-0001', 'Content-Type': 'text/plain' }, body: 'unexpected'
  });
  assert.equal(wrongType.status, 400, 'non-JSON body cannot bypass the empty-body contract');
  const tooLarge = await transition(key.secret, share.urlId, 'unpublish', etag1, 'issue39-body-too-large-0001', { ignored: 'x'.repeat(17 * 1024) });
  assert.equal(tooLarge.status, 413);

  const first = await transition(key.secret, share.urlId, 'unpublish', etag1, 'issue39-publish-replay-000001');
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.accessRevision, '2');
  const replay = await transition(key.secret, share.urlId, 'unpublish', etag1, 'issue39-publish-replay-000001');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.published, false);
  assert.equal(replay.body.accessRevision, '2');

  const status = await request('/api/v1/operations/issue39-publish-replay-000001', { headers: { 'X-API-Key': key.secret } });
  assert.equal(status.status, 200);
  assert.equal(status.body.operations[0].action, 'unpublish');
  assert.equal(status.body.operations[0].accessRevision, '2');

  const stale = await transition(key.secret, share.urlId, 'republish', etag1, 'issue39-publish-stale-000001');
  assert.equal(stale.status, 412, 'different intent with stale access ETag is rejected');
  const differentActionSameRequest = await transition(key.secret, share.urlId, 'republish', etag1, 'issue39-publish-replay-000001');
  assert.equal(differentActionSameRequest.status, 409, 'same id cannot cross transition actions');

  const republished = await transition(key.secret, share.urlId, 'republish', replay.headers.get('etag'), 'issue39-publish-republish-0001');
  assert.equal(republished.status, 200);
  assert.equal(republished.body.published, true);
  assert.equal(republished.body.accessRevision, '3');
  const staleReplay = await transition(key.secret, share.urlId, 'unpublish', etag1, 'issue39-publish-replay-000001');
  assert.equal(staleReplay.status, 200);
  assert.equal(staleReplay.body.replayed, true);
  assert.equal(staleReplay.body.stateChangedSinceCommit, true);
  assert.equal('published' in staleReplay.body, false);
  assert.equal('accessRevision' in staleReplay.body, false);
  const staleStatus = await request('/api/v1/operations/issue39-publish-replay-000001', { headers: { 'X-API-Key': key.secret } });
  assert.equal(staleStatus.status, 200);
  assert.equal(staleStatus.body.operations[0].stateChangedSinceCommit, true);
  assert.equal('accessRevision' in staleStatus.body.operations[0], false);

  const apiKey = await app.locals.pageRepository.getApiKeyById(key.id);
  const audits = await app.locals.pageRepository.listAuditLogs({ limit: 1000 });
  assert.equal(audits.filter(row => row.action === 'page.unpublish' && row.pageId === share.urlId).length, 1, 'replay does not repeat audit effects');
  assert.equal(audits.filter(row => row.action === 'page.republish' && row.pageId === share.urlId).length, 1);
  assert.ok(apiKey.scopes.includes('share:publish'));
});

test('content purge preserves publish-state receipts and replay hides stale state after policy changes', async () => {
  const repository = app.locals.pageRepository;
  const ownerHeaders = await loginDashboard();

  for (const action of ['unpublish', 'republish']) {
    const key = await createKey(`purge-independent-${action}`);
    const share = await createShare(`purge ${action}`);
    assert.equal((await grant(key, share.urlId, { canPublish: true }, ownerHeaders)).status, 201);

    const initialState = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
    const requestId = `issue39-purge-${action}-000001`;
    const committed = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(committed.status, 200, committed.text);
    const committedAccessRevision = committed.body.accessRevision;
    const committedPublished = action === 'republish';
    assert.equal(committed.body.published, committedPublished);

    assert.equal(await repository.updatePage(share.urlId, {
      htmlContent: `<h1>${action} revision two</h1>`,
      title: `${action} revision two`,
      expectedContentRevision: '1'
    }), true);
    assert.equal(String((await repository.getById(share.urlId)).current_revision), '2');

    const purged = await request(`/admin/pages/${share.urlId}/revisions/1/purge`, {
      method: 'POST', headers: ownerHeaders, body: { confirm: `${share.urlId}:1` }
    });
    assert.equal(purged.status, 200, purged.text);
    const record = await repository.findPublishingOperation(`managed-key:${key.id}`, requestId);
    assert.ok(record.receipt_encrypted, 'publish-state receipt remains available after purging its then-current content revision');
    assert.equal(record.purged_at ?? null, null, 'content purge does not mark a state transition as a purged content result');

    const beforeReplay = await repository.getById(share.urlId);
    const replay = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.changed, committed.body.changed);
    assert.equal(replay.body.published, committedPublished);
    assert.equal(replay.body.accessRevision, committedAccessRevision);
    const afterReplay = await repository.getById(share.urlId);
    assert.equal(String(afterReplay.access_revision), String(beforeReplay.access_revision), 'replay does not bump access revision');
    assert.equal(afterReplay.published, beforeReplay.published, 'replay does not change publication state');

    const auditCount = action => repository.listAuditLogs({ limit: 1000 }).then(rows =>
      rows.filter(row => row.pageId === share.urlId && row.action === action).length);
    const committedAuditCount = await auditCount(`page.${action}`);
    const status = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.operations[0].action, action);
    assert.equal(status.body.operations[0].status, 'succeeded');
    assert.equal(status.body.operations[0].revision, '1');
    assert.equal(status.body.operations[0].accessRevision, committedAccessRevision);
    assert.equal(await auditCount(`page.${action}`), committedAuditCount, 'replay and status add no audit effects');

    const changedState = await request(`/api/v1/shares/${share.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
    const laterAction = action === 'unpublish' ? 'republish' : 'unpublish';
    const later = await transition(key.secret, share.urlId, laterAction, changedState.headers.get('etag'), `issue39-purge-later-${action}-0001`);
    assert.equal(later.status, 200, later.text);
    assert.equal(later.body.changed, true, 'later state policy change advances the access revision');
    const laterAccessRevision = String(BigInt(committedAccessRevision) + 1n);
    assert.equal(later.body.accessRevision, laterAccessRevision);
    const afterLaterAuditCount = await auditCount(`page.${laterAction}`);

    const staleReplay = await transition(key.secret, share.urlId, action, initialState.headers.get('etag'), requestId);
    assert.equal(staleReplay.status, 200, staleReplay.text);
    assert.equal(staleReplay.body.stateChangedSinceCommit, true);
    for (const staleValue of ['published', 'accessRevision']) assert.equal(staleValue in staleReplay.body, false);
    assert.notEqual(staleReplay.headers.get('etag'), initialState.headers.get('etag'), 'old strong state ETag is never returned after access policy changes');
    const staleStatus = await request(`/api/v1/operations/${requestId}`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(staleStatus.status, 200, staleStatus.text);
    assert.equal(staleStatus.body.operations[0].stateChangedSinceCommit, true);
    assert.equal('accessRevision' in staleStatus.body.operations[0], false);
    assert.equal(await auditCount(`page.${laterAction}`), afterLaterAuditCount, 'stale replay and status do not repeat the later transition');
    assert.equal(String((await repository.getById(share.urlId)).access_revision), laterAccessRevision);
  }
});

test('read API storage failures have a stable retryable private/no-store contract', async () => {
  const repository = app.locals.pageRepository;
  const key = await createKey('read failures');
  const share = await createShare('Read failure target');
  assert.equal((await grant(key, share.urlId, { canRead: true, canPublish: true })).status, 201);

  const scenarios = [
    { method: 'listGrantedSharePage', path: '/api/v1/shares' },
    { method: 'getById', path: `/api/v1/shares/${share.urlId}/content` },
    { method: 'getById', path: `/api/v1/shares/${share.urlId}/state` }
  ];
  for (const scenario of scenarios) {
    const original = repository[scenario.method];
    repository[scenario.method] = async () => { throw Object.assign(new Error('database diagnostic sentinel'), { code: 'XX001' }); };
    let response;
    try {
      response = await request(scenario.path, { headers: { 'X-API-Key': key.secret } });
    } finally {
      repository[scenario.method] = original;
    }
    assert.equal(response.status, 503, `${scenario.path}: ${response.text}`);
    assert.deepEqual(response.body, {
      success: false,
      code: 'API_READ_UNAVAILABLE',
      requestId: null,
      retryable: true,
      error: 'Share data is temporarily unavailable'
    });
    assert.match(response.headers.get('cache-control'), /private/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.text.includes('database diagnostic sentinel'), false);
  }

  const originalLookup = repository.getApiKeyById;
  repository.getApiKeyById = async () => { throw Object.assign(new Error('authentication diagnostic sentinel'), { code: 'XX002' }); };
  let authenticationFailure;
  try {
    authenticationFailure = await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } });
  } finally {
    repository.getApiKeyById = originalLookup;
  }
  assert.equal(authenticationFailure.status, 503);
  assert.equal(authenticationFailure.body.code, 'API_READ_UNAVAILABLE');
  assert.equal(authenticationFailure.body.requestId, null);
  assert.equal(authenticationFailure.body.retryable, true);
  assert.equal(authenticationFailure.text.includes('authentication diagnostic sentinel'), false);
  assert.match(authenticationFailure.headers.get('cache-control'), /no-store/);

  assert.equal((await request('/api/v1/shares?limit=0', { headers: { 'X-API-Key': key.secret } })).status, 400,
    'malformed input remains a client error');
  assert.equal((await request('/api/v1/shares')).status, 401, 'authorization failures retain their status');
});

test('first/last publish grants control scope; revocation blocks replay/status and rotation kills old credential', async () => {
  const key = await createKey('publish scope lifecycle');
  const one = await createShare('Publish grant one');
  const two = await createShare('Publish grant two');
  const ownerHeaders = await loginDashboard();
  await grant(key, one.urlId, { canPublish: true }, ownerHeaders);
  await grant(key, two.urlId, { canPublish: true }, ownerHeaders);
  const state = await request(`/api/v1/shares/${one.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  const op = await transition(key.secret, one.urlId, 'unpublish', state.headers.get('etag'), 'issue39-revoke-status-00001');
  assert.equal(op.status, 200);

  const revokeOne = await request(`/admin/apis/keys/${key.id}/grants/${one.urlId}`, {
    method: 'PUT', headers: ownerHeaders, body: { canPublish: false }
  });
  assert.equal(revokeOne.status, 200);
  assert.equal(revokeOne.body.changed, true);
  assert.equal(revokeOne.body.grant, null, 'publish-only grant row is deleted when its final permission is removed');
  assert.ok(revokeOne.body.scopes.includes('share:publish'), 'another publish grant retains the scope');
  assert.equal((await transition(key.secret, one.urlId, 'unpublish', state.headers.get('etag'), 'issue39-revoke-status-00001')).status, 404);
  assert.equal((await request('/api/v1/operations/issue39-revoke-status-00001', { headers: { 'X-API-Key': key.secret } })).status, 404);

  const revokeTwo = await request(`/admin/apis/keys/${key.id}/grants/${two.urlId}`, {
    method: 'PUT', headers: ownerHeaders, body: { canPublish: false }
  });
  assert.deepEqual(revokeTwo.body.scopes, ['share:create'], 'last publish grant removes the scope');
  const missingScope = await request(`/api/v1/shares/${two.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(missingScope.status, 403);

  const rotated = await request(`/admin/apis/keys/${key.id}/rotate`, { method: 'POST', headers: ownerHeaders, body: {} });
  assert.equal(rotated.status, 200);
  assert.equal((await transition(key.secret, one.urlId, 'unpublish', state.headers.get('etag'), 'issue39-old-key-write-0001')).status, 401);
  assert.deepEqual(rotated.body.apiKey.scopes, ['share:create']);
});

test('same-state no-op and public protected/expired projection retain #35 behavior', async () => {
  const key = await createKey('publish noop and expiry');
  const protectedShare = await createShare('Already published protected', { isProtected: true });
  const expiredId = 'issue39-expired-share';
  await app.locals.pageRepository.create({
    id: expiredId, htmlContent: '<h1>Expired</h1>', createdAt: Date.now(),
    isProtected: false, codeType: 'html', title: 'Expired Secret Title',
    expiresAt: Date.now() - 60_000, markdownTheme: null
  });
  await grant(key, protectedShare.urlId, { canPublish: true });
  await grant(key, expiredId, { canPublish: true });

  const state = await request(`/api/v1/shares/${protectedShare.urlId}/state`, { headers: { 'X-API-Key': key.secret } });
  const auditsBefore = (await app.locals.pageRepository.listAuditLogs({ limit: 1000 })).filter(row => row.action === 'page.republish').length;
  const noop = await transition(key.secret, protectedShare.urlId, 'republish', state.headers.get('etag'), 'issue39-republish-noop-0001');
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);
  assert.equal(noop.body.isProtected, true);
  assert.equal(noop.body.accessRevision, '1');
  assert.equal((await transition(key.secret, protectedShare.urlId, 'republish', state.headers.get('etag'), 'issue39-republish-noop-0001')).body.replayed, true);
  const auditsAfter = (await app.locals.pageRepository.listAuditLogs({ limit: 1000 })).filter(row => row.action === 'page.republish').length;
  assert.equal(auditsAfter, auditsBefore, 'same-state no-op has no audit side effect');

  const expiredState = await request(`/api/v1/shares/${expiredId}/state`, { headers: { 'X-API-Key': key.secret } });
  const expiredTransition = await transition(key.secret, expiredId, 'unpublish', expiredState.headers.get('etag'), 'issue39-expired-unpublish-0001');
  assert.equal(expiredTransition.status, 200, 'expired Share remains manageable by an explicit grant');
  assert.equal((await request(`/view/${expiredId}`)).status, 404, 'unpublished precedes expired public classification');
  const protectedTransition = await transition(key.secret, protectedShare.urlId, 'unpublish', state.headers.get('etag'), 'issue39-protected-unpublish-0001');
  assert.equal(protectedTransition.status, 200);
  assert.equal((await request(`/view/${protectedShare.urlId}`)).status, 404);
});
