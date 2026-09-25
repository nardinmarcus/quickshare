// #37/T13 — managed Key edit grants, conditional content updates and bounded operation receipts.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'owner37-test';
process.env.ADMIN_DASHBOARD_PASSWORD = 'dashboard37-test';
process.env.SHARE_API_KEY = 'issue37-legacy-test-key';
process.env.SESSION_SECRET = 'issue37-api-update-test-session-secret';
process.env.SHARE_BODY_LIMIT = '64kb';

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
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML response */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function dashboard() {
  const login = await fetch(base + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard37-test', redirect: 'manual'
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await request('/admin/apis', { headers: { Cookie: cookie } });
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  assert.ok(csrf);
  return { Cookie: cookie, 'X-CSRF-Token': csrf };
}

async function createKey(name = 'issue37 test key') {
  const headers = await dashboard();
  const response = await request('/admin/apis/keys', { method: 'POST', headers, body: { name } });
  assert.equal(response.status, 201);
  return { ...response.body.apiKey, headers };
}

async function createShare(title = 'T13 share', options = {}) {
  const response = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent: `<h1>${title}</h1>\r\n<p>original</p>`, codeType: 'html', title, ...options }
  });
  assert.equal(response.status, 200);
  return response.body;
}

async function grantEdit(key, shareId) {
  return request(`/admin/apis/keys/${encodeURIComponent(key.id)}/grants`, {
    method: 'POST', headers: key.headers, body: { shareId, canUpdate: true }
  });
}

function updateHeaders(key, etag, id = 'issue37-content-update-0001') {
  return { 'X-API-Key': key.secret, 'If-Match': etag, 'Idempotency-Key': id };
}

const fullHtmlSnapshot = htmlContent => ({
  htmlContent,
  title: '  Agent   revised title  ',
  description: ' revised description  ',
  markdownTheme: null
});

test('owner can grant/revoke edit separately from read and toggle future auto-edit with audit', async () => {
  const key = await createKey();
  const share = await createShare('Grant controls');
  const grant = await grantEdit(key, share.urlId);
  assert.equal(grant.status, 201);
  assert.deepEqual([...grant.body.scopes].sort(), ['share:create', 'share:read', 'share:update']);
  assert.deepEqual(grant.body.grant, { apiKeyId: key.id, shareId: share.urlId, canRead: true, canUpdate: true });

  const downgrade = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: key.headers, body: { canUpdate: false }
  });
  assert.equal(downgrade.status, 200);
  assert.equal(downgrade.body.changed, true);
  assert.equal(downgrade.body.grant.canRead, true);
  assert.equal(downgrade.body.grant.canUpdate, false);
  assert.deepEqual([...downgrade.body.scopes].sort(), ['share:create', 'share:read']);

  const restoreEdit = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: key.headers, body: { canUpdate: true }
  });
  assert.equal(restoreEdit.status, 200);
  assert.equal(restoreEdit.body.grant.canRead, true, 'update always includes read');
  assert.equal(restoreEdit.body.grant.canUpdate, true);

  const auto = await request(`/admin/apis/keys/${key.id}/auto-grant-edit`, {
    method: 'PUT', headers: key.headers, body: { enabled: true }
  });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.autoGrantNewShareEdit, true);
  assert.equal(auto.body.changed, true);
  const panel = await request('/admin/apis', { headers: { Cookie: key.headers.Cookie } });
  assert.match(panel.text, /data-auto-grant-edit=/);
  assert.match(panel.text, /撤销编辑权/);

  const audit = await request('/admin/audit?limit=100', { headers: { Cookie: key.headers.Cookie } });
  assert.match(audit.text, /api_key\.grant/);
  assert.match(audit.text, /api_key\.revoke/);
  assert.match(audit.text, /api_key\.auto_grant_new_share_edit\.enable/);
  assert.doesNotMatch(audit.text, new RegExp(key.secret));
});

