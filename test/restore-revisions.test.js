const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Retryable admin saves and history restore (T09, issue #33): the
// dashboard save and the new restore endpoint run the T08 operation
// protocol in the dashboard namespace. A committed operation is
// resolved BEFORE any precondition is judged, so a successful retry is
// never misreported as a stale-If-Match failure and never mints a
// second Revision; a restore writes the chosen snapshot forward as a
// new Revision recording its source, and never touches the access
// policy, publish state, favorite or view count.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = '<redacted>';
process.env.ADMIN_DASHBOARD_PASSWORD = '<redacted>';
process.env.SHARE_API_KEY = 't09-legacy-key';
process.env.SESSION_SECRET = '<redacted>';
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
    body: 'password=<redacted>'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCsrf(cookie, pagePath) {
  const page = await request(pagePath, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const match = page.text.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function createViaApiKey(body) {
  const res = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': 't09-legacy-key' },
    body
  });
  assert.equal(res.status, 200, res.text);
  return res.json.urlId;
}

function etagFor(id, revision) {
  return `"content:${id}:${revision}"`;
}

async function currentEtag(id) {
  const page = await repository.getById(id);
  return etagFor(id, page.current_revision);
}

async function saveWithKey(cookie, csrf, id, { body, etag, key }) {
  return jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      ...(etag ? { 'If-Match': etag } : {}),
      ...(key ? { 'Idempotency-Key': key } : {})
    },
    body
  });
}

async function legacyEdit(cookie, csrf, id, candidate) {
  const res = await saveWithKey(cookie, csrf, id, {
    body: candidate,
    etag: await currentEtag(id)
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

async function restore(cookie, csrf, id, revision, { etag, key, bodyRequestId } = {}) {
  return jsonRequest(`/admin/pages/${id}/revisions/${revision}/restore`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      ...(etag ? { 'If-Match': etag } : {}),
      ...(key ? { 'Idempotency-Key': key } : {})
    },
    body: bodyRequestId ? { requestId: bodyRequestId } : {}
  });
}

async function operationStatus(cookie, requestId) {
  return jsonRequest(`/admin/operations/${requestId}`, {
    headers: { Cookie: cookie }
  });
}

async function revisionCount(id) {
  return (await repository.listContentRevisionMeta(id, { limit: 100, offset: 0 })).total;
}

test('idempotent save: replay consults the committed result before the stale If-Match', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<h1>v1</h1>', codeType: 'html', title: 'Save replay' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const first = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Save replay', htmlContent: '<h1>v2</h1>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.success, true);
  assert.equal(first.json.requestId, key);
  assert.equal(first.json.contentChanged, true);
  assert.equal(first.json.page.currentRevision, '2');

  // The operation is confirmable in the dashboard namespace.
  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.action, 'share.content.update');
  assert.equal(status.json.status, 'committed');
  assert.equal(status.json.shareId, id);
  assert.equal(status.json.contentRevision, '2');

  // Another tab advances the content to Revision 3. The original
  // request's If-Match (Revision 1) is now doubly stale — the replay
  // must still return the committed result, not a 412.
  await legacyEdit(cookie, csrf, id, { title: 'Save replay', htmlContent: '<h1>v3</h1>' });
  assert.equal(await revisionCount(id), 3);

  const replay = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Save replay', htmlContent: '<h1>v2</h1>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.contentRevision, '2');
  assert.equal(replay.json.contentChanged, true);

  // No second version was minted and the current content is untouched.
  assert.equal(await revisionCount(id), 3);
  const page = await repository.getById(id);
  assert.equal(String(page.current_revision), '3');
  assert.equal(page.html_content, '<h1>v3</h1>');

  // The same identifier with a different body is a conflict.
  const conflict = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Save replay', htmlContent: '<h1>different</h1>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'idempotency_conflict');
});

