const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Granted content update for managed API Keys (T13, issue #37): after
// the owner grants edit rights on a Share, a Key holding the read AND
// update scopes can replace that Share's content with a complete
// snapshot — concrete content If-Match and Idempotency-Key mandatory —
// through the SAME content transaction the dashboard uses (shared
// compare-and-swap, no-op rule, audit and operation ledger), in the
// Key's own operation namespace. Authorization stays the conjunction
// of current scopes and the current grant, re-verified at commit time:
// revocation or rotation that commits first refuses the write.
// auto_grant_new_share_edit (default off) mints read+update grants —
// never publish — inside the create transaction for the Key's own
// future creations only.

const DASHBOARD_PASSWORD = ['t13', 'dashboard', 'pass', '1'].join('-') + '!';

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = ['t13', 'auth', 'pass', '1'].join('-') + '!';
process.env.ADMIN_DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
process.env.SHARE_API_KEY = ['legacy', 'test', 'key', '130'].join('-');
process.env.SESSION_SECRET = ['t13', 'session', 'secret'].join('-');
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

async function seedPage({ id, createdAt = Date.now(), password = null, expiresAt = null, codeType = 'html', markdownTheme = null, htmlContent = null, title = null, description = null }) {
  await repository.create({
    id,
    htmlContent: htmlContent ?? `<h1>body-${id}</h1>`,
    createdAt,
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType,
    title: title ?? `title-${id}`,
    description: description ?? `description-${id}`,
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

function putContent(keyHeaders, shareId, body, { ifMatch, idempotencyKey } = {}) {
  const headers = { ...keyHeaders };

  if (ifMatch !== undefined) {
    headers['If-Match'] = ifMatch;
  }

  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return jsonRequest(`/api/v1/shares/${shareId}/content`, {
    method: 'PUT',
    headers,
    body
  });
}

function snapshotOf(page) {
  return {
    htmlContent: page.html_content,
    title: page.title,
    description: page.description,
    markdownTheme: page.markdown_theme
  };
}

const FULL_SCOPES = ['share:create', 'share:read', 'share:update'];

test('content update refuses missing, invalid, legacy and under-scoped credentials', async () => {
  await seedPage({ id: 't13-auth-share' });
  const readOnly = await seedKey('t13-auth-readonly', { scopes: ['share:create', 'share:read'] });
  const updateOnly = await seedKey('t13-auth-updateonly', { scopes: ['share:create', 'share:update'] });
  const editor = await seedKey('t13-auth-editor', { scopes: FULL_SCOPES });
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await grantViaAdmin(cookie, csrf, 't13-auth-readonly', 't13-auth-share', { read: true });
  await grantViaAdmin(cookie, csrf, 't13-auth-editor', 't13-auth-share', { read: true });

  const page = await repository.getById('t13-auth-share');
  const body = snapshotOf(page);
  const attempt = { ifMatch: '"content:t13-auth-share:1"', idempotencyKey: randomUUID() };

  const missing = await putContent({}, 't13-auth-share', body, attempt);
  assert.equal(missing.status, 401);

  const invalid = await putContent({ 'X-API-Key': 'qs.nope.invalidsecret0123456789' }, 't13-auth-share', body, attempt);
  assert.equal(invalid.status, 401);

  const legacy = await putContent({ 'X-API-Key': process.env.SHARE_API_KEY }, 't13-auth-share', body, attempt);
  assert.equal(legacy.status, 403);
  assert.equal(legacy.json.code, 'insufficient_scope');

  // Read scope without the update scope: 403 even with a grant.
  const readAttempt = await putContent(readOnly.headers, 't13-auth-share', body, attempt);
  assert.equal(readAttempt.status, 403);
  assert.equal(readAttempt.json.code, 'insufficient_scope');

  // Update scope without the read scope: update implies read at the
  // scope level too (parent spec #24 §6), so this is also a 403.
  const updateAttempt = await putContent(updateOnly.headers, 't13-auth-share', body, attempt);
  assert.equal(updateAttempt.status, 403);
  assert.equal(updateAttempt.json.code, 'insufficient_scope');

  // Full scopes but only a READ grant on the target: 404, the same
  // body as a nonexistent Share.
  const readGrant = await putContent(editor.headers, 't13-auth-share', body, attempt);
  assert.equal(readGrant.status, 404);
  assert.equal(readGrant.json.code, 'share_not_found');

  const noGrant = await putContent(editor.headers, 't13-no-such-share', body, {
    ifMatch: '"content:t13-no-such-share:1"',
    idempotencyKey: randomUUID()
  });
  assert.equal(noGrant.status, 404);
  assert.deepEqual(noGrant.json, readGrant.json);
});

test('admin assigns the update scope and edit grant; publish stays refused', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedKey('t13-admin-key');
  await seedPage({ id: 't13-admin-share' });

  const publishScope = await jsonRequest('/admin/apis/keys/t13-admin-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: ['share:create', 'share:publish'] }
  });
  assert.equal(publishScope.status, 400);
  assert.equal(publishScope.json.code, 'invalid_scopes');

  const updateScope = await jsonRequest('/admin/apis/keys/t13-admin-key/scopes', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { scopes: FULL_SCOPES }
  });
  assert.equal(updateScope.status, 200, updateScope.text);
  assert.deepEqual(updateScope.json.apiKey.scopes, FULL_SCOPES);

  const editGrant = await grantViaAdmin(cookie, csrf, 't13-admin-key', 't13-admin-share', { update: true });
  assert.equal(editGrant.status, 201, editGrant.text);
  assert.deepEqual(editGrant.json.grant.permissions, { read: true, update: true, publish: false });

  const publishGrant = await grantViaAdmin(cookie, csrf, 't13-admin-key', 't13-admin-share', { publish: true });
  assert.equal(publishGrant.status, 400);
  assert.equal(publishGrant.json.code, 'grant_permission_not_available');
});

test('granted key replaces the full snapshot; the original URL is returned', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-basic-share' });
  const editor = await seedKey('t13-basic-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-basic-key', 't13-basic-share', { update: true });

  const response = await putContent(editor.headers, 't13-basic-share', {
    htmlContent: '<p>replaced body</p>',
    title: 'Replaced title',
    description: 'Replaced description',
    markdownTheme: null
  }, { ifMatch: '"content:t13-basic-share:1"', idempotencyKey: randomUUID() });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.success, true);
  assert.equal(response.json.action, 'share.content.update');
  assert.equal(response.json.shareId, 't13-basic-share');
  assert.ok(response.json.url.endsWith('/view/t13-basic-share'));
  assert.equal(response.json.contentChanged, true);
  assert.equal(response.json.contentRevision, '2');
  assert.equal(response.json.contentEtag, '"content:t13-basic-share:2"');
  assert.equal(response.json.accessRevision, '1');
  assert.deepEqual(response.json.share, {
    id: 't13-basic-share',
    contentRevision: '2',
    htmlContent: '<p>replaced body</p>',
    codeType: 'html',
    title: 'Replaced title',
    description: 'Replaced description',
    markdownTheme: null
  });

  // The new snapshot is a real Revision in the shared history, written
  // by the shared transaction with API provenance, and the content
  // audit names it.
  const snapshot = await repository.getContentSnapshot('t13-basic-share', '2');
  assert.equal(snapshot.html_content, '<p>replaced body</p>');
  assert.equal(snapshot.title, 'Replaced title');
  assert.equal(snapshot.source, 'api-update');
  assert.equal(snapshot.actor_type, 'api_key');
  assert.equal(snapshot.actor_id, 't13-basic-key');

  const audits = await repository.listAuditLogs({ limit: 100 });
  const contentAudit = audits.find(entry => entry.action === 'page.content.update' && entry.pageId === 't13-basic-share');
  assert.ok(contentAudit, 'the shared content audit must be written');
  assert.equal(JSON.parse(contentAudit.details).source, 'api-update');

  // The read surface serves the new snapshot under its new ETag.
  const readBack = await jsonRequest('/api/v1/shares/t13-basic-share/content', { headers: editor.headers });
  assert.equal(readBack.status, 200);
  assert.equal(readBack.headers.etag, '"content:t13-basic-share:2"');
  assert.equal(readBack.json.share.htmlContent, '<p>replaced body</p>');

  // A content update never advances the access revision.
  const state = await jsonRequest('/api/v1/shares/t13-basic-share/state', { headers: editor.headers });
  assert.equal(state.json.share.accessRevision, '1');
});

