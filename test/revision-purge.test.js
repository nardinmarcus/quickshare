const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Permanent Revision purge (T10, issue #34): the owner can clear one
// non-current Revision's stored payload from the dashboard, leaving a
// content-free tombstone. The flow is dashboard-session + CSRF only —
// no API-Key endpoint, no CLI — and the request must confirm its
// target verbatim. The current version can never be purged (409);
// reading or previewing a purged version is 410; repeating a purge is
// a no-op. The same step scrubs the encrypted receipts of operations
// whose result is exactly the purged version, so a later replay of an
// old create/save cannot re-emit the cleared version's password,
// title or description — while the operation itself stays confirmable
// by identifiers.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 't10-auth-pass';
process.env.ADMIN_DASHBOARD_PASSWORD = 't10-dash-pass';
process.env.SHARE_API_KEY = 't10-legacy-key';
process.env.SESSION_SECRET = 't10-session-secret';
process.env.TZ = 'UTC';

const app = require('../app');
const repository = app.locals.pageRepository;

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
    body: 'password=t10-dash-pass'
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

async function createViaApiKey(body, { idempotencyKey } = {}) {
  const res = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: {
      'X-API-Key': 't10-legacy-key',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

function etagFor(id, revision) {
  return `"content:${id}:${revision}"`;
}

async function currentEtag(id) {
  const page = await repository.getById(id);
  return etagFor(id, page.current_revision);
}

async function legacyEdit(cookie, csrf, id, candidate) {
  const res = await jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': await currentEtag(id) },
    body: candidate
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

async function purge(cookie, csrf, id, revision, { confirmRevision, headers = {} } = {}) {
  return jsonRequest(`/admin/pages/${id}/revisions/${revision}/purge`, {
    method: 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...headers
    },
    body: confirmRevision === undefined ? {} : { confirmRevision }
  });
}

async function purgeAudits(id) {
  const logs = await repository.listAuditLogs({ limit: 200, offset: 0 });
  return logs.filter(log => log.action === 'page.revision.purge' && log.pageId === id);
}

// Builds one Share with three Revisions; current is Revision 3.
async function threeRevisionShare(cookie, title) {
  const created = await createViaApiKey({
    htmlContent: '<h1>purge v1 body</h1>', codeType: 'html', title
  });
  const id = created.urlId;
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  await legacyEdit(cookie, csrf, id, { title, htmlContent: '<h1>purge v2 body</h1>' });
  await legacyEdit(cookie, csrf, id, { title, htmlContent: '<h1>purge v3 body</h1>' });
  return { id, csrf };
}

test('purge clears one non-current version into a tombstone; reads and previews answer 410', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Purge target');

  const res = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.success, true);
  assert.equal(res.json.shareId, id);
  assert.equal(res.json.revision, '1');
  assert.equal(typeof res.json.purgedAt, 'number');

  // The stored snapshot is a tombstone: metadata only, no payload of
  // any kind — no body, title, description, theme or payload hash.
  const tombstone = await repository.getContentSnapshot(id, '1');
  assert.equal(tombstone.html_content, null);
  assert.equal(tombstone.title, null);
  assert.equal(tombstone.description, null);
  assert.equal(tombstone.markdown_theme, null);
  assert.equal(tombstone.snapshot_hash, null);
  assert.equal(tombstone.purged_at, res.json.purgedAt);
  assert.equal(tombstone.source, 'api-create');
  assert.equal(tombstone.revision, '1');

  // The other versions are untouched, and the current content is the
  // third version exactly as before.
  const v2 = await repository.getContentSnapshot(id, '2');
  assert.equal(v2.html_content, '<h1>purge v2 body</h1>');
  assert.equal(v2.snapshot_hash.length, 64);
  const page = await repository.getById(id);
  assert.equal(String(page.current_revision), '3');
  assert.equal(page.html_content, '<h1>purge v3 body</h1>');

  // Reading the purged version's content is 410; neighbors still read.
  const read = await jsonRequest(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 410);
  assert.equal(read.json.code, 'revision_unavailable');
  assert.ok(!read.text.includes('purge v1 body'));

  const readV2 = await jsonRequest(`/admin/pages/${id}/revisions/2`, { headers: { Cookie: cookie } });
  assert.equal(readV2.status, 200);
  assert.equal(readV2.json.revision.htmlContent, '<h1>purge v2 body</h1>');
  assert.equal(readV2.json.revision.purged, false);

  const preview = await request(`/admin/pages/${id}/revisions/1/preview`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 410);
  assert.ok(!preview.text.includes('purge v1 body'));

  const previewV2 = await request(`/admin/pages/${id}/revisions/2/preview`, { headers: { Cookie: cookie } });
  assert.equal(previewV2.status, 200);

  // The history list keeps the tombstone's metadata and flags it.
  const list = await jsonRequest(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const byRevision = new Map(list.json.revisions.map(item => [item.revision, item]));
  assert.equal(byRevision.get('1').purged, true);
  assert.equal(byRevision.get('1').purgedAt, res.json.purgedAt);
  assert.equal(byRevision.get('2').purged, false);
  assert.equal(byRevision.get('3').purged, false);

  // Exactly one purge audit, carrying no content.
  const audits = await purgeAudits(id);
  assert.equal(audits.length, 1);
  assert.deepEqual(JSON.parse(audits[0].details), { revision: '1', purgedAt: res.json.purgedAt });
});

test('the current version can never be purged', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Current stays');

  const res = await purge(cookie, csrf, id, '3', { confirmRevision: '3' });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.code, 'revision_is_current');

  const snapshot = await repository.getContentSnapshot(id, '3');
  assert.equal(snapshot.html_content, '<h1>purge v3 body</h1>');
  assert.equal(snapshot.purged_at, null);
  assert.equal((await purgeAudits(id)).length, 0);
});