test('unchanged idempotent save records the operation without a new Revision', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>same</p>', codeType: 'html', title: 'Unchanged' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const res = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Unchanged', htmlContent: '<p>same</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.contentChanged, false);
  assert.equal(res.json.page.currentRevision, '1');
  assert.equal(await revisionCount(id), 1);

  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.action, 'share.content.update');
  assert.equal(status.json.contentRevision, '1');

  const replay = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Unchanged', htmlContent: '<p>same</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.contentChanged, false);
});

test('a failed first save does not consume the identifier', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>a</p>', codeType: 'html', title: 'Retry after failure' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  // Stale precondition: the save fails with 412 and records nothing.
  const failed = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Retry after failure', htmlContent: '<p>b</p>' },
    etag: etagFor(id, '99'),
    key
  });
  assert.equal(failed.status, 412);
  assert.equal(failed.json.code, 'content_conflict');

  const missing = await operationStatus(cookie, key);
  assert.equal(missing.status, 404);

  // The same identifier with the corrected precondition executes.
  const corrected = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Retry after failure', htmlContent: '<p>b</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(corrected.status, 200, corrected.text);
  assert.equal(corrected.json.page.currentRevision, '2');
});

test('malformed Idempotency-Key on save is a 400, never a silent unkeyed save', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>a</p>', codeType: 'html', title: 'Bad key' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);

  const res = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Bad key', htmlContent: '<p>b</p>' },
    etag: etagFor(id, '1'),
    key: 'short'
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'invalid_idempotency_key');

  const page = await repository.getById(id);
  assert.equal(page.html_content, '<p>a</p>');
});

test('restore writes a new Revision recording its source and replays safely', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<h1>original</h1>', codeType: 'html', title: 'Restore me' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);

  await legacyEdit(cookie, csrf, id, { title: 'Restore me', htmlContent: '<h1>edited</h1>' });

  const key = randomUUID();
  const restored = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '2'), key });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.success, true);
  assert.equal(restored.json.unchanged, false);
  assert.equal(restored.json.sourceRevision, '1');
  assert.equal(restored.json.previousRevision, '2');
  assert.equal(restored.json.contentRevision, '3');
  assert.equal(restored.json.requestId, key);

  const page = await repository.getById(id);
  assert.equal(page.html_content, '<h1>original</h1>');
  assert.equal(String(page.current_revision), '3');

  // The new Revision records where it came from.
  const snapshot = await repository.getContentSnapshot(id, '3');
  assert.equal(snapshot.source, 'admin-restore');
  assert.equal(String(snapshot.restored_from_revision), '1');

  // The operation is confirmable.
  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.action, 'share.restore');
  assert.equal(status.json.contentRevision, '3');

  // Advancing the content makes the original If-Match stale; the
  // replay still returns the committed restore result.
  await legacyEdit(cookie, csrf, id, { title: 'Restore me', htmlContent: '<h1>later</h1>' });
  const replay = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '2'), key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.contentRevision, '3');
  assert.equal(replay.json.sourceRevision, '1');
  assert.equal(await revisionCount(id), 4);

  // Same identifier, different source: conflict.
  const conflict = await restore(cookie, csrf, id, '2', { etag: etagFor(id, '2'), key });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'idempotency_conflict');

  // The identifier may also travel in the JSON body.
  const bodyKey = randomUUID();
  const viaBody = await restore(cookie, csrf, id, '2', {
    etag: await currentEtag(id),
    bodyRequestId: bodyKey
  });
  assert.equal(viaBody.status, 200, viaBody.text);
  assert.equal(viaBody.json.requestId, bodyKey);
  const bodyStatus = await operationStatus(cookie, bodyKey);
  assert.equal(bodyStatus.json.action, 'share.restore');
});

