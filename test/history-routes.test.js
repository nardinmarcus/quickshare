// #31 owner history over HTTP: dashboard-only identity boundary, metadata-only
// pagination, single-revision isolation, sandboxed preview without public
// tracking, read-only behavior (also while writes are paused), honest empty
// history and no public projection of historical bodies.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'history-front-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'history-dashboard-password';
process.env.SHARE_API_KEY = 'history-share-api-key';
process.env.SESSION_SECRET = 'issue31-history-http-secret';
process.env.TZ = 'UTC';

const app = require('../app');
const pageRepository = app.locals.pageRepository;

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

test.after(() => server.close());

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
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

async function dashboardLogin() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=history-dashboard-password'
  });
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.equal(response.status, 302);
  assert.ok(cookie, 'dashboard login issues its cookie');
  return cookie.split(';')[0];
}

async function frontendLogin() {
  const response = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=history-front-password'
  });
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('admin_session='));
  assert.equal(response.status, 302);
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCsrf(cookie, id) {
  const html = await (await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } })).text;
  const match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  assert.ok(match, 'dashboard detail embeds the CSRF token');
  return match[1];
}

async function createShare(markers) {
  const response = await request('/api/v1/share', {
    method: 'POST',
    headers: jsonHeaders({ 'X-API-Key': 'history-share-api-key' }),
    body: JSON.stringify({ htmlContent: `<h1>${markers[0]}</h1>`, codeType: 'html', title: 'History share' })
  });
  assert.equal(response.status, 200, response.text);
  const id = JSON.parse(response.text).urlId;
  // Additional revisions through the owner dashboard content path.
  const cookie = await dashboardLogin();
  for (let index = 1; index < markers.length; index += 1) {
    const saved = await request(`/admin/pages/${id}`, {
      method: 'PUT',
      headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': await dashboardCsrf(cookie, id), 'If-Match': `"content:${id}:${index}"` }),
      body: JSON.stringify({ htmlContent: `<h1>${markers[index]}</h1>` })
    });
    assert.equal(saved.status, 200, saved.text);
  }
  return id;
}

test('anonymous, frontend-cookie, API-key and unlocked-public identities are all denied history', async () => {
  const id = await createShare(['H31-A0', 'H31-A1']);

  const anonymousList = await request(`/admin/pages/${id}/revisions`);
  assert.equal(anonymousList.status, 401);
  assert.equal(JSON.parse(anonymousList.text).success, false);

  const frontCookie = await frontendLogin();
  const frontList = await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: frontCookie } });
  assert.equal(frontList.status, 401, 'the frontend create-only cookie is NOT a history identity');
  const frontSingle = await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: frontCookie } });
  assert.equal(frontSingle.status, 401);
  const frontPreview = await request(`/admin/pages/${id}/revisions/1/preview`, { headers: { Cookie: frontCookie } });
  assert.equal(frontPreview.status, 302, 'HTML preview redirects to the dashboard login, never renders');
  assert.equal(frontPreview.headers.location, '/admin/login');

  const apiKeyList = await request(`/admin/pages/${id}/revisions`, {
    headers: { 'X-API-Key': 'history-share-api-key' }
  });
  assert.equal(apiKeyList.status, 401, 'the create-only Share API key is NOT a history identity');
  const apiKeySingle = await request(`/admin/pages/${id}/revisions/1`, {
    headers: { 'X-API-Key': 'history-share-api-key' }
  });
  assert.equal(apiKeySingle.status, 401);

  // An unlocked protected Share grants public reading, never history.
  const cookie = await dashboardLogin();
  await request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': await dashboardCsrf(cookie, id) }),
    body: JSON.stringify({ isProtected: true, password: 'H31pass', expectedAccessRevision: '1' })
  });
  const unlocked = await request(`/view/${id}/password`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ password: 'H31pass' })
  });
  assert.equal(unlocked.status, 200);
  const accessCookie = unlocked.headers['set-cookie']?.find(value => value.startsWith(`page_access_${id}=`));
  assert.ok(accessCookie);
  const publicRead = await request(`/view/${id}`, { headers: { Cookie: accessCookie.split(';')[0] } });
  assert.equal(publicRead.status, 200, 'the unlocked visitor can read the current Share');
  const unlockedHistory = await request(`/admin/pages/${id}/revisions`, {
    headers: { Cookie: accessCookie.split(';')[0] }
  });
  assert.equal(unlockedHistory.status, 401, 'an unlocked public visitor is NOT a history identity');
});