test('purge requires the verbatim target confirmation', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Confirm first');

  const missing = await purge(cookie, csrf, id, '1');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'purge_confirmation_required');

  const mismatch = await purge(cookie, csrf, id, '1', { confirmRevision: '2' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.code, 'purge_confirmation_required');

  const snapshot = await repository.getContentSnapshot(id, '1');
  assert.equal(snapshot.html_content, '<h1>purge v1 body</h1>');
  assert.equal(snapshot.purged_at, null);
  assert.equal((await purgeAudits(id)).length, 0);
});

test('purge of unknown shares and versions is 404', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Unknown targets');

  const unknownVersion = await purge(cookie, csrf, id, '99', { confirmRevision: '99' });
  assert.equal(unknownVersion.status, 404);
  assert.equal(unknownVersion.json.code, 'revision_not_found');

  const malformed = await purge(cookie, csrf, id, 'abc', { confirmRevision: 'abc' });
  assert.equal(malformed.status, 404);
  assert.equal(malformed.json.code, 'revision_not_found');

  const unknownShare = await purge(cookie, csrf, 'no-such-share', '1', { confirmRevision: '1' });
  assert.equal(unknownShare.status, 404);
});

test('repeating a purge has no repeated side effects', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Purge twice');

  const first = await purge(cookie, csrf, id, '2', { confirmRevision: '2' });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.alreadyPurged, undefined);

  const second = await purge(cookie, csrf, id, '2', { confirmRevision: '2' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.alreadyPurged, true);
  assert.equal(second.json.purgedAt, first.json.purgedAt);

  // No second audit, and the tombstone did not move.
  assert.equal((await purgeAudits(id)).length, 1);
  const tombstone = await repository.getContentSnapshot(id, '2');
  assert.equal(tombstone.purged_at, first.json.purgedAt);
});

test('purge is dashboard + CSRF only: no session, no key-only path, no missing CSRF', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Owner only');

  const anonymous = await purge(null, null, id, '1', { confirmRevision: '1' });
  assert.equal(anonymous.status, 401);

  // An API Key is not a purge credential: there is no key endpoint.
  const keyOnly = await purge(null, null, id, '1', {
    confirmRevision: '1',
    headers: { 'X-API-Key': 't10-legacy-key' }
  });
  assert.equal(keyOnly.status, 401);

  const noCsrf = await purge(cookie, null, id, '1', { confirmRevision: '1' });
  assert.equal(noCsrf.status, 403);

  const wrongCsrf = await purge(cookie, 'not-the-token', id, '1', { confirmRevision: '1' });
  assert.equal(wrongCsrf.status, 403);

  const snapshot = await repository.getContentSnapshot(id, '1');
  assert.equal(snapshot.html_content, '<h1>purge v1 body</h1>');
  assert.equal((await purgeAudits(id)).length, 0);
  assert.ok(csrf);
});

test('version numbers are never reused after a purge; restore mints forward only', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'No reuse');

  const purged = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
  assert.equal(purged.status, 200, purged.text);

  await legacyEdit(cookie, csrf, id, { title: 'No reuse', htmlContent: '<h1>purge v4 body</h1>' });
  let page = await repository.getById(id);
  assert.equal(String(page.current_revision), '4');

  const restore = await jsonRequest(`/admin/pages/${id}/revisions/2/restore`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': await currentEtag(id) },
    body: {}
  });
  assert.equal(restore.status, 200, restore.text);
  assert.equal(restore.json.contentRevision, '5');
  page = await repository.getById(id);
  assert.equal(page.html_content, '<h1>purge v2 body</h1>');

  const meta = await repository.listContentRevisionMeta(id, { limit: 100, offset: 0 });
  assert.deepEqual(
    meta.revisions.map(item => item.revision).sort(),
    ['1', '2', '3', '4', '5']
  );
});

test('restoring a purged version is refused with 410 revision_unavailable', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'No restore of tombstone');

  const purged = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
  assert.equal(purged.status, 200, purged.text);

  const restore = await jsonRequest(`/admin/pages/${id}/revisions/1/restore`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': await currentEtag(id) },
    body: {}
  });
  assert.equal(restore.status, 410, restore.text);
  assert.equal(restore.json.code, 'revision_unavailable');

  const page = await repository.getById(id);
  assert.equal(String(page.current_revision), '3');
  assert.equal(page.html_content, '<h1>purge v3 body</h1>');
});