test('restore preconditions: missing If-Match is 428, stale is 412, unknown source is 404', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>one</p>', codeType: 'html', title: 'Preconditions' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  await legacyEdit(cookie, csrf, id, { title: 'Preconditions', htmlContent: '<p>two</p>' });

  const missing = await restore(cookie, csrf, id, '1', {});
  assert.equal(missing.status, 428);
  assert.equal(missing.json.code, 'content_precondition_required');
  assert.equal(missing.json.contentRevision, '2');

  const stale = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '1') });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'content_conflict');
  assert.equal(stale.json.contentRevision, '2');
  assert.equal(stale.json.current.htmlContent, '<p>two</p>');

  const unknown = await restore(cookie, csrf, id, '99', { etag: etagFor(id, '2') });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'revision_not_found');

  const malformed = await restore(cookie, csrf, id, 'abc', { etag: etagFor(id, '2') });
  assert.equal(malformed.status, 404);

  // Nothing was written by any of the failed attempts.
  assert.equal(await revisionCount(id), 2);
  const page = await repository.getById(id);
  assert.equal(page.html_content, '<p>two</p>');
});

test('restoring the current content is a recorded no-op', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>stay</p>', codeType: 'html', title: 'No-op restore' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const res = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '1'), key });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.unchanged, true);
  assert.equal(res.json.contentChanged, false);
  assert.equal(res.json.contentRevision, '1');
  assert.equal(await revisionCount(id), 1);

  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.action, 'share.restore');
  assert.equal(status.json.contentRevision, '1');

  const replay = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '1'), key });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.unchanged, true);
});

test('restore preserves the access policy, publish state, favorite and view count', async () => {
  const cookie = await loginDashboard();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  await repository.create({
    id: 't09-restore-preserve',
    htmlContent: '<p>locked v1</p>',
    createdAt: Date.now(),
    passwordHash: await hashSecret('Keep9!'),
    encryptedPassword: encryptSecret('Keep9!'),
    isProtected: true,
    codeType: 'html',
    title: 'Preserve',
    description: 'keep me',
    expiresAt,
    markdownTheme: null
  });
  const id = 't09-restore-preserve';
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);

  // Advance content, favorite the Share and count a view.
  await legacyEdit(cookie, csrf, id, {
    title: 'Preserve', description: 'keep me', htmlContent: '<p>locked v2</p>'
  });
  const favorite = await jsonRequest(`/admin/pages/${id}/favorite`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { isFavorite: true }
  });
  assert.equal(favorite.status, 200, favorite.text);
  await repository.recordViewEvent(id, Date.now(), true);

  const before = await repository.getById(id);
  const restored = await restore(cookie, csrf, id, '1', {
    etag: etagFor(id, String(before.current_revision)),
    key: randomUUID()
  });
  assert.equal(restored.status, 200, restored.text);

  const after = await repository.getById(id);
  assert.equal(after.html_content, '<p>locked v1</p>');
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.encrypted_password, before.encrypted_password);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(String(after.access_revision), String(before.access_revision));
  assert.equal(after.published, before.published);
  assert.equal(after.is_favorite, before.is_favorite);
  assert.equal(after.view_count, before.view_count);

  // The old password still unlocks with the same access cookie family.
  const unlock = await jsonRequest(`/view/${id}/password`, {
    method: 'POST',
    body: { password: 'Keep9!' }
  });
  assert.equal(unlock.status, 200, unlock.text);
});

test('a purged snapshot tombstone is not a valid restore source', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>purge v1</p>', codeType: 'html', title: 'Purged source' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  await legacyEdit(cookie, csrf, id, { title: 'Purged source', htmlContent: '<p>purge v2</p>' });

  // Simulate the tombstone a later purge ticket will write: the
  // Revision's metadata stays listed, its content is gone. (The
  // current Postgres schema cannot represent this yet — html_content
  // is NOT NULL there — so the case is exercised on the memory
  // adapter, whose restore path applies the same refusal.)
  repository.revisions.get(id).get('1').html_content = null;

  const res = await restore(cookie, csrf, id, '1', { etag: etagFor(id, '2'), key: randomUUID() });
  assert.equal(res.status, 410);
  assert.equal(res.json.code, 'revision_unavailable');
  assert.equal(res.json.retryable, false);

  // Nothing was written and the surviving snapshot still restores.
  assert.equal(await revisionCount(id), 2);
  const page = await repository.getById(id);
  assert.equal(page.html_content, '<p>purge v2</p>');
});

