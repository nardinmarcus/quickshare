const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Unpublish / republish (T11, issue #35): the dashboard publish-state
// operation rides the T01 access-version precondition family and the
// T08/T09 operation protocol. While a Share is unpublished every public
// surface answers exactly like a nonexistent Share (404, judged before
// expiry), a real transition advances access_revision so old unlock
// cookies never revive, and setting the current state is a recorded
// unchanged success that advances nothing.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 't11-auth-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 't11-dashboard-password';
process.env.SHARE_API_KEY = 't11-legacy-key';
process.env.SESSION_SECRET = 't11-session-secret';
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
    body: 'password=t11-dashboard-password'
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

async function seedPage({ id, password = null, expiresAt = null }) {
  await repository.create({
    id,
    htmlContent: `<h1>secret-body-${id}</h1>`,
    createdAt: Date.now(),
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

function viewEvent(id, cookie) {
  return request(`/view/${id}/view-event`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      ...(cookie ? { Cookie: cookie } : {})
    }
  });
}

async function publishState(cookie, csrf, id, { published, expectedAccessRevision, key, bodyRequestId, headers = {} } = {}) {
  return jsonRequest(`/admin/pages/${id}/publish-state`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...headers
    },
    body: {
      published,
      ...(expectedAccessRevision !== undefined ? { expectedAccessRevision } : {}),
      ...(bodyRequestId ? { requestId: bodyRequestId } : {})
    }
  });
}

async function operationStatus(cookie, requestId) {
  return jsonRequest(`/admin/operations/${requestId}`, {
    headers: { Cookie: cookie }
  });
}

async function publishAuditCount(id) {
  const logs = await repository.listAuditLogs({ limit: 200 });
  return logs.filter(log => log.action === 'page.publish.update' && log.pageId === id).length;
}

function etagFor(id, revision) {
  return `"content:${id}:${revision}"`;
}

test('unpublish: every public surface answers 404, ahead of expiry and access', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-surfaces', password: 'First1!' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-surfaces');
  const accessCookie = await unlock('t11-surfaces', 'First1!');

  // Baseline: the unlocked Share serves and counts.
  assert.equal((await request('/view/t11-surfaces', { headers: { Cookie: accessCookie } })).status, 200);
  assert.equal((await viewEvent('t11-surfaces', accessCookie)).status, 204);
  const before = await repository.getById('t11-surfaces');
  assert.equal(before.view_count, 1);

  const res = await publishState(cookie, csrf, 't11-surfaces', {
    published: false,
    expectedAccessRevision: '1',
    key: randomUUID()
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.success, true);
  assert.equal(res.json.action, 'share.unpublish');
  assert.equal(res.json.published, false);
  assert.equal(res.json.changed, true);
  assert.equal(res.json.unchanged, false);
  assert.equal(res.json.accessRevision, '2');

  // The view page: 404 with the still-current cookie and without one,
  // byte-for-byte the same outcome class as a nonexistent Share.
  assert.equal((await request('/view/t11-surfaces', { headers: { Cookie: accessCookie } })).status, 404);
  assert.equal((await request('/view/t11-surfaces')).status, 404);
  assert.equal((await request('/view/t11-no-such-page')).status, 404);

  // The metadata endpoint: 404 with the nonexistent body — no neutral
  // projection, no real title, no revision counters.
  const meta = await jsonRequest('/api/pages/t11-surfaces', { headers: { Cookie: accessCookie } });
  assert.equal(meta.status, 404);
  assert.equal(meta.json.error, '页面不存在');
  assert.equal(meta.text.includes('title-t11-surfaces'), false);

  // No new unlock credential can be minted while unpublished.
  const passwordAttempt = await jsonRequest('/view/t11-surfaces/password', {
    method: 'POST',
    body: { password: 'First1!' }
  });
  assert.equal(passwordAttempt.status, 404);
  assert.equal(passwordAttempt.json.valid, false);
  assert.equal(passwordAttempt.headers['set-cookie'], undefined);

  // View events are not counted and answer 404.
  assert.equal((await viewEvent('t11-surfaces', accessCookie)).status, 404);
  const after = await repository.getById('t11-surfaces');
  assert.equal(after.view_count, 1);
  assert.equal(after.published, false);
});

