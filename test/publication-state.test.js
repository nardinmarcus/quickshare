const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue35-publication-state-secret';

const app = require('../app');
const repository = app.locals.pageRepository;
const { encryptSecret, hashSecret } = require('../utils/security');

let server;
let origin;

const UNPUBLISH_REQUEST_ID = 'issue35-unpublish-000000001';
const REPUBLISH_REQUEST_ID = 'issue35-republish-000000001';

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML responses */ }
  return { status: response.status, headers: response.headers, text, json };
}

async function seedShare({
  id,
  title = null,
  password = null,
  expiresAt = null,
  published = true
} = {}) {
  await repository.create({
    id,
    htmlContent: `<h1>${id} body</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title,
    description: null,
    expiresAt,
    markdownTheme: null
  });
  if (!published) {
    const page = await repository.getById(id);
    const result = await repository.setPublished(id, {
      published: false,
      expectedAccessRevision: String(page.access_revision),
      returnUpdated: true
    });
    assert.equal(result.changed, true);
  }
  return repository.getById(id);
}

function unpublishPath(id) { return `/admin/pages/${encodeURIComponent(id)}/unpublish`; }
function republishPath(id) { return `/admin/pages/${encodeURIComponent(id)}/republish`; }

test('unpublish requires a valid request id and an explicit access baseline', async () => {
  const page = await seedShare({ id: 'pub-guard-html' });

  const missingKey = await request(unpublishPath(page.id), { method: 'POST', body: { expectedAccessRevision: '1' } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.code, 'INVALID_REQUEST_ID');

  const malformedKey = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': 'short' }
  });
  assert.equal(malformedKey.status, 400);
  assert.equal(malformedKey.json.code, 'INVALID_REQUEST_ID');

  const missingBaseline = await request(unpublishPath(page.id), {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'guard-a' }
  });
  assert.equal(missingBaseline.status, 428);
  assert.equal(missingBaseline.json.code, 'ACCESS_PRECONDITION_REQUIRED');

  for (const invalid of ['0', '-1', 'abc', '1.5', '9223372036854775808']) {
    const invalidBaseline = await request(unpublishPath(page.id), {
      method: 'POST',
      body: { expectedAccessRevision: invalid },
      headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'guard-b' }
    });
    assert.equal(invalidBaseline.status, 400, `expected 400 for ${invalid}`);
    assert.equal(invalidBaseline.json.code, 'INVALID_ACCESS_REVISION');
  }

  const after = await repository.getById(page.id);
  assert.equal(String(after.access_revision), '1', 'rejected requests change nothing');
});

test('republish enforces the same request identity and baseline format', async () => {
  const page = await seedShare({ id: 'pub-guard-repub' });

  const missingKey = await request(republishPath(page.id), { method: 'POST', body: { expectedAccessRevision: '1' } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.code, 'INVALID_REQUEST_ID');

  const missingBaseline = await request(republishPath(page.id), {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': REPUBLISH_REQUEST_ID + 'guard-a' }
  });
  assert.equal(missingBaseline.status, 428);
  assert.equal(missingBaseline.json.code, 'ACCESS_PRECONDITION_REQUIRED');

  const after = await repository.getById(page.id);
  assert.equal(String(after.access_revision), '1');
});

test('unpublish pauses public access and bumps the access revision atomically', async () => {
  const page = await seedShare({ id: 'pub-unpublish-html', title: 'Unpublish Me' });

  const publicBefore = await request(`/view/${page.id}`);
  assert.equal(publicBefore.status, 200);

  const response = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID }
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.success, true);
  assert.equal(response.json.changed, true);
  assert.equal(response.json.published, false);
  assert.equal(response.json.requestId, UNPUBLISH_REQUEST_ID);
  assert.equal(response.json.accessRevision, '2');
  assert.equal(response.json.page.published, false);
  assert.equal(response.json.page.accessRevision, '2');
  assert.equal(response.json.page.htmlContent, `<h1>${page.id} body</h1>`, 'content untouched');

  const stored = await repository.getById(page.id);
  assert.equal(stored.published, false);
  assert.equal(String(stored.access_revision), '2');
  assert.equal(String(stored.current_revision), '1', 'content revision untouched');

  const publicAfter = await request(`/view/${page.id}`);
  assert.equal(publicAfter.status, 404);
  const metadataAfter = await request(`/api/pages/${page.id}`);
  assert.equal(metadataAfter.status, 404);

  const audits = repository.auditLogs.filter(log => log.action === 'page.unpublish' && log.pageId === page.id);
  assert.equal(audits.length, 1, 'exactly one audit entry commits');

  const operations = await repository.findPublishingOperationsByRequestId(UNPUBLISH_REQUEST_ID);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].action, 'unpublish');
  assert.equal(operations[0].target_id, page.id);
  assert.equal(String(operations[0].result_access_revision), '2');
});

test('unpublishing an already-unpublished Share records unchanged without a second bump', async () => {
  const page = await seedShare({ id: 'pub-repeat-html' });
  const first = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'repeat-a' }
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.changed, true);
  assert.equal(first.json.accessRevision, '2');

  const repeat = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '2' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'repeat-b' }
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.json.changed, false);
  assert.equal(repeat.json.published, false);
  assert.equal(repeat.json.accessRevision, '2', 'same-state repeat does not advance the revision');

  const stored = await repository.getById(page.id);
  assert.equal(String(stored.access_revision), '2');
  const audits = repository.auditLogs.filter(log => log.action === 'page.unpublish' && log.pageId === page.id);
  assert.equal(audits.length, 1, 'no duplicate audit side effect');
});

test('republish restores public access, advances the revision again and changes nothing else', async () => {
  const password = 'pub-8888';
  const page = await seedShare({ id: 'pub-republish-html', password, expiresAt: Date.now() + 3_600_000 });
  const before = await repository.getById(page.id);
  const contentBefore = await repository.getContentRevision(page.id, String(before.current_revision));

  const down = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': REPUBLISH_REQUEST_ID + 'down' }
  });
  assert.equal(down.json.accessRevision, '2');

  const up = await request(republishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '2' },
    headers: { 'Idempotency-Key': REPUBLISH_REQUEST_ID }
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.changed, true);
  assert.equal(up.json.published, true);
  assert.equal(up.json.accessRevision, '3');
  assert.equal(up.json.page.published, true);

  const after = await repository.getById(page.id);
  assert.equal(after.published, true);
  assert.equal(String(after.access_revision), '3');
  assert.equal(after.password_hash, before.password_hash, 'password untouched');
  assert.equal(after.encrypted_password, before.encrypted_password, 'encrypted password untouched');
  assert.equal(after.expires_at, before.expires_at, 'expiry untouched');
  assert.equal(after.is_favorite === true, false, 'favorite untouched');
  assert.equal(Number(after.view_count || 0), Number(before.view_count || 0), 'view count untouched');
  assert.equal(String(after.current_revision), String(before.current_revision), 'content revision untouched');

  const contentAfter = await repository.getContentRevision(page.id, String(after.current_revision));
  assert.equal(contentAfter.snapshot_hash, contentBefore.snapshot_hash, 'content snapshot untouched');

  const republishAudits = repository.auditLogs.filter(log => log.action === 'page.republish' && log.pageId === page.id);
  assert.equal(republishAudits.length, 1);

  const publicView = await request(`/view/${page.id}`);
  assert.equal(publicView.status, 200, 'public access resumes on the original URL');
});

test('a stale access baseline is rejected with 412 and changes nothing', async () => {
  const page = await seedShare({ id: 'pub-stale-html' });
  const stale = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '9' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'stale-a' }
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'ACCESS_REVISION_CONFLICT');

  const stored = await repository.getById(page.id);
  assert.equal(stored.published, true);
  assert.equal(String(stored.access_revision), '1');
});

test('publish-state operations target a missing Share with a controlled 404', async () => {
  const response = await request(unpublishPath('missing-share'), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'miss-a' }
  });
  assert.equal(response.status, 404);
  assert.equal(response.json.code, 'SHARE_NOT_FOUND');
});

test('a lost response replays the committed result without a second side effect', async () => {
  const page = await seedShare({ id: 'pub-replay-html' });
  const first = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'replay-a' }
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.changed, true);
  assert.equal(first.json.accessRevision, '2');

  const auditsAfterFirst = repository.auditLogs.filter(log => log.action === 'page.unpublish').length;

  // Retry with the ORIGINAL id and the ORIGINAL (now stale) baseline: the
  // committed result is confirmed before any CAS would reject it.
  const retry = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'replay-a' }
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.replayed, true);
  assert.equal(retry.json.action, 'unpublish');
  assert.equal(retry.json.changed, true);
  assert.equal(retry.json.published, false);
  assert.equal(retry.json.accessRevision, '2', 'replay confirms the committed revision');

  const stored = await repository.getById(page.id);
  assert.equal(String(stored.access_revision), '2', 'no second bump');
  const auditsAfterRetry = repository.auditLogs.filter(log => log.action === 'page.unpublish').length;
  assert.equal(auditsAfterRetry, auditsAfterFirst, 'no duplicate audit entry');
});

test('the same request id bound to a different baseline is a conflict', async () => {
  const page = await seedShare({ id: 'pub-conflict-html' });
  const first = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'conflic-a' }
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.changed, true);

  // Same id, DIFFERENT digest (the post-transition baseline): 409, and the
  // committed result stays untouched.
  const conflict = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '2' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'conflic-a' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'REQUEST_ID_CONFLICT');
  const stored = await repository.getById(page.id);
  assert.equal(String(stored.access_revision), '2', 'a conflict commits nothing new');
});

test('write maintenance pauses publish-state operations like every publishing write', async () => {
  const page = await seedShare({ id: 'pub-maint-html' });
  await repository.setPublishingWritesPaused(true);
  try {
    const blocked = await request(unpublishPath(page.id), {
      method: 'POST',
      body: { expectedAccessRevision: '1' },
      headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'maint-a' }
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json.code, 'PUBLISHING_MAINTENANCE');

    const stored = await repository.getById(page.id);
    assert.equal(stored.published, true);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }
});

test('public surfaces unify unpublished, missing and deleted as one neutral 404', async () => {
  const page = await seedShare({ id: 'pub-neutral-html', title: 'Neutral Title' });
  await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'neutra-a' }
  });

  const view = await request(`/view/${page.id}`);
  assert.equal(view.status, 404);
  assert.match(view.text, /页面不存在/);
  assert.doesNotMatch(view.text, /Neutral Title/);
  assert.doesNotMatch(view.text, new RegExp(page.id));

  const metadata = await request(`/api/pages/${page.id}`);
  assert.equal(metadata.status, 404);
  assert.deepEqual(metadata.json, { success: false, error: '页面不存在' });

  const password = await request(`/view/${page.id}/password`, { method: 'POST', body: { password: 'whatever' } });
  assert.equal(password.status, 404);
  assert.deepEqual(password.json, { valid: false });
});

test('expiry applies only to published Shares: expired+unpublished reads as 404', async () => {
  const expiredPublished = await seedShare({ id: 'pub-exp-pub-html', expiresAt: Date.now() - 60_000 });
  const expiredUnpublished = await seedShare({
    id: 'pub-exp-unpub-html',
    expiresAt: Date.now() - 60_000,
    published: false
  });

  const viewPublished = await request(`/view/${expiredPublished.id}`);
  assert.equal(viewPublished.status, 410);
  const metadataPublished = await request(`/api/pages/${expiredPublished.id}`);
  assert.equal(metadataPublished.status, 410);

  const viewUnpublished = await request(`/view/${expiredUnpublished.id}`);
  assert.equal(viewUnpublished.status, 404, 'unpublished is evaluated before expiry');
  const metadataUnpublished = await request(`/api/pages/${expiredUnpublished.id}`);
  assert.equal(metadataUnpublished.status, 404);
  assert.match(viewUnpublished.text, /页面不存在/);
  assert.doesNotMatch(viewUnpublished.text, /已失效/);
});

test('view events never count an unpublished Share and answer 404', async () => {
  const page = await seedShare({ id: 'pub-event-html' });
  const counted = await request(`/view/${page.id}/view-event`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch' }
  });
  assert.equal(counted.status, 204);
  const withView = await repository.getById(page.id);
  assert.equal(Number(withView.view_count || 0), 1);

  await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'event-a' }
  });

  const rejected = await request(`/view/${page.id}/view-event`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch' }
  });
  assert.equal(rejected.status, 404);
  const after = await repository.getById(page.id);
  assert.equal(Number(after.view_count || 0), 1, 'unpublished views are not counted');

  // Same rule while writes are paused: classification still refuses.
  await repository.setPublishingWritesPaused(true);
  try {
    const paused = await request(`/view/${page.id}/view-event`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch' }
    });
    assert.equal(paused.status, 404);
  } finally {
    await repository.setPublishingWritesPaused(false);
  }
});

test('unlock cookies minted before either transition can never authorize afterwards', async () => {
  const password = 'rev-4321';
  const page = await seedShare({ id: 'pub-cookie-html', password });

  const unlock = await request(`/view/${page.id}/password`, { method: 'POST', body: { password } });
  assert.equal(unlock.status, 200);
  const setCookie = unlock.headers.get('set-cookie');
  assert.ok(setCookie, 'unlock mints an access cookie');
  const cookie = setCookie.split(';')[0];

  const viewUnlocked = await request(`/view/${page.id}`, { headers: { Cookie: cookie } });
  assert.equal(viewUnlocked.status, 200);

  const down = await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'cookie' }
  });
  assert.equal(down.status, 200);

  const viewWhileUnpublished = await request(`/view/${page.id}`, { headers: { Cookie: cookie } });
  assert.equal(viewWhileUnpublished.status, 404, 'the old cookie cannot revive an unpublished Share');

  const up = await request(republishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '2' },
    headers: { 'Idempotency-Key': REPUBLISH_REQUEST_ID + 'cookie' }
  });
  assert.equal(up.json.accessRevision, '3');

  const viewRepublished = await request(`/view/${page.id}`, { headers: { Cookie: cookie } });
  assert.equal(viewRepublished.status, 200);
  assert.match(viewRepublished.text, /password/i, 'republished Share is locked again for the old cookie');

  const metadataLocked = await request(`/api/pages/${page.id}`, { headers: { Cookie: cookie } });
  assert.equal(metadataLocked.status, 403, 'locked metadata stays neutral 403 for the old cookie');

  const eventLocked = await request(`/view/${page.id}/view-event`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch' }
  });
  assert.equal(eventLocked.status, 403);
  const notCounted = await repository.getById(page.id);
  assert.equal(Number(notCounted.view_count || 0), 0, 'the old cookie never counts a view');

  const reUnlock = await request(`/view/${page.id}/password`, { method: 'POST', body: { password } });
  assert.equal(reUnlock.status, 200);
  const freshCookie = reUnlock.headers.get('set-cookie').split(';')[0];
  const viewFresh = await request(`/view/${page.id}`, { headers: { Cookie: freshCookie } });
  assert.equal(viewFresh.status, 200);
  assert.doesNotMatch(viewFresh.text, /password/i);
});

test('the owner dashboard keeps read, edit, history, favorite and clone for unpublished Shares', async () => {
  const page = await seedShare({ id: 'pub-owner-html', title: 'Owner Retention' });
  await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'owner-a' }
  });

  const detail = await request(`/admin/pages/${page.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /已下架/);
  assert.match(detail.text, /Owner Retention/);

  const edit = await request(`/admin/pages/${page.id}`, {
    method: 'PUT',
    body: {
      htmlContent: '<h1>Owner Retention edited</h1>',
      title: 'Owner Retention',
      description: null,
      markdownTheme: null,
      expectedContentRevision: undefined
    },
    headers: {
      'If-Match': `"content:${page.id}:1"`
    }
  });
  assert.equal(edit.status, 200, 'content editing still works while unpublished');
  assert.equal(edit.json.page.currentRevision, '2');

  const favorite = await request(`/admin/pages/${page.id}/favorite`, {
    method: 'PUT',
    body: { isFavorite: true }
  });
  assert.equal(favorite.status, 200);
  assert.equal(favorite.json.isFavorite, true, 'favorite still works while unpublished');

  const history = await request(`/admin/pages/${page.id}/history`);
  assert.equal(history.status, 200);

  const cloneResponse = await fetch(origin + `/admin/pages/${page.id}/clone`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ requestId: UNPUBLISH_REQUEST_ID + 'clone-x' }).toString()
  });
  assert.equal(cloneResponse.status, 302, 'clone still works while unpublished');
});

test('dashboard list renders the unpublished state with its toggle and baseline', async () => {
  const page = await seedShare({ id: 'pub-list-html', title: 'Listed But Paused' });
  await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'list-a' }
  });

  const list = await request('/admin/pages');
  assert.equal(list.status, 200);
  assert.match(list.text, /已下架/);
  assert.match(list.text, new RegExp(`data-page-id="${page.id}"[^>]*data-published="false"`));
});

test('operation review lists publish-state records like every other action', async () => {
  const page = await seedShare({ id: 'pub-review-html' });
  await request(unpublishPath(page.id), {
    method: 'POST',
    body: { expectedAccessRevision: '1' },
    headers: { 'Idempotency-Key': UNPUBLISH_REQUEST_ID + 'review' }
  });

  const review = await request(`/admin/operations?requestId=${UNPUBLISH_REQUEST_ID}review`);
  assert.equal(review.status, 200);
  assert.equal(review.json.operations.length, 1);
  const record = review.json.operations[0];
  assert.equal(record.action, 'unpublish');
  assert.equal(record.accessRevision, '2');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.namespaceKind, 'dashboard-session');
});