test('body bytes are preserved exactly: no trimming or reordering', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-bytes-share' });
  const editor = await seedKey('t13-bytes-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-bytes-key', 't13-bytes-share', { update: true });

  const rawBody = '  <p>lead and trail</p>\r\n\r\n<p>second</p>  ';
  const response = await putContent(editor.headers, 't13-bytes-share', {
    htmlContent: rawBody,
    title: 'title-t13-bytes-share',
    description: 'description-t13-bytes-share',
    markdownTheme: null
  }, { ifMatch: '"content:t13-bytes-share:1"', idempotencyKey: randomUUID() });

  assert.equal(response.status, 200, response.text);
  const readBack = await jsonRequest('/api/v1/shares/t13-bytes-share/content', { headers: editor.headers });
  assert.equal(readBack.json.share.htmlContent, rawBody);
});

test('no-op update reports unchanged, writes no Revision, and replays by identifier', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-noop-share' });
  const editor = await seedKey('t13-noop-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-noop-key', 't13-noop-share', { update: true });

  const page = await repository.getById('t13-noop-share');
  const body = snapshotOf(page);
  const idempotencyKey = randomUUID();

  const response = await putContent(editor.headers, 't13-noop-share', body, {
    ifMatch: '"content:t13-noop-share:1"',
    idempotencyKey
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.contentChanged, false);
  assert.equal(response.json.contentRevision, '1');

  const snapshots = await repository.listContentSnapshots('t13-noop-share');
  assert.equal(snapshots.length, 1);

  // The no-op still recorded its operation: an exact retry replays it.
  const retry = await putContent(editor.headers, 't13-noop-share', body, {
    ifMatch: '"content:t13-noop-share:1"',
    idempotencyKey
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.replayed, true);
  assert.equal(retry.json.contentChanged, false);
  assert.equal(retry.json.contentRevision, '1');

  // And the outcome is confirmable in the Key's own namespace.
  const confirmation = await jsonRequest(`/api/v1/operations/${idempotencyKey}`, { headers: editor.headers });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.json.action, 'share.content.update');
  assert.equal(confirmation.json.shareId, 't13-noop-share');
  assert.equal(confirmation.json.contentRevision, '1');
  assert.equal(confirmation.json.status, 'committed');
});