test('auto-edit grants only later managed-key creations and never legacy creations', async () => {
  const key = await createKey('auto grant key');
  const headers = key.headers;
  const preexistingResult = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': key.secret },
    body: { htmlContent: '<h1>preexisting before auto-edit</h1>', codeType: 'html', title: 'preexisting before auto-edit' }
  });
  assert.equal(preexistingResult.status, 200);
  const preexistingShare = preexistingResult.body;
  assert.equal(await app.locals.pageRepository.getShareGrant(key.id, preexistingShare.urlId), null);
  const enable = await request(`/admin/apis/keys/${key.id}/auto-grant-edit`, {
    method: 'PUT', headers, body: { enabled: true }
  });
  assert.equal(enable.status, 200);
  assert.equal(await app.locals.pageRepository.getShareGrant(key.id, preexistingShare.urlId), null,
    'enabling future auto-edit never retroactively grants existing Shares');

  const managedCreate = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-auto-create-0001' },
    body: { htmlContent: '<h1>managed auto edit</h1>', codeType: 'html', title: 'managed auto edit' }
  });
  assert.equal(managedCreate.status, 200);
  const grant = await app.locals.pageRepository.getShareGrant(key.id, managedCreate.body.urlId);
  assert.deepEqual({ read: grant.can_read, update: grant.can_update, publish: grant.can_publish }, { read: true, update: true, publish: false });
  assert.equal(typeof managedCreate.body.url, 'string');
  assert.equal(typeof managedCreate.body.urlId, 'string');
  const scopes = (await app.locals.pageRepository.getApiKeyById(key.id)).scopes;
  assert.deepEqual([...scopes].sort(), ['share:create', 'share:read', 'share:update']);

  const legacyCreate = await createShare('legacy stays create-only');
  assert.equal(await app.locals.pageRepository.getShareGrant(key.id, legacyCreate.urlId), null,
    'legacy API creation never inherits a managed Key auto-grant setting');
  const disable = await request(`/admin/apis/keys/${key.id}/auto-grant-edit`, {
    method: 'PUT', headers, body: { enabled: false }
  });
  assert.equal(disable.status, 200);
  assert.equal((await app.locals.pageRepository.getShareGrant(key.id, managedCreate.body.urlId)).can_update, true,
    'disabling the future option does not revoke explicit grants already committed');
});

test('auto-grant, page, baseline revision, audit and idempotency record roll back together', async () => {
  const key = await createKey('auto grant rollback key');
  const enabled = await request(`/admin/apis/keys/${key.id}/auto-grant-edit`, {
    method: 'PUT', headers: key.headers, body: { enabled: true }
  });
  assert.equal(enabled.status, 200);
  const repository = app.locals.pageRepository;
  const pagesBefore = repository.pages.size;
  const auditBefore = repository.auditLogs.length;
  const grantMethod = repository.grantShareEdit;
  repository.grantShareEdit = async () => { throw new Error('synthetic auto-grant failure'); };
  let result;
  try {
    result = await request('/api/v1/share', {
      method: 'POST', headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-auto-rollback-0001' },
      body: { htmlContent: '<h1>must roll back</h1>', codeType: 'html', title: 'must roll back' }
    });
  } finally {
    repository.grantShareEdit = grantMethod;
  }
  assert.equal(result.status, 500);
  assert.equal(repository.pages.size, pagesBefore);
  assert.equal(repository.auditLogs.length, auditBefore);
  assert.equal([...repository.publishOperations.values()].some(row => row.request_id === 'issue37-auto-rollback-0001'), false);

  const retry = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-auto-rollback-0001' },
    body: { htmlContent: '<h1>must roll back</h1>', codeType: 'html', title: 'must roll back' }
  });
  assert.equal(retry.status, 200, 'the failed attempt left no idempotency tombstone');
  assert.equal((await app.locals.pageRepository.getShareGrant(key.id, retry.body.urlId)).can_update, true);
});