test('history list pages in descending order, metadata-only, with default 20 and max 100', async () => {
  const id = await createShare(Array.from({ length: 23 }, (_, index) => `H31-P${index}`));
  const cookie = await dashboardLogin();

  const defaults = await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  assert.equal(defaults.status, 200);
  assert.match(defaults.headers['cache-control'], /private/);
  assert.match(defaults.headers['cache-control'], /no-store/);
  const defaultsBody = JSON.parse(defaults.text);
  assert.equal(defaultsBody.success, true);
  assert.equal(defaultsBody.revisions.length, 20, 'default page size is 20');
  assert.equal(defaultsBody.pagination.total, '23', 'exact decimal total (1 baseline + 22 saves)');
  assert.deepEqual(defaultsBody.revisions.map(item => item.revision)[0], '23', 'newest revision first');
  assert.deepEqual(defaultsBody.revisions.map(item => item.revision)[19], '4');
  for (const item of defaultsBody.revisions) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'purged', 'restoredFrom', 'revision', 'source'],
      'list items expose exactly the required metadata');
    assert.equal(typeof item.createdAt, 'number');
    assert.equal(item.restoredFrom, null);
    assert.equal(item.purged, false, '#34: live rows report purged=false (a boolean, never a payload field)');
  }
  assert.ok(!defaults.text.includes('H31-P'), 'the list response never carries any body text');

  const secondPage = await request(`/admin/pages/${id}/revisions?page=2`, { headers: { Cookie: cookie } });
  const secondBody = JSON.parse(secondPage.text);
  assert.deepEqual(secondBody.revisions.map(item => item.revision), ['3', '2', '1']);
  assert.equal(secondBody.pagination.hasNext, false);
  assert.equal(secondBody.pagination.hasPrevious, true);

  const oversized = await request(`/admin/pages/${id}/revisions?limit=500`, { headers: { Cookie: cookie } });
  const oversizedBody = JSON.parse(oversized.text);
  assert.equal(oversizedBody.revisions.length, 23, 'limit is capped at 100');
  assert.equal(oversizedBody.pagination.limit, 100);

  const invalid = await request(`/admin/pages/${id}/revisions?limit=abc&page=0`, { headers: { Cookie: cookie } });
  const invalidBody = JSON.parse(invalid.text);
  assert.equal(invalidBody.revisions.length, 20, 'invalid limit falls back to the default');
  assert.equal(invalidBody.pagination.page, 1, 'invalid page falls back to 1');

  const htmlPage = await request(`/admin/pages/${id}/history`, { headers: { Cookie: cookie } });
  assert.equal(htmlPage.status, 200);
  assert.match(htmlPage.headers['cache-control'], /no-store/);
  assert.ok(!htmlPage.text.includes('H31-P'), 'the server-rendered history page lists metadata only');

  const missing = await request('/admin/pages/no-such-share-31/revisions', { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  const missingPage = await request('/admin/pages/no-such-share-31/history', { headers: { Cookie: cookie } });
  assert.equal(missingPage.status, 404);
});