test('one identifier with a different payload or expectation is a 409', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-conflict-share' });
  const editor = await seedKey('t13-conflict-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-conflict-key', 't13-conflict-share', { update: true });

  const idempotencyKey = randomUUID();
  const body = {
    htmlContent: '<p>version two</p>',
    title: 'title-t13-conflict-share',
    description: 'description-t13-conflict-share',
    markdownTheme: null
  };

  const first = await putContent(editor.headers, 't13-conflict-share', body, {
    ifMatch: '"content:t13-conflict-share:1"',
    idempotencyKey
  });
  assert.equal(first.status, 200, first.text);

  const changedPayload = await putContent(editor.headers, 't13-conflict-share', {
    ...body,
    title: 'A different title'
  }, { ifMatch: '"content:t13-conflict-share:1"', idempotencyKey });
  assert.equal(changedPayload.status, 409);
  assert.equal(changedPayload.json.code, 'idempotency_conflict');

  const changedExpectation = await putContent(editor.headers, 't13-conflict-share', body, {
    ifMatch: '"content:t13-conflict-share:2"',
    idempotencyKey
  });
  assert.equal(changedExpectation.status, 409);
  assert.equal(changedExpectation.json.code, 'idempotency_conflict');
});

test('preconditions: missing If-Match is 428 and records nothing; stale, weak and wildcard tags are 412', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-precond-share' });
  const editor = await seedKey('t13-precond-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-precond-key', 't13-precond-share', { update: true });

  const body = {
    htmlContent: '<p>candidate</p>',
    title: 'title-t13-precond-share',
    description: 'description-t13-precond-share',
    markdownTheme: null
  };

  const idempotencyKey = randomUUID();
  const missing = await putContent(editor.headers, 't13-precond-share', body, { idempotencyKey });
  assert.equal(missing.status, 428);
  assert.equal(missing.json.code, 'content_precondition_required');
  assert.equal(missing.json.contentRevision, '1');

  // The failed attempt recorded nothing: the same identifier with the
  // precondition supplied executes as a first attempt.
  const supplied = await putContent(editor.headers, 't13-precond-share', body, {
    ifMatch: '"content:t13-precond-share:1"',
    idempotencyKey
  });
  assert.equal(supplied.status, 200, supplied.text);
  assert.equal(supplied.json.contentRevision, '2');

  // A second writer basing on Revision 1 is now stale: 412 with the
  // current remote snapshot, and its candidate is NOT applied.
  const stale = await putContent(editor.headers, 't13-precond-share', {
    ...body,
    htmlContent: '<p>stale candidate</p>'
  }, { ifMatch: '"content:t13-precond-share:1"', idempotencyKey: randomUUID() });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'content_conflict');
  assert.equal(stale.json.contentRevision, '2');
  assert.equal(stale.json.current.htmlContent, '<p>candidate</p>');

  for (const badTag of ['*', 'W/"content:t13-precond-share:2"', '"access:t13-precond-share:1"']) {
    const refused = await putContent(editor.headers, 't13-precond-share', body, {
      ifMatch: badTag,
      idempotencyKey: randomUUID()
    });
    assert.equal(refused.status, 412, `tag ${badTag} must not satisfy the precondition`);
  }

  const readBack = await jsonRequest('/api/v1/shares/t13-precond-share/content', { headers: editor.headers });
  assert.equal(readBack.json.share.htmlContent, '<p>candidate</p>');
});