test('create replay after its result version is purged returns 410 and leaks nothing', async () => {
  const cookie = await loginDashboard();
  const key = randomUUID();
  const body = {
    htmlContent: '<p>receipt secret body</p>',
    codeType: 'html',
    title: 'Receipt secret title',
    isProtected: true
  };

  const created = await createViaApiKey(body, { idempotencyKey: key });
  const id = created.urlId;
  assert.ok(created.password, 'protected create returns the generated password');
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);

  // Sanity: before the purge, the replay returns the full receipt.
  const before = await createViaApiKey(body, { idempotencyKey: key });
  assert.equal(before.replayed, true);
  assert.equal(before.password, created.password);
  assert.equal(before.title, 'Receipt secret title');

  await legacyEdit(cookie, csrf, id, { title: 'After', htmlContent: '<p>second version</p>' });
  const purged = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
  assert.equal(purged.status, 200, purged.text);

  const sharesBefore = await repository.countPages({});
  const replay = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': 't10-legacy-key', 'Idempotency-Key': key },
    body
  });
  assert.equal(replay.status, 410, replay.text);
  assert.equal(replay.json.code, 'operation_result_unavailable');
  assert.ok(!replay.text.includes(created.password));
  assert.ok(!replay.text.includes('Receipt secret title'));
  assert.ok(!replay.text.includes('receipt secret body'));
  assert.equal(await repository.countPages({}), sharesBefore);

  // The operation itself stays confirmable — by identifiers only.
  const status = await jsonRequest(`/api/v1/operations/${key}`, {
    headers: { 'X-API-Key': 't10-legacy-key' }
  });
  assert.equal(status.status, 200);
  assert.equal(status.json.status, 'committed');
  assert.equal(status.json.shareId, id);
  assert.equal(status.json.contentRevision, '1');
  assert.ok(!status.text.includes(created.password));
  assert.ok(!status.text.includes('Receipt secret title'));
});

test('save replay after its result version is purged returns 410 instead of the old receipt', async () => {
  const cookie = await loginDashboard();
  const created = await createViaApiKey({
    htmlContent: '<p>save v1</p>', codeType: 'html', title: 'Save purge replay'
  });
  const id = created.urlId;
  const csrf = await dashboardCsrf(cookie, `/admin/pages/${id}`);
  const key = randomUUID();

  const saved = await jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': etagFor(id, '1'), 'Idempotency-Key': key },
    body: { title: 'Save purge replay v2 title', htmlContent: '<p>save v2 secret</p>' }
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.page.currentRevision, '2');

  await legacyEdit(cookie, csrf, id, { title: 'Save purge replay', htmlContent: '<p>save v3</p>' });

  const purged = await purge(cookie, csrf, id, '2', { confirmRevision: '2' });
  assert.equal(purged.status, 200, purged.text);

  const replay = await jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': etagFor(id, '1'), 'Idempotency-Key': key },
    body: { title: 'Save purge replay v2 title', htmlContent: '<p>save v2 secret</p>' }
  });
  assert.equal(replay.status, 410, replay.text);
  assert.equal(replay.json.code, 'operation_result_unavailable');
  assert.ok(!replay.text.includes('save v2 secret'));

  // Current content is still version 3; nothing was resurrected.
  const page = await repository.getById(id);
  assert.equal(String(page.current_revision), '3');
  assert.equal(page.html_content, '<p>save v3</p>');
});

test('purge passes the publishing maintenance gate like every other write', async () => {
  const cookie = await loginDashboard();
  const { id, csrf } = await threeRevisionShare(cookie, 'Paused purge');

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });
  try {
    const res = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.code, 'maintenance');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  const snapshot = await repository.getContentSnapshot(id, '1');
  assert.equal(snapshot.html_content, '<h1>purge v1 body</h1>');

  const after = await purge(cookie, csrf, id, '1', { confirmRevision: '1' });
  assert.equal(after.status, 200, after.text);
});

test('detail page carries the purge panel with honest scope copy, and the client wires confirmRevision', async () => {
  const cookie = await loginDashboard();
  const { id } = await threeRevisionShare(cookie, 'Purge shell');

  const detail = await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } });
  assert.equal(detail.status, 200);
  assert.ok(detail.text.includes('id="history-purge"'));
  assert.ok(detail.text.includes('id="history-purge-confirm-input"'));
  assert.ok(detail.text.includes('id="history-purge-confirm"'));
  // The copy must not overpromise: it names what is NOT covered.
  assert.ok(detail.text.includes('不可恢复'));
  assert.ok(detail.text.includes('离线备份'));
  assert.ok(detail.text.includes('已经下载的副本不在清除范围内'));

  const script = await request('/js/admin-history.js');
  assert.equal(script.status, 200);
  assert.ok(script.text.includes('/purge'));
  assert.ok(script.text.includes('confirmRevision'));
});