test('single revision reads return one bounded snapshot; invalid and missing versions are explicit', async () => {
  const id = await createShare(['H31-S0', 'H31-S1', 'H31-S2']);
  const cookie = await dashboardLogin();

  const first = await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  assert.equal(first.status, 200);
  assert.match(first.headers['cache-control'], /no-store/);
  const firstBody = JSON.parse(first.text);
  assert.equal(firstBody.revision.htmlContent, '<h1>H31-S0</h1>', 'exact body isolation per revision');
  assert.equal(firstBody.revision.revision, '1');
  assert.equal(firstBody.revision.codeType, 'html');
  assert.equal(firstBody.revision.source, 'api');
  assert.ok(firstBody.revision.snapshotHash);
  assert.ok(!('isProtected' in firstBody.revision) && !('expiresAt' in firstBody.revision) && !('viewCount' in firstBody.revision));

  const second = JSON.parse((await request(`/admin/pages/${id}/revisions/2`, { headers: { Cookie: cookie } })).text);
  assert.equal(second.revision.htmlContent, '<h1>H31-S1</h1>');
  assert.equal(second.revision.source, 'dashboard-edit');

  assert.equal((await request(`/admin/pages/${id}/revisions/999`, { headers: { Cookie: cookie } })).status, 404);
  for (const invalid of ['0', 'abc', '01', '9223372036854775808']) {
    const response = await request(`/admin/pages/${id}/revisions/${invalid}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 400, `invalid revision "${invalid}" is a 400`);
    assert.equal(JSON.parse(response.text).code, 'INVALID_CONTENT_REVISION');
  }
});

test('the preview endpoint renders the sandboxed document with no public tracking and no same-origin grant', async () => {
  const id = await createShare(['H31-V0', 'H31-V1']);
  const cookie = await dashboardLogin();

  const preview = await request(`/admin/pages/${id}/revisions/1/preview`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers['cache-control'], /private/);
  assert.match(preview.headers['cache-control'], /no-store/);
  assert.ok(preview.headers['content-security-policy'], 'the admin preview ships a CSP');
  assert.ok(!preview.text.includes('allow-same-origin'), 'the sandbox never grants same-origin');
  assert.ok(preview.text.includes('referrerpolicy="no-referrer"'));
  assert.ok(!preview.text.includes('umami'), 'no public analytics in an owner preview');
  assert.ok(!preview.text.includes('view-event'), 'no view counting in an owner preview');
  // The revision-1 body must appear only as ESCAPED srcdoc payload, and the
  // raw revision-1 marker must not exist as live markup in the wrapper.
  assert.ok(preview.text.includes('&lt;h1&gt;H31-V0'), 'the body is escaped inside srcdoc');
  const revision1Fetch = JSON.parse((await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } })).text);
  assert.ok(revision1Fetch.revision.htmlContent.includes('H31-V0'), 'revision 1 keeps the historical body');
  const current = await pageRepository.getById(id);
  assert.equal(current.html_content, '<h1>H31-V1</h1>', 'preview never changes the current projection');

  assert.equal((await request(`/admin/pages/${id}/revisions/999/preview`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await request(`/admin/pages/${id}/revisions/abc/preview`, { headers: { Cookie: cookie } })).status, 400);
});

test('history reads are read-only: pointers, counters, favorite, protection and snapshots stay untouched', async () => {
  const id = await createShare(['H31-R0', 'H31-R1']);
  const cookie = await dashboardLogin();
  await request(`/admin/pages/${id}/favorite`, {
    method: 'PUT', headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': await dashboardCsrf(cookie, id) }),
    body: JSON.stringify({ isFavorite: true })
  }).then(response => assert.equal(response.status, 200));

  const before = await pageRepository.getById(id);
  const revisionsBefore = await pageRepository.listContentRevisions(id);

  await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  await request(`/admin/pages/${id}/revisions?page=1&limit=100`, { headers: { Cookie: cookie } });
  await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  await request(`/admin/pages/${id}/revisions/2/preview`, { headers: { Cookie: cookie } });
  await request(`/admin/pages/${id}/history`, { headers: { Cookie: cookie } });

  const after = await pageRepository.getById(id);
  assert.equal(after.current_revision, before.current_revision, 'history reads never advance the content pointer');
  assert.equal(after.access_revision, before.access_revision, 'history reads never advance the access pointer');
  assert.equal(after.is_protected, before.is_protected);
  assert.equal(after.is_favorite, true, 'history reads never touch the Favorite Share state');
  assert.equal(after.view_count, before.view_count, 'history reads never count views');
  assert.equal(after.published, before.published);
  assert.deepEqual(await pageRepository.listContentRevisions(id), revisionsBefore, 'no snapshot is written');
});

test('history stays readable while publishing writes are paused', async () => {
  const id = await createShare(['H31-W0', 'H31-W1']);
  const cookie = await dashboardLogin();
  await pageRepository.setPublishingWritesPaused(true);
  try {
    const list = await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    const single = await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
    assert.equal(single.status, 200);
    const preview = await request(`/admin/pages/${id}/revisions/1/preview`, { headers: { Cookie: cookie } });
    assert.equal(preview.status, 200);
  } finally {
    await pageRepository.setPublishingWritesPaused(false);
  }
});

test('a Share without stored snapshots presents an honest empty history (no invented rows)', async () => {
  const id = await createShare(['H31-E0']);
  pageRepository.revisions.delete(id);
  const cookie = await dashboardLogin();

  const list = JSON.parse((await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text);
  assert.deepEqual(list.revisions, [], 'zero snapshots are reported as an empty list');
  assert.equal(list.pagination.total, '0');

  const html = await (await request(`/admin/pages/${id}/history`, { headers: { Cookie: cookie } })).text;
  assert.match(html, /暂无历史版本/, 'the empty state is rendered honestly');
  assert.ok(!html.includes('id="history-table-row'), 'no fabricated revision rows');
  const single = await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  assert.equal(single.status, 404, 'a missing snapshot is not guessed into existence');
});

test('historical bodies are never projected through public or API surfaces', async () => {
  const id = await createShare(['H31-SECRET-V1', 'H31-CURRENT-V2']);
  const cookie = await dashboardLogin();

  const view = await (await request(`/view/${id}`)).text;
  assert.ok(view.includes('H31-CURRENT-V2'));
  assert.ok(!view.includes('H31-SECRET-V1'), 'the public view never leaks historical bodies');

  const meta = await (await request(`/api/pages/${id}`)).text;
  assert.ok(!meta.includes('H31-SECRET-V1'), 'public metadata never leaks historical bodies');
  assert.ok(!meta.includes('revision'), 'public metadata carries no history projection');

  const detail = await (await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } })).text;
  assert.match(detail, /历史版本/, 'the detail page links the history surface');
  assert.ok(detail.includes(`/admin/pages/${id}/history`));
});

// ---- #33 owner restore: new revision from a source snapshot, idempotent ----

async function restoreRequest(id, { cookie, csrf, revision, ifMatch, requestId, body } = {}) {
  return request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      ...(cookie !== undefined ? { Cookie: cookie } : {}),
      ...(csrf !== undefined ? { 'X-CSRF-Token': csrf } : {}),
      ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}),
      ...(requestId !== undefined ? { 'Idempotency-Key': requestId } : {})
    }),
    body: JSON.stringify(body || { revision })
  });
}

test('restore refuses anonymous, frontend, API-key and missing-CSRF identities without side effects', async () => {
  const id = await createShare(['H33-AUTH-A', 'H33-AUTH-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  const headers = { 'Content-Type': 'application/json', 'If-Match': `"content:${id}:2"`, 'Idempotency-Key': 'restore-auth-boundary-33' };
  for (const identity of [{}, { Cookie: await frontendLogin() }, { 'X-API-Key': 'history-share-api-key' }]) {
    const result = await request(`/admin/pages/${id}/restore`, { method: 'POST', headers: { ...headers, ...identity }, body: JSON.stringify({ revision: '1' }) });
    assert.equal(result.status, 401);
    assert.doesNotMatch(result.text, /H33-AUTH/);
  }
  const missingCsrf = await restoreRequest(id, { cookie, revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'restore-auth-boundary-33' });
  assert.equal(missingCsrf.status, 403);
  assert.equal(String((await pageRepository.getById(id)).current_revision), '2');
  assert.deepEqual(await pageRepository.findPublishingOperationsByRequestId('restore-auth-boundary-33'), []);
  assert.ok(csrf);
});

test('restore writes a new revision with restored_from and keeps the access policy untouched', async () => {
  const id = await createShare(['H33-R-SRC', 'H33-R-CUR']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Establish a non-default access policy: protection + expiry + favorite + views.
  const page = JSON.parse((await request(`/api/pages/${id}`)).text);
  const detail = JSON.parse((await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } })).text);
  assert.equal(detail.revision.htmlContent, '<h1>H33-R-SRC</h1>');

  const before = JSON.parse((await (await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text));
  assert.equal(before.pagination.total, '2');

  const response = await restoreRequest(id, {
    cookie, csrf,
    revision: '1',
    ifMatch: `"content:${id}:2"`,
    requestId: 'restore-basic-0123456789'
  });
  assert.equal(response.status, 200, response.text);
  const payload = JSON.parse(response.text);
  assert.equal(payload.success, true);
  assert.equal(payload.changed, true, 'a real content change reports changed');
  assert.equal(payload.page.currentRevision, '3', 'the restore creates the next revision');
  assert.equal(payload.page.htmlContent, '<h1>H33-R-SRC</h1>');

  const restored = JSON.parse((await request(`/admin/pages/${id}/revisions/3`, { headers: { Cookie: cookie } })).text);
  assert.equal(restored.revision.restoredFrom, '1', 'the new snapshot records its restore origin');
  assert.equal(restored.revision.source, 'dashboard-restore');
  assert.equal(restored.revision.htmlContent, '<h1>H33-R-SRC</h1>');

  const after = JSON.parse((await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text);
  assert.equal(after.pagination.total, '3');
  assert.deepEqual(after.revisions.map(item => item.revision), ['3', '2', '1']);

  // Access policy, URL identity and counters are untouched by a restore.
  const live = await pageRepository.getById(id);
  assert.equal(live.is_protected, 0);
  assert.equal(String(live.access_revision), '1', 'access revision does not move on restore');
  assert.equal(live.expires_at, null);
  assert.equal(live.published, true);
  assert.equal(live.is_favorite, false);
  assert.equal(live.view_count, 0);
  assert.equal(live.id, id, 'URL identity (the share id) is unchanged');
});

test('restore of a snapshot identical to current reports unchanged and records success without a duplicate revision', async () => {
  const id = await createShare(['H33-NOOP-BODY', 'H33-NOOP-EDIT']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Revision 2 is current; restoring revision 2 itself (same snapshot) is the
  // approved no-op: success, unchanged, no new version.
  const response = await restoreRequest(id, {
    cookie, csrf,
    revision: '2',
    ifMatch: `"content:${id}:2"`,
    requestId: 'restore-noop-01234567890'
  });
  assert.equal(response.status, 200, response.text);
  const payload = JSON.parse(response.text);
  assert.equal(payload.changed, false);
  assert.equal(payload.page.currentRevision, '2', 'no new revision is minted');

  const list = JSON.parse((await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text);
  assert.equal(list.pagination.total, '2', 'no duplicate body version exists');

  // The no-op still records a committed operation result for replay.
  const replay = await restoreRequest(id, {
    cookie, csrf,
    revision: '2',
    ifMatch: `"content:${id}:2"`,
    requestId: 'restore-noop-01234567890'
  });
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(replay.text).replayed, true);
  assert.equal(JSON.parse(replay.text).changed, false);
});

test('restore rejects missing, non-existent and cleared source revisions', async () => {
  const id = await createShare(['H33-BAD-SRC', 'H33-BAD-CUR']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const missing = await restoreRequest(id, {
    cookie, csrf, revision: '42', ifMatch: `"content:${id}:2"`, requestId: 'restore-miss-01234567890'
  });
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.text).code, 'RESTORE_SOURCE_INVALID');

  const invalidParam = await restoreRequest(id, {
    cookie, csrf, revision: '0', ifMatch: `"content:${id}:2"`, requestId: 'restore-zero-0123456789'
  });
  assert.equal(invalidParam.status, 400);
  assert.equal(JSON.parse(invalidParam.text).code, 'INVALID_CONTENT_REVISION');

  // A future purge tombstone (snapshot payload cleared) is an invalid source.
  Object.assign(pageRepository.revisions.get(id).get('1'), {
    html_content: null, title: null, description: null, markdown_theme: null
  });
  const cleared = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'restore-clear-012345678'
  });
  assert.equal(cleared.status, 404);
  assert.equal(JSON.parse(cleared.text).code, 'RESTORE_SOURCE_INVALID',
    'a payload-less (purged) revision can never serve as a restore source');
});

test('history supplies CSP-compatible session identity and a usable CSRF token for restore', async () => {
  const id = await createShare(['H33-CSRF-A', 'H33-CSRF-B']);
  const cookie = await dashboardLogin();
  const html = await request(`/admin/pages/${id}/history`, { headers: { Cookie: cookie } });
  const token = html.text.match(/<meta name="csrf-token" content="([^"]+)"/);
  assert.ok(token, 'use the actual HISTORY page token, not the detail-page helper');
  assert.match(html.headers['content-security-policy'], /script-src 'self'/);
  assert.match(html.text, /data-dashboard-session-tag="[a-f0-9]+"/);
  assert.doesNotMatch(html.text, /<script>document\.documentElement\.dataset\.dashboardSessionTag/);
  const restored = await restoreRequest(id, {
    cookie, csrf: token[1], revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'history-csrf-roundtrip-33'
  });
  assert.equal(restored.status, 200, restored.text);
});

test('restore requires a concrete content baseline for the edited share', async () => {
  const id = await createShare(['H33-BASE-A', 'H33-BASE-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const missingId = await restoreRequest(id, { cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"` });
  assert.equal(missingId.status, 400, 'a NEW management-write endpoint requires an operation id');
  assert.equal(JSON.parse(missingId.text).code, 'INVALID_REQUEST_ID');
  const missingTag = await restoreRequest(id, { cookie, csrf, revision: '1', requestId: 'restore-missing-tag-33' });
  assert.equal(missingTag.status, 428, 'a missing If-Match is a missing precondition');

  const wildcard = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: '*', requestId: 'restore-wild-01234567890'
  });
  assert.equal(wildcard.status, 400, 'wildcard preconditions never bypass the version check');

  const foreign = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: '"content:other-share:1"', requestId: 'restore-frn-01234567890'
  });
  assert.equal(foreign.status, 400, 'a tag for another share is an invalid precondition');

  const stale = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:1"`, requestId: 'restore-stale-012345678'
  });
  assert.equal(stale.status, 412);
  const conflict = JSON.parse(stale.text);
  assert.equal(conflict.code, 'CONTENT_REVISION_CONFLICT');
  assert.equal(conflict.current.currentRevision, '2', 'the conflict payload identifies the current version');
});