test('strict snapshot validation refuses policy fields, unknown fields and incomplete snapshots', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-strict-share' });
  const editor = await seedKey('t13-strict-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-strict-key', 't13-strict-share', { update: true });

  const page = await repository.getById('t13-strict-share');
  const valid = snapshotOf(page);
  const attempt = { ifMatch: '"content:t13-strict-share:1"' };

  for (const field of ['isProtected', 'password', 'expiresAt', 'isFavorite', 'viewCount', 'published', 'accessRevision', 'somethingElse']) {
    const refused = await putContent(editor.headers, 't13-strict-share', {
      ...valid,
      [field]: field === 'viewCount' ? 99 : true
    }, { ...attempt, idempotencyKey: randomUUID() });
    assert.equal(refused.status, 400, `field ${field} must be refused`);
    assert.equal(refused.json.code, 'invalid_field');
    assert.equal(refused.json.field, field);
  }

  for (const field of ['htmlContent', 'title', 'description', 'markdownTheme']) {
    const incomplete = { ...valid };
    delete incomplete[field];
    const refused = await putContent(editor.headers, 't13-strict-share', incomplete, {
      ...attempt,
      idempotencyKey: randomUUID()
    });
    assert.equal(refused.status, 400, `missing ${field} must be refused`);
    assert.equal(refused.json.code, 'missing_field');
    assert.equal(refused.json.field, field);
  }

  const emptyBody = await putContent(editor.headers, 't13-strict-share', { ...valid, htmlContent: '' }, {
    ...attempt,
    idempotencyKey: randomUUID()
  });
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.json.code, 'invalid_content');

  const changedType = await putContent(editor.headers, 't13-strict-share', { ...valid, codeType: 'markdown' }, {
    ...attempt,
    idempotencyKey: randomUUID()
  });
  assert.equal(changedType.status, 400);
  assert.equal(changedType.json.code, 'code_type_mismatch');

  const sameType = await putContent(editor.headers, 't13-strict-share', { ...valid, codeType: 'html' }, {
    ...attempt,
    idempotencyKey: randomUUID()
  });
  assert.equal(sameType.status, 200, sameType.text);

  const noKey = await putContent(editor.headers, 't13-strict-share', valid, attempt);
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.code, 'invalid_idempotency_key');

  const badKey = await putContent(editor.headers, 't13-strict-share', valid, {
    ...attempt,
    idempotencyKey: 'short'
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.code, 'invalid_idempotency_key');

  // None of the refused attempts wrote anything.
  const after = await repository.getById('t13-strict-share');
  assert.equal(String(after.current_revision), '1');
});