test('managed update requires both scopes and a per-Share read+update grant', async () => {
  const key = await createKey('permission matrix key');
  const share = await createShare('permission matrix');
  const content = await request(`/api/v1/shares/${share.urlId}/content`, { headers: { 'X-API-Key': process.env.SHARE_API_KEY } });
  assert.equal(content.status, 403, 'legacy Key is create-only');

  const noGrant = await request(`/api/v1/shares/${share.urlId}/content`, {
    method: 'PUT', headers: updateHeaders(key, '"content:fake:1"'), body: fullHtmlSnapshot('<h1>attempt</h1>')
  });
  assert.equal(noGrant.status, 403, 'create-only managed Key has no update scope');
  assert.equal(noGrant.body.code, 'SCOPE_REQUIRED');

  const readOnly = await request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', headers: key.headers, body: { shareId: share.urlId }
  });
  assert.equal(readOnly.status, 201);
  const denied = await request(`/api/v1/shares/${share.urlId}/content`, {
    method: 'PUT', headers: updateHeaders(key, '"content:fake:1"'), body: fullHtmlSnapshot('<h1>attempt</h1>')
  });
  assert.equal(denied.status, 403, 'read grant alone is not edit authority');

  const edit = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: key.headers, body: { canUpdate: true }
  });
  assert.equal(edit.status, 200);
  const changed = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: key.headers, body: { canUpdate: false }
  });
  assert.equal(changed.body.grant.canRead, true);
  assert.equal(changed.body.grant.canUpdate, false);
});