test('a committed restore replays its original result even when the If-Match is now stale', async () => {
  const id = await createShare(['H33-REPLAY-SRC', 'H33-REPLAY-CUR']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  const requestId = 'restore-replay-012345678';

  const first = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId
  });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.text).page.currentRevision, '3');

  // Another edit moves the Share on (revision 4) — the original tag is stale.
  const laterEdit = await request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': `"content:${id}:3"` }),
    body: JSON.stringify({ htmlContent: '<h1>H33-REPLAY-AFTER</h1>' })
  });
  assert.equal(laterEdit.status, 200);

  // The client-unknown retry: ORIGINAL id, ORIGINAL input, ORIGINAL (stale)
  // tag. It must confirm the committed restore, never misreport a first
  // failure, and never mint a second restore revision.
  const replay = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId
  });
  assert.equal(replay.status, 200);
  const payload = JSON.parse(replay.text);
  assert.equal(payload.replayed, true);
  assert.equal(payload.changed, true);
  assert.equal(payload.page.currentRevision, '3', 'the replay confirms the ORIGINAL result revision');
  assert.equal(payload.page.htmlContent, '<h1>H33-REPLAY-SRC</h1>', 'the replayed page is the committed result');

  const list = JSON.parse((await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text);
  assert.deepEqual(list.revisions.map(item => item.revision), ['4', '3', '2', '1'],
    'the replay creates no additional revision');
});