test('restore requires the dashboard identity and CSRF token', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>x</p>', codeType: 'html', title: 'Boundary' });

  const anonymous = await jsonRequest(`/admin/pages/${id}/revisions/1/restore`, {
    method: 'POST',
    headers: { 'If-Match': etagFor(id, '1') },
    body: {}
  });
  assert.equal(anonymous.status, 401);

  const apiKey = await jsonRequest(`/admin/pages/${id}/revisions/1/restore`, {
    method: 'POST',
    headers: { 'X-API-Key': 't09-legacy-key', 'If-Match': etagFor(id, '1') },
    body: {}
  });
  assert.equal(apiKey.status, 401);

  const noCsrf = await jsonRequest(`/admin/pages/${id}/revisions/1/restore`, {
    method: 'POST',
    headers: { Cookie: cookie, 'If-Match': etagFor(id, '1') },
    body: {}
  });
  assert.equal(noCsrf.status, 403);
});

test('during write maintenance, save and restore are refused but operations stay confirmable', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>m1</p>', codeType: 'html', title: 'Maintenance' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const done = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Maintenance', htmlContent: '<p>m2</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(done.status, 200, done.text);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });
  try {
    const replayDuringPause = await saveWithKey(cookie, csrf, id, {
      body: { title: 'Maintenance', htmlContent: '<p>m2</p>' },
      etag: etagFor(id, '1'),
      key
    });
    assert.equal(replayDuringPause.status, 503);
    assert.equal(replayDuringPause.json.code, 'maintenance');

    const restoreDuringPause = await restore(cookie, csrf, id, '1', {
      etag: etagFor(id, '2'),
      key: randomUUID()
    });
    assert.equal(restoreDuringPause.status, 503);
    assert.equal(restoreDuringPause.json.code, 'maintenance');

    // Confirmation is a read: it keeps working while writes are paused.
    const status = await operationStatus(cookie, key);
    assert.equal(status.status, 200);
    assert.equal(status.json.status, 'committed');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  // After the pause the same replay succeeds against the ledger.
  const replayAfter = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Maintenance', htmlContent: '<p>m2</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(replayAfter.status, 200);
  assert.equal(replayAfter.json.replayed, true);
});

test('replay of a save whose Share was deleted answers 410 result unavailable', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>gone</p>', codeType: 'html', title: 'Deleted' });
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const done = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Deleted', htmlContent: '<p>gone v2</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(done.status, 200, done.text);

  await repository.deletePage(id);

  const replay = await saveWithKey(cookie, csrf, id, {
    body: { title: 'Deleted', htmlContent: '<p>gone v2</p>' },
    etag: etagFor(id, '1'),
    key
  });
  assert.equal(replay.status, 410);
  assert.equal(replay.json.code, 'operation_result_unavailable');

  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.status, 'result_unavailable');
});

test('detail page carries the restore panel, buttons and the restore client contract', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>ui</p>', codeType: 'html', title: 'UI contract' });

  const page = await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.text, /id="history-restore"/);
  assert.match(page.text, /id="history-restore-confirm"/);
  assert.match(page.text, /恢复会将所选版本的内容写入为新的当前 Revision/);
  assert.match(page.text, /\/js\/publish-intent\.js/);
  assert.match(page.text, /\/js\/admin-history\.js/);

  const historyJs = await request('/js/admin-history.js');
  assert.equal(historyJs.status, 200);
  assert.match(historyJs.text, /'admin-restore': '历史恢复'/);
  assert.match(historyJs.text, /Idempotency-Key/);
  assert.match(historyJs.text, /\/restore/);

  const detailJs = await request('/js/admin-detail.js');
  assert.equal(detailJs.status, 200);
  assert.match(detailJs.text, /Idempotency-Key/);
  assert.match(detailJs.text, /quickshare:revision-changed/);
});