test('unpublished + expired answers 404, published + expired stays 410', async () => {
  const cookie = await loginDashboard();
  const past = Date.now() - 60000;
  await seedPage({ id: 't11-down-expired', expiresAt: past });
  await seedPage({ id: 't11-live-expired', expiresAt: past });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-down-expired');

  const res = await publishState(cookie, csrf, 't11-down-expired', {
    published: false,
    expectedAccessRevision: '1'
  });
  assert.equal(res.status, 200, res.text);

  assert.equal((await request('/view/t11-down-expired')).status, 404);
  assert.equal((await jsonRequest('/api/pages/t11-down-expired')).status, 404);
  const passwordAttempt = await jsonRequest('/view/t11-down-expired/password', {
    method: 'POST',
    body: { password: 'whatever' }
  });
  assert.equal(passwordAttempt.status, 404);

  assert.equal((await request('/view/t11-live-expired')).status, 410);
  assert.equal((await jsonRequest('/api/pages/t11-live-expired')).status, 410);
});

test('republish resumes the same URL; old cookies never revive; policy untouched', async () => {
  const cookie = await loginDashboard();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  await seedPage({ id: 't11-resume', password: 'First1!', expiresAt });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-resume');
  const oldCookie = await unlock('t11-resume', 'First1!');

  const down = await publishState(cookie, csrf, 't11-resume', {
    published: false,
    expectedAccessRevision: '1',
    key: randomUUID()
  });
  assert.equal(down.status, 200, down.text);
  assert.equal(down.json.accessRevision, '2');

  const up = await publishState(cookie, csrf, 't11-resume', {
    published: true,
    expectedAccessRevision: '2',
    key: randomUUID()
  });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.action, 'share.republish');
  assert.equal(up.json.published, true);
  assert.equal(up.json.accessRevision, '3');

  // The pre-unpublish cookie stays dead after republish: the view falls
  // back to the password page and the metadata to the neutral projection.
  const staleView = await request('/view/t11-resume', { headers: { Cookie: oldCookie } });
  assert.equal(staleView.status, 200);
  assert.equal(staleView.text.includes('secret-body-t11-resume'), false);
  const staleMeta = await jsonRequest('/api/pages/t11-resume', { headers: { Cookie: oldCookie } });
  assert.equal(staleMeta.status, 200);
  assert.equal(staleMeta.json.page.title, '受保护内容');
  assert.equal((await viewEvent('t11-resume', oldCookie)).status, 403);

  // The same password unlocks again on the same URL.
  const freshCookie = await unlock('t11-resume', 'First1!');
  const freshView = await request('/view/t11-resume', { headers: { Cookie: freshCookie } });
  assert.equal(freshView.status, 200);
  assert.equal(freshView.text.includes('secret-body-t11-resume'), true);
  assert.equal((await viewEvent('t11-resume', freshCookie)).status, 204);

  // Password, expiry and content version were never touched.
  const page = await repository.getById('t11-resume');
  assert.equal(page.is_protected, 1);
  assert.equal(Number(page.expires_at), expiresAt);
  assert.equal(String(page.current_revision), '1');
  assert.equal(String(page.access_revision), '3');
  assert.equal(page.published, true);
});

test('setting the current state returns unchanged, records the operation, advances nothing', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-unchanged' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-unchanged');
  const key = randomUUID();

  const res = await publishState(cookie, csrf, 't11-unchanged', {
    published: true,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.success, true);
  assert.equal(res.json.changed, false);
  assert.equal(res.json.unchanged, true);
  assert.equal(res.json.accessRevision, '1');

  const page = await repository.getById('t11-unchanged');
  assert.equal(String(page.access_revision), '1');
  assert.equal(await publishAuditCount('t11-unchanged'), 0);

  // The unchanged result is still a committed, confirmable operation.
  const status = await operationStatus(cookie, key);
  assert.equal(status.status, 200);
  assert.equal(status.json.action, 'share.republish');
  assert.equal(status.json.status, 'committed');
  assert.equal(status.json.shareId, 't11-unchanged');
  assert.equal(status.json.accessRevision, '1');

  // And it replays as the recorded result.
  const replay = await publishState(cookie, csrf, 't11-unchanged', {
    published: true,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.changed, false);
  assert.equal(replay.json.accessRevision, '1');
});