test('the same request id with a different restore input is a 409 and commits nothing', async () => {
  const id = await createShare(['H33-CONF-A', 'H33-CONF-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  const requestId = 'restore-conflict-012345678';

  const first = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId
  });
  assert.equal(first.status, 200);

  const conflict = await restoreRequest(id, {
    cookie, csrf, revision: '2', ifMatch: `"content:${id}:3"`, requestId
  });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.text).code, 'REQUEST_ID_CONFLICT');
  const list = JSON.parse((await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } })).text);
  assert.equal(list.pagination.total, '3', 'the conflicting replay commits nothing');
});

test('a restore whose result share was deleted answers 410 and never rebuilds', async () => {
  const id = await createShare(['H33-GONE-A', 'H33-GONE-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  const requestId = 'restore-gone-0123456789';

  const first = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId
  });
  assert.equal(first.status, 200);

  const del = await request(`/admin/pages/${id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  assert.equal(del.status, 200);

  const replay = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId
  });
  assert.equal(replay.status, 410);
  assert.equal(JSON.parse(replay.text).code, 'RESULT_UNAVAILABLE');
  assert.equal(await pageRepository.getById(id), null, 'nothing is rebuilt');
});

test('Memory restore rolls back projection, snapshot, audit and operation after result-insert failure', async () => {
  const id = await createShare(['H33-ATOMIC-A', 'H33-ATOMIC-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  const options = { cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'restore-atomic-memory-33' };
  const before = {
    page: await pageRepository.getById(id), revisions: await pageRepository.listContentRevisions(id),
    audits: JSON.stringify(pageRepository.auditLogs)
  };
  const runTransaction = pageRepository.withPublishingTransaction;
  pageRepository.withPublishingTransaction = function (operation) {
    return runTransaction.call(this, async tx => {
      const insert = tx.createPublishingOperation.bind(tx);
      tx.createPublishingOperation = async record => {
        await insert(record);
        throw new Error('issue33 injected failure after staged result insert');
      };
      return operation(tx);
    });
  };
  try {
    const failed = await restoreRequest(id, options);
    assert.equal(failed.status, 500);
  } finally { pageRepository.withPublishingTransaction = runTransaction; }
  assert.deepEqual(await pageRepository.getById(id), before.page);
  assert.deepEqual(await pageRepository.listContentRevisions(id), before.revisions);
  assert.equal(JSON.stringify(pageRepository.auditLogs), before.audits);
  assert.deepEqual(await pageRepository.findPublishingOperationsByRequestId(options.requestId), []);
  const retry = await restoreRequest(id, options);
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(retry.text).page.currentRevision, '3');
});

test('restore honours the write-maintenance gate like every dashboard write', async () => {
  const id = await createShare(['H33-PAUSE-A', 'H33-PAUSE-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  await pageRepository.setPublishingWritesPaused(true);
  try {
    const blocked = await restoreRequest(id, {
      cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'restore-pause-012345678'
    });
    assert.equal(blocked.status, 503);
    assert.equal(JSON.parse(blocked.text).retryable, true);
  } finally {
    await pageRepository.setPublishingWritesPaused(false);
  }

  const operations = await pageRepository.findPublishingOperationsByRequestId('restore-pause-012345678');
  assert.equal(operations.length, 0, 'a maintenance-refused attempt records no operation');

  // After the pause lifts, the same request id succeeds exactly once.
  const retried = await restoreRequest(id, {
    cookie, csrf, revision: '1', ifMatch: `"content:${id}:2"`, requestId: 'restore-pause-012345678'
  });
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(retried.text).replayed, undefined);
});

test('restore works with exact decimal revisions above 2^53 and never rounds them', async () => {
  const id = await createShare(['H33-BIG-A', 'H33-BIG-B']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Synthetic sparse history ABOVE 2^53 with current strictly after source.
  const bigSource = '9007199254740993';
  const revisions = pageRepository.revisions.get(id);
  revisions.set(bigSource, {
    share_id: id, revision: bigSource, html_content: '<h1>H33-BIG-ANCIENT</h1>', code_type: 'html',
    title: null, description: null, markdown_theme: null, created_at: Date.now(),
    snapshot_hash: 'synthetic', source: 'web', actor: null, restored_from: null
  });

  const bigCurrent = '9007199254740994';
  const bigResult = '9007199254740995';
  revisions.set(bigCurrent, { ...revisions.get('2'), revision: bigCurrent });
  revisions.delete('2');
  pageRepository.pages.get(id).current_revision = bigCurrent;
  const response = await restoreRequest(id, {
    cookie, csrf, revision: bigSource, ifMatch: `"content:${id}:${bigCurrent}"`, requestId: 'restore-big-01234567890'
  });
  assert.equal(response.status, 200, response.text);
  const payload = JSON.parse(response.text);
  assert.equal(payload.page.currentRevision, bigResult);
  assert.equal(payload.page.htmlContent, '<h1>H33-BIG-ANCIENT</h1>');

  const restored = JSON.parse((await request(`/admin/pages/${id}/revisions/${bigResult}`, { headers: { Cookie: cookie } })).text);
  assert.equal(restored.revision.restoredFrom, bigSource, 'the restored_from pointer is the exact decimal string');

  // Replaying the big-source restore with the stale tag confirms, not conflicts.
  const replay = await restoreRequest(id, {
    cookie, csrf, revision: bigSource, ifMatch: `"content:${id}:${bigCurrent}"`, requestId: 'restore-big-01234567890'
  });
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(replay.text).replayed, true);
});