test('Markdown Preset validation is strict: unknown presets are 400, never silently substituted', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-md-share', codeType: 'markdown', markdownTheme: 'github', htmlContent: '# Hello', title: 'Md', description: null });
  await seedPage({ id: 't13-html-share' });
  const editor = await seedKey('t13-md-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-md-key', 't13-md-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't13-md-key', 't13-html-share', { update: true });

  const mdAttempt = { ifMatch: '"content:t13-md-share:1"' };

  const unknown = await putContent(editor.headers, 't13-md-share', {
    htmlContent: '# Hello again',
    title: 'Md',
    description: null,
    markdownTheme: 'no-such-preset'
  }, { ...mdAttempt, idempotencyKey: randomUUID() });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'invalid_markdown_theme');

  const nullTheme = await putContent(editor.headers, 't13-md-share', {
    htmlContent: '# Hello again',
    title: 'Md',
    description: null,
    markdownTheme: null
  }, { ...mdAttempt, idempotencyKey: randomUUID() });
  assert.equal(nullTheme.status, 400);
  assert.equal(nullTheme.json.code, 'invalid_markdown_theme');

  const unchanged = await repository.getById('t13-md-share');
  assert.equal(unchanged.markdown_theme, 'github');
  assert.equal(String(unchanged.current_revision), '1');

  const themed = await putContent(editor.headers, 't13-md-share', {
    htmlContent: '# Hello again',
    title: 'Md',
    description: null,
    markdownTheme: 'notion'
  }, { ...mdAttempt, idempotencyKey: randomUUID() });
  assert.equal(themed.status, 200, themed.text);
  assert.equal(themed.json.share.markdownTheme, 'notion');
  assert.equal(themed.json.contentRevision, '2');

  const htmlThemed = await putContent(editor.headers, 't13-html-share', {
    htmlContent: '<p>x</p>',
    title: 'title-t13-html-share',
    description: 'description-t13-html-share',
    markdownTheme: 'github'
  }, { ifMatch: '"content:t13-html-share:1"', idempotencyKey: randomUUID() });
  assert.equal(htmlThemed.status, 400);
  assert.equal(htmlThemed.json.code, 'invalid_markdown_theme');
});

test('two writers on the same baseline: exactly one wins, across API and dashboard', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-race-share' });
  const editorA = await seedKey('t13-race-key-a', { scopes: FULL_SCOPES });
  const editorB = await seedKey('t13-race-key-b', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-race-key-a', 't13-race-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't13-race-key-b', 't13-race-share', { update: true });

  const page = await repository.getById('t13-race-share');
  const base = snapshotOf(page);

  const [first, second] = await Promise.all([
    putContent(editorA.headers, 't13-race-share', { ...base, htmlContent: '<p>writer A</p>' }, {
      ifMatch: '"content:t13-race-share:1"',
      idempotencyKey: randomUUID()
    }),
    putContent(editorB.headers, 't13-race-share', { ...base, htmlContent: '<p>writer B</p>' }, {
      ifMatch: '"content:t13-race-share:1"',
      idempotencyKey: randomUUID()
    })
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 412]);

  const afterRace = await repository.getById('t13-race-share');
  assert.equal(String(afterRace.current_revision), '2');

  // The dashboard save is the SAME baseline protocol: a dashboard
  // writer still holding the Revision 2 tag after the API moved the
  // Share to Revision 3 conflicts instead of overwriting.
  const apiMove = await putContent(editorA.headers, 't13-race-share', {
    ...snapshotOf(afterRace),
    htmlContent: '<p>revision three</p>'
  }, { ifMatch: '"content:t13-race-share:2"', idempotencyKey: randomUUID() });
  assert.equal(apiMove.status, 200, apiMove.text);

  const dashboardStale = await jsonRequest('/admin/pages/t13-race-share', {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:t13-race-share:2"'
    },
    body: { htmlContent: '<p>dashboard stale</p>' }
  });
  assert.equal(dashboardStale.status, 412);
  assert.equal(dashboardStale.json.code, 'content_conflict');

  const final = await repository.getById('t13-race-share');
  assert.equal(final.html_content, '<p>revision three</p>');
  assert.equal(String(final.current_revision), '3');
});