test('replay resolves the recorded result before the stale precondition; different input conflicts', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-replay', password: 'First1!' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-replay');
  const key = randomUUID();

  const first = await publishState(cookie, csrf, 't11-replay', {
    published: false,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.accessRevision, '2');
  assert.equal(await publishAuditCount('t11-replay'), 1);

  // The retry's expectedAccessRevision (1) is now stale, but the
  // committed operation resolves first: the recorded result replays
  // instead of a 412, and no second transition or audit happens.
  const replay = await publishState(cookie, csrf, 't11-replay', {
    published: false,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.published, false);
  assert.equal(replay.json.changed, true);
  assert.equal(replay.json.accessRevision, '2');
  assert.equal(await publishAuditCount('t11-replay'), 1);
  assert.equal(String((await repository.getById('t11-replay')).access_revision), '2');

  // The body-carried requestId replays identically.
  const bodyReplay = await publishState(cookie, csrf, 't11-replay', {
    published: false,
    expectedAccessRevision: '1',
    bodyRequestId: key
  });
  assert.equal(bodyReplay.status, 200, bodyReplay.text);
  assert.equal(bodyReplay.json.replayed, true);

  // Same identifier, different target state or different precondition:
  // a different request — 409.
  const differentState = await publishState(cookie, csrf, 't11-replay', {
    published: true,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(differentState.status, 409);
  assert.equal(differentState.json.code, 'idempotency_conflict');

  const differentPrecondition = await publishState(cookie, csrf, 't11-replay', {
    published: false,
    expectedAccessRevision: '2',
    key
  });
  assert.equal(differentPrecondition.status, 409);
  assert.equal(differentPrecondition.json.code, 'idempotency_conflict');
});

test('precondition family: missing 428, invalid 400, stale 412; failures record nothing', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-preconditions' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-preconditions');
  const key = randomUUID();

  const missing = await publishState(cookie, csrf, 't11-preconditions', {
    published: false,
    key
  });
  assert.equal(missing.status, 428);

  // The failed attempt consumed nothing: the same identifier with a
  // proper precondition executes as a first attempt, not a replay.
  const executed = await publishState(cookie, csrf, 't11-preconditions', {
    published: false,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.json.replayed, undefined);
  assert.equal(executed.json.changed, true);

  const invalid = await publishState(cookie, csrf, 't11-preconditions', {
    published: true,
    expectedAccessRevision: 'not-a-number'
  });
  assert.equal(invalid.status, 400);

  const stale = await publishState(cookie, csrf, 't11-preconditions', {
    published: true,
    expectedAccessRevision: '99'
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.accessRevision, '2');

  const badKey = await publishState(cookie, csrf, 't11-preconditions', {
    published: true,
    expectedAccessRevision: '2',
    key: 'short'
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.code, 'invalid_idempotency_key');

  const badState = await publishState(cookie, csrf, 't11-preconditions', {
    published: 'yes',
    expectedAccessRevision: '2'
  });
  assert.equal(badState.status, 400);

  const missingShare = await publishState(cookie, csrf, 't11-no-such-share', {
    published: false,
    expectedAccessRevision: '1'
  });
  assert.equal(missingShare.status, 404);
});

test('audit: exactly one page.publish.update per real transition', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-audit' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-audit');

  await publishState(cookie, csrf, 't11-audit', { published: false, expectedAccessRevision: '1' });
  assert.equal(await publishAuditCount('t11-audit'), 1);

  // A repeated unpublish against the new baseline is unchanged: no
  // second audit, no further version advance.
  const again = await publishState(cookie, csrf, 't11-audit', { published: false, expectedAccessRevision: '2' });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.unchanged, true);
  assert.equal(await publishAuditCount('t11-audit'), 1);
  assert.equal(String((await repository.getById('t11-audit')).access_revision), '2');

  await publishState(cookie, csrf, 't11-audit', { published: true, expectedAccessRevision: '2' });
  assert.equal(await publishAuditCount('t11-audit'), 2);
});