test('PUT content requires strict full snapshot, If-Match and Idempotency-Key with stable status errors', async () => {
  const key = await createKey('validation key');
  const share = await createShare('validation target');
  assert.equal((await grantEdit(key, share.urlId)).status, 201);
  const path = `/api/v1/shares/${share.urlId}/content`;
  const current = await request(path, { headers: { 'X-API-Key': key.secret } });
  const body = fullHtmlSnapshot('<h1>candidate</h1>');

  const missingId = await request(path, { method: 'PUT', headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag') }, body });
  assert.equal(missingId.status, 428);
  assert.equal(missingId.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const missingMatch = await request(path, { method: 'PUT', headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue37-validation-0001' }, body });
  assert.equal(missingMatch.status, 428);

  for (const etag of ['*', 'W/"content:any:1"', '"content:any:1", "content:any:2"', '"access:any:1"']) {
    const invalid = await request(path, { method: 'PUT', headers: updateHeaders(key, etag, 'issue37-validation-0002'), body });
    assert.equal(invalid.status, 400, etag);
    assert.equal(invalid.body.requestId, 'issue37-validation-0002');
  }
  const invalidId = await request(path, { method: 'PUT', headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag'), 'Idempotency-Key': 'invalid id' }, body });
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.code, 'INVALID_REQUEST_ID');

  for (const candidate of [
    { ...body, title: undefined },
    { ...body, privatePolicy: 'ignored?' },
    { ...body, isProtected: false },
    { ...body, is_favorite: true },
    { ...body, view_count: 0 },
    { ...body, expiresAt: null },
    { ...body, published: false },
    { ...body, password: 'private' },
    { ...body, codeType: 'markdown' },
    { ...body, markdownTheme: 'unknown-theme' },
    { ...body, markdownTheme: 'github', codeType: 'html' },
    { ...body, htmlContent: '' }
  ]) {
    const invalid = await request(path, {
      method: 'PUT', headers: updateHeaders(key, current.headers.get('etag'), `issue37-invalid-${String(Math.random()).slice(2, 10)}`), body: candidate
    });
    assert.equal(invalid.status, 400, JSON.stringify(candidate));
    assert.equal(invalid.body.retryable, false);
  }
  const stored = await request(path, { headers: { 'X-API-Key': key.secret } });
  assert.equal(stored.body.htmlContent, '<h1>validation target</h1>\r\n<p>original</p>');

  const tooLarge = await request(path, {
    method: 'PUT',
    headers: updateHeaders(key, current.headers.get('etag'), 'issue37-large-body-0001'),
    body: { ...body, htmlContent: 'x'.repeat(70 * 1024) }
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(tooLarge.body.requestId, 'issue37-large-body-0001');
});

test('conditional update preserves body bytes, original URL, no-op and replay semantics; status is bounded', async () => {
  const key = await createKey('successful update key');
  const share = await createShare('successful update');
  const otherGrantShare = await createShare('keeps update scope after target revoke');
  assert.equal((await grantEdit(key, share.urlId)).status, 201);
  assert.equal((await grantEdit(key, otherGrantShare.urlId)).status, 201);
  const path = `/api/v1/shares/${share.urlId}/content`;
  const initial = await request(path, { headers: { 'X-API-Key': key.secret } });
  assert.equal('url' in initial.body, false, 'content endpoint remains a content-only snapshot');
  const originalUrl = share.url;
  const requestId = 'issue37-content-update-1001';
  const rawBody = '<main>line one\r\n  line two\n漢字</main>';
  const candidate = fullHtmlSnapshot(rawBody);
  const result = await request(path, {
    method: 'PUT', headers: updateHeaders(key, initial.headers.get('etag'), requestId), body: candidate
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.changed, true);
  assert.equal(result.body.requestId, requestId);
  assert.equal(result.body.url, originalUrl, 'update must return the same Share URL, never a clone');
  assert.equal(result.body.page.id, share.urlId);
  assert.equal(result.body.page.currentRevision, '2');
  assert.equal(result.body.page.htmlContent, rawBody, 'body newline and Unicode characters are preserved exactly');
  assert.equal(result.body.page.title, 'Agent   revised title');
  assert.equal(result.body.page.description, 'revised description');
  assert.equal(result.body.page.codeType, 'html');
  assert.equal(result.body.page.markdownTheme, null);
  assert.match(result.headers.get('cache-control'), /private, no-store/);

  const noOpBase = await request(path, { headers: { 'X-API-Key': key.secret } });
  const noOp = await request(path, {
    method: 'PUT', headers: updateHeaders(key, noOpBase.headers.get('etag'), 'issue37-content-update-1002'),
    body: { htmlContent: rawBody, title: 'Agent   revised title', description: 'revised description', markdownTheme: null }
  });
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.changed, false);
  assert.equal(noOp.body.page.currentRevision, '2', 'no-op does not manufacture a new content revision');

  const afterNoOpBase = await request(path, { headers: { 'X-API-Key': key.secret } });
  const replayId = 'issue37-content-update-1003';
  const replayBody = { htmlContent: '<h1>first</h1>', title: 'First', description: null, markdownTheme: null };
  const first = await request(path, {
    method: 'PUT', headers: updateHeaders(key, afterNoOpBase.headers.get('etag'), replayId), body: replayBody
  });
  assert.equal(first.status, 200);
  const laterBase = await request(path, { headers: { 'X-API-Key': key.secret } });
  const later = await request(path, {
    method: 'PUT', headers: updateHeaders(key, laterBase.headers.get('etag'), 'issue37-content-update-1004'),
    body: { htmlContent: '<h1>later</h1>', title: 'Later', description: null, markdownTheme: null }
  });
  assert.equal(later.status, 200);
  const replay = await request(path, {
    method: 'PUT', headers: updateHeaders(key, afterNoOpBase.headers.get('etag'), replayId), body: replayBody
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.page.currentRevision, first.body.page.currentRevision);
  assert.equal(replay.body.page.htmlContent, '<h1>first</h1>', 'replay returns committed snapshot, not current live body');
  assert.equal(replay.body.url, originalUrl);

  const operation = await request(`/api/v1/operations/${replayId}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(operation.status, 200);
  assert.equal(operation.body.operations[0].action, 'content-update');
  assert.equal(operation.body.operations[0].status, 'succeeded');
  for (const forbidden of ['htmlContent', '<h1>first</h1>', 'title', 'description', 'password', 'receipt']) {
    assert.equal(operation.text.includes(forbidden), false, `operation status excludes ${forbidden}`);
  }
  const other = await createKey('other namespace key');
  const crossKey = await request(`/api/v1/operations/${replayId}`, { headers: { 'X-API-Key': other.secret } });
  assert.equal(crossKey.status, 404);

  const revokeEdit = await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, {
    method: 'PUT', headers: key.headers, body: { canUpdate: false }
  });
  assert.equal(revokeEdit.status, 200);
  const revokedStatus = await request(`/api/v1/operations/${replayId}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(revokedStatus.status, 404, 'operation status rechecks current update grant');
});

test('conditional update accepts a known Markdown preset without changing the immutable content type', async () => {
  const key = await createKey('Markdown update key');
  const created = await request('/api/v1/share', {
    method: 'POST', headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent: '# original\n', codeType: 'markdown', title: 'Markdown target', markdownTheme: 'github' }
  });
  assert.equal(created.status, 200);
  assert.equal((await grantEdit(key, created.body.urlId)).status, 201);
  const path = `/api/v1/shares/${created.body.urlId}/content`;
  const baseline = await request(path, { headers: { 'X-API-Key': key.secret } });
  assert.equal(baseline.body.markdownTheme, 'github');

  const revisedContent = '# revised\r\n\n保持原始换行';
  const updated = await request(path, {
    method: 'PUT',
    headers: updateHeaders(key, baseline.headers.get('etag'), 'issue37-markdown-update-0001'),
    body: { htmlContent: revisedContent, title: 'Markdown revised', description: null, markdownTheme: 'notion', codeType: 'markdown' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.page.htmlContent, revisedContent);
  assert.equal(updated.body.page.codeType, 'markdown');
  assert.equal(updated.body.page.markdownTheme, 'notion');

  const changedBaseline = await request(path, { headers: { 'X-API-Key': key.secret } });
  const missingTheme = await request(path, {
    method: 'PUT',
    headers: updateHeaders(key, changedBaseline.headers.get('etag'), 'issue37-markdown-update-0002'),
    body: { htmlContent: '# invalid', title: 'Invalid', description: null, markdownTheme: null }
  });
  assert.equal(missingTheme.status, 400, 'Markdown content requires a known preset');
});

test('API/API same-baseline and dashboard/API races each commit at most one content write', async () => {
  const key = await createKey('race key');
  const share = await createShare('race target');
  assert.equal((await grantEdit(key, share.urlId)).status, 201);
  const path = `/api/v1/shares/${share.urlId}/content`;
  let baseline = await request(path, { headers: { 'X-API-Key': key.secret } });
  const apiRace = await Promise.all(['issue37-api-race-0001', 'issue37-api-race-0002'].map((id, index) => request(path, {
    method: 'PUT', headers: updateHeaders(key, baseline.headers.get('etag'), id),
    body: fullHtmlSnapshot(`<h1>api ${index}</h1>`)
  })));
  assert.equal(apiRace.filter(response => response.status === 200).length, 1);
  assert.equal(apiRace.filter(response => response.status === 412).length, 1);

  const dashboardHeadersValue = key.headers;
  const page = await request(`/admin/pages/${share.urlId}`, { headers: { Cookie: dashboardHeadersValue.Cookie } });
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)?.[1] || dashboardHeadersValue['X-CSRF-Token'];
  baseline = await request(path, { headers: { 'X-API-Key': key.secret } });
  const mixed = await Promise.all([
    request(path, { method: 'PUT', headers: updateHeaders(key, baseline.headers.get('etag'), 'issue37-mixed-api-0001'), body: fullHtmlSnapshot('<h1>api mixed</h1>') }),
    request(`/admin/pages/${share.urlId}`, {
      method: 'PUT', headers: { Cookie: dashboardHeadersValue.Cookie, 'X-CSRF-Token': csrf, 'If-Match': baseline.headers.get('etag'), 'Idempotency-Key': 'issue37-mixed-dashboard-0001' },
      body: { htmlContent: '<h1>dashboard mixed</h1>', title: 'dashboard', description: null, markdownTheme: null }
    })
  ]);
  assert.equal(mixed.filter(response => response.status === 200).length, 1);
  assert.ok(mixed.some(response => response.status === 412));
});