test('revocation and rotation take effect immediately; grants survive rotation', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-revoke-share' });
  const editor = await seedKey('t13-revoke-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-revoke-key', 't13-revoke-share', { update: true });

  const page = await repository.getById('t13-revoke-share');
  const body = { ...snapshotOf(page), htmlContent: '<p>before revoke</p>' };

  const before = await putContent(editor.headers, 't13-revoke-share', body, {
    ifMatch: '"content:t13-revoke-share:1"',
    idempotencyKey: randomUUID()
  });
  assert.equal(before.status, 200, before.text);

  const revoked = await jsonRequest('/admin/apis/keys/t13-revoke-key/grants/t13-revoke-share', {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf }
  });
  assert.equal(revoked.status, 200, revoked.text);

  const afterRevoke = await putContent(editor.headers, 't13-revoke-share', {
    ...body,
    htmlContent: '<p>after revoke</p>'
  }, { ifMatch: '"content:t13-revoke-share:2"', idempotencyKey: randomUUID() });
  assert.equal(afterRevoke.status, 404);
  assert.equal(afterRevoke.json.code, 'share_not_found');

  // Even the earlier committed operation cannot be replayed by the
  // revoked Key: revocation is re-verified before replay.
  const replayAfterRevoke = await putContent(editor.headers, 't13-revoke-share', body, {
    ifMatch: '"content:t13-revoke-share:1"',
    idempotencyKey: before.json.requestId
  });
  assert.equal(replayAfterRevoke.status, 404);

  await grantViaAdmin(cookie, csrf, 't13-revoke-key', 't13-revoke-share', { update: true });

  const rotated = await jsonRequest('/admin/apis/keys/t13-revoke-key/rotate', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: {}
  });
  assert.equal(rotated.status, 200, rotated.text);

  const oldSecret = await putContent(editor.headers, 't13-revoke-share', body, {
    ifMatch: '"content:t13-revoke-share:1"',
    idempotencyKey: randomUUID()
  });
  assert.equal(oldSecret.status, 401);

  const newHeaders = { 'X-API-Key': rotated.json.apiKey.secret };
  const withNewSecret = await putContent(newHeaders, 't13-revoke-share', {
    ...body,
    htmlContent: '<p>after rotation</p>'
  }, { ifMatch: '"content:t13-revoke-share:2"', idempotencyKey: randomUUID() });
  assert.equal(withNewSecret.status, 200, withNewSecret.text);
});

test('unpublished and expired Shares stay editable under a grant', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-hidden-share' });
  await seedPage({ id: 't13-expired-share', expiresAt: Date.now() - 60000 });
  const editor = await seedKey('t13-hidden-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-hidden-key', 't13-hidden-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't13-hidden-key', 't13-expired-share', { update: true });

  const unpublished = await repository.setPublishedState({
    id: 't13-hidden-share',
    published: false,
    precondition: { expectedAccessRevision: '1' },
    ip: '127.0.0.1'
  });
  assert.equal(unpublished.result.status, 'updated');

  const page = await repository.getById('t13-hidden-share');
  const updated = await putContent(editor.headers, 't13-hidden-share', {
    ...snapshotOf(page),
    htmlContent: '<p>edited while unpublished</p>'
  }, { ifMatch: '"content:t13-hidden-share:1"', idempotencyKey: randomUUID() });
  assert.equal(updated.status, 200, updated.text);

  // Public visibility is untouched: the Share is still unpublished.
  const publicView = await request('/view/t13-hidden-share');
  assert.equal(publicView.status, 404);

  const expiredPage = await repository.getById('t13-expired-share');
  const expiredUpdate = await putContent(editor.headers, 't13-expired-share', {
    ...snapshotOf(expiredPage),
    htmlContent: '<p>edited while expired</p>'
  }, { ifMatch: '"content:t13-expired-share:1"', idempotencyKey: randomUUID() });
  assert.equal(expiredUpdate.status, 200, expiredUpdate.text);
});

test('write maintenance refuses the update and its replay; the operation stays confirmable', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-maint-share' });
  const editor = await seedKey('t13-maint-key', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-maint-key', 't13-maint-share', { update: true });

  const page = await repository.getById('t13-maint-share');
  const body = { ...snapshotOf(page), htmlContent: '<p>committed before pause</p>' };
  const idempotencyKey = randomUUID();

  const committed = await putContent(editor.headers, 't13-maint-share', body, {
    ifMatch: '"content:t13-maint-share:1"',
    idempotencyKey
  });
  assert.equal(committed.status, 200, committed.text);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const replay = await putContent(editor.headers, 't13-maint-share', body, {
      ifMatch: '"content:t13-maint-share:1"',
      idempotencyKey
    });
    assert.equal(replay.status, 503);
    assert.equal(replay.json.code, 'maintenance');

    const fresh = await putContent(editor.headers, 't13-maint-share', body, {
      ifMatch: '"content:t13-maint-share:2"',
      idempotencyKey: randomUUID()
    });
    assert.equal(fresh.status, 503);

    const confirmation = await jsonRequest(`/api/v1/operations/${idempotencyKey}`, { headers: editor.headers });
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.json.action, 'share.content.update');
    assert.equal(confirmation.json.contentRevision, '2');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }
});