test('boundaries: dashboard session and CSRF required; API keys cannot unpublish', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-boundaries' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-boundaries');

  const anonymous = await jsonRequest('/admin/pages/t11-boundaries/publish-state', {
    method: 'POST',
    body: { published: false, expectedAccessRevision: '1' }
  });
  assert.equal(anonymous.status, 401);

  const apiKeyAttempt = await jsonRequest('/admin/pages/t11-boundaries/publish-state', {
    method: 'POST',
    headers: { 'X-API-Key': 't11-legacy-key', 'X-CSRF-Token': csrf },
    body: { published: false, expectedAccessRevision: '1' }
  });
  assert.equal(apiKeyAttempt.status, 401);

  const noCsrf = await jsonRequest('/admin/pages/t11-boundaries/publish-state', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: { published: false, expectedAccessRevision: '1' }
  });
  assert.equal(noCsrf.status, 403);

  const page = await repository.getById('t11-boundaries');
  assert.equal(page.published, true);
  assert.equal(String(page.access_revision), '1');
});

test('write maintenance refuses transitions and replays with 503; the operation stays confirmable', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-maintenance' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-maintenance');
  const key = randomUUID();

  const down = await publishState(cookie, csrf, 't11-maintenance', {
    published: false,
    expectedAccessRevision: '1',
    key
  });
  assert.equal(down.status, 200, down.text);

  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const fresh = await publishState(cookie, csrf, 't11-maintenance', {
      published: true,
      expectedAccessRevision: '2',
      key: randomUUID()
    });
    assert.equal(fresh.status, 503);
    assert.equal(fresh.json.code, 'maintenance');

    const replay = await publishState(cookie, csrf, 't11-maintenance', {
      published: false,
      expectedAccessRevision: '1',
      key
    });
    assert.equal(replay.status, 503);

    const status = await operationStatus(cookie, key);
    assert.equal(status.status, 200);
    assert.equal(status.json.action, 'share.unpublish');
    assert.equal(status.json.status, 'committed');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }

  const page = await repository.getById('t11-maintenance');
  assert.equal(page.published, false);
  assert.equal(String(page.access_revision), '2');
});

test('admin keeps full control of an unpublished Share: detail, list, edit, restore, favorite', async () => {
  const cookie = await loginDashboard();
  await seedPage({ id: 't11-manage', password: 'First1!' });
  const csrf = await dashboardCsrf(cookie, '/admin/pages/t11-manage');

  // Build a second Revision while published.
  const save = await jsonRequest('/admin/pages/t11-manage', {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': etagFor('t11-manage', '1')
    },
    body: { title: 'title-t11-manage', htmlContent: '<h1>v2-body</h1>' }
  });
  assert.equal(save.status, 200, save.text);
  assert.equal(save.json.page.currentRevision, '2');

  const down = await publishState(cookie, csrf, 't11-manage', {
    published: false,
    expectedAccessRevision: '1'
  });
  assert.equal(down.status, 200, down.text);

  // The detail page renders, shows the unpublished state and the toggle.
  const detail = await request('/admin/pages/t11-manage', { headers: { Cookie: cookie } });
  assert.equal(detail.status, 200);
  assert.equal(detail.text.includes('已下架'), true);
  assert.equal(detail.text.includes('publish-toggle-btn'), true);
  assert.equal(detail.text.includes('重新发布'), true);

  // The list shows the state and carries the toggle with its baseline.
  const list = await request('/admin/pages', { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.text.includes('data-publish-toggle'), true);
  assert.equal(list.text.includes('data-published="false"'), true);

  // Editing content still works and does not republish.
  const edit = await jsonRequest('/admin/pages/t11-manage', {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': etagFor('t11-manage', '2')
    },
    body: { title: 'title-t11-manage', htmlContent: '<h1>v3-body</h1>' }
  });
  assert.equal(edit.status, 200, edit.text);
  assert.equal(edit.json.page.currentRevision, '3');
  assert.equal(edit.json.page.published, false);

  // Restoring history still works and does not republish.
  const restore = await jsonRequest('/admin/pages/t11-manage/revisions/1/restore', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': etagFor('t11-manage', '3')
    },
    body: {}
  });
  assert.equal(restore.status, 200, restore.text);
  assert.equal(restore.json.contentRevision, '4');

  // Favorite semantics are untouched by publish state.
  const favorite = await jsonRequest('/admin/pages/t11-manage/favorite', {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: { isFavorite: true }
  });
  assert.equal(favorite.status, 200, favorite.text);

  const page = await repository.getById('t11-manage');
  assert.equal(page.published, false);
  assert.equal(page.is_favorite, true);
  assert.equal(page.html_content, '<h1>secret-body-t11-manage</h1>');
  assert.equal((await request('/view/t11-manage')).status, 404);
});