test('operation confirmation is scoped to the owning Key namespace', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-namespace-share' });
  const owner = await seedKey('t13-namespace-owner', { scopes: FULL_SCOPES });
  const stranger = await seedKey('t13-namespace-stranger', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-namespace-owner', 't13-namespace-share', { update: true });
  await grantViaAdmin(cookie, csrf, 't13-namespace-stranger', 't13-namespace-share', { update: true });

  const page = await repository.getById('t13-namespace-share');
  const idempotencyKey = randomUUID();
  const committed = await putContent(owner.headers, 't13-namespace-share', {
    ...snapshotOf(page),
    htmlContent: '<p>namespace-bound</p>'
  }, { ifMatch: '"content:t13-namespace-share:1"', idempotencyKey });
  assert.equal(committed.status, 200, committed.text);

  const strangerLookup = await jsonRequest(`/api/v1/operations/${idempotencyKey}`, { headers: stranger.headers });
  assert.equal(strangerLookup.status, 404);
  assert.equal(strangerLookup.json.code, 'operation_not_found');
});

test('capabilities advertise the update only when the credential can genuinely attempt it', async () => {
  const editor = await seedKey('t13-caps-editor', { scopes: FULL_SCOPES });
  const updateOnly = await seedKey('t13-caps-updateonly', { scopes: ['share:create', 'share:update'] });
  const readOnly = await seedKey('t13-caps-readonly', { scopes: ['share:create', 'share:read'] });

  const editorCaps = await jsonRequest('/api/v1/capabilities', { headers: editor.headers });
  const operations = editorCaps.json.capabilities.operations.map(operation => operation.id);
  assert.ok(operations.includes('share.content.update'));
  const updateWrite = editorCaps.json.capabilities.conditionalWrites
    .find(entry => entry.operation === 'share.content.update');
  assert.ok(updateWrite);
  assert.equal(updateWrite.requiresIfMatch, true);
  assert.equal(updateWrite.requiresIdempotencyKey, true);
  assert.equal(updateWrite.idempotency.required, true);
  assert.equal(updateWrite.idempotency.confirmationOperation, 'operation.status');

  for (const key of [updateOnly, readOnly]) {
    const caps = await jsonRequest('/api/v1/capabilities', { headers: key.headers });
    assert.ok(!caps.json.capabilities.operations.some(operation => operation.id === 'share.content.update'));
    assert.ok(!caps.json.capabilities.conditionalWrites.some(entry => entry.operation === 'share.content.update'));
  }

  const legacyCaps = await jsonRequest('/api/v1/capabilities', {
    headers: { 'X-API-Key': process.env.SHARE_API_KEY }
  });
  assert.ok(!legacyCaps.json.capabilities.operations.some(operation => operation.id === 'share.content.update'));
  assert.equal(legacyCaps.json.capabilities.conditionalWrites.length, 1);

  const me = await jsonRequest('/api/v1/me', { headers: editor.headers });
  assert.deepEqual(me.json.credential.scopes, FULL_SCOPES);
});

test('auto-edit opt-in: future creations only, read+update, never publish, no duplicates on replay', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  const editor = await seedKey('t13-auto-key', { scopes: FULL_SCOPES });
  const limited = await seedKey('t13-auto-limited', { scopes: ['share:create', 'share:read'] });

  // Enabling requires the read+update scopes first.
  const refused = await jsonRequest('/admin/apis/keys/t13-auto-limited/auto-grant', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { enabled: true }
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'auto_grant_requires_scopes');

  // A creation made BEFORE the opt-in gets no grant, and enabling the
  // flag afterwards does not reach back to it.
  const before = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: editor.headers,
    body: { htmlContent: '<p>created before opt-in</p>', codeType: 'html', title: 'Before' }
  });
  assert.equal(before.status, 200, before.text);
  assert.equal(await repository.getShareGrant('t13-auto-key', before.json.urlId), null);

  const enabled = await jsonRequest('/admin/apis/keys/t13-auto-key/auto-grant', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { enabled: true }
  });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.apiKey.auto_grant_new_share_edit, true);
  assert.equal(await repository.getShareGrant('t13-auto-key', before.json.urlId), null);

  // Plain create after the opt-in: grants land with the Share.
  const plain = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: editor.headers,
    body: { htmlContent: '<p>auto-granted plain</p>', codeType: 'html', title: 'Plain' }
  });
  assert.equal(plain.status, 200, plain.text);
  const plainGrant = await repository.getShareGrant('t13-auto-key', plain.json.urlId);
  assert.deepEqual(plainGrant.permissions, { read: true, update: true, publish: false });

  // The auto-granted Share is immediately readable and editable.
  const readBack = await jsonRequest(`/api/v1/shares/${plain.json.urlId}/content`, { headers: editor.headers });
  assert.equal(readBack.status, 200);
  const edit = await putContent(editor.headers, plain.json.urlId, {
    htmlContent: '<p>auto-granted, then edited</p>',
    title: 'Plain',
    description: null,
    markdownTheme: null
  }, { ifMatch: `"content:${plain.json.urlId}:1"`, idempotencyKey: randomUUID() });
  assert.equal(edit.status, 200, edit.text);

  // Idempotent create: grants land once; a replay does not duplicate.
  const createKey = randomUUID();
  const idempotent = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { ...editor.headers, 'Idempotency-Key': createKey },
    body: { htmlContent: '<p>auto-granted idempotent</p>', codeType: 'html', title: 'Idem' }
  });
  assert.equal(idempotent.status, 200, idempotent.text);
  const replayed = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { ...editor.headers, 'Idempotency-Key': createKey },
    body: { htmlContent: '<p>auto-granted idempotent</p>', codeType: 'html', title: 'Idem' }
  });
  assert.equal(replayed.status, 200, replayed.text);
  assert.equal(replayed.json.replayed, true);
  const grants = await repository.listShareGrants('t13-auto-key');
  assert.equal(grants.filter(grant => grant.shareId === idempotent.json.urlId).length, 1);

  // Disabling stops future grants again.
  const disabled = await jsonRequest('/admin/apis/keys/t13-auto-key/auto-grant', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { enabled: false }
  });
  assert.equal(disabled.status, 200);
  const after = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: editor.headers,
    body: { htmlContent: '<p>created after opt-out</p>', codeType: 'html', title: 'After' }
  });
  assert.equal(after.status, 200, after.text);
  assert.equal(await repository.getShareGrant('t13-auto-key', after.json.urlId), null);
});

test('protected metadata stays protected: update responses and errors carry no password material', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie);
  await seedPage({ id: 't13-secret-share', password: '135790' });
  const editor = await seedKey('t13-secret-key', { scopes: FULL_SCOPES });
  const outsider = await seedKey('t13-secret-outsider', { scopes: FULL_SCOPES });
  await grantViaAdmin(cookie, csrf, 't13-secret-key', 't13-secret-share', { update: true });

  const page = await repository.getById('t13-secret-share');
  const response = await putContent(editor.headers, 't13-secret-share', {
    ...snapshotOf(page),
    htmlContent: '<p>edited protected body</p>'
  }, { ifMatch: '"content:t13-secret-share:1"', idempotencyKey: randomUUID() });
  assert.equal(response.status, 200, response.text);
  assert.ok(!response.text.includes('135790'));
  assert.ok(!response.text.includes('password'), 'no password field leaks');

  // The access policy is untouched by the content update.
  const state = await jsonRequest('/api/v1/shares/t13-secret-share/state', { headers: editor.headers });
  assert.equal(state.json.share.isProtected, true);
  assert.equal(state.json.share.accessRevision, '1');

  const denied = await putContent(outsider.headers, 't13-secret-share', snapshotOf(page), {
    ifMatch: '"content:t13-secret-share:1"',
    idempotencyKey: randomUUID()
  });
  assert.equal(denied.status, 404);
  assert.ok(!denied.text.includes('title-t13-secret-share'));
});
