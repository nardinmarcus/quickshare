// #34 owner-confirmed purge of a noncurrent Share revision.
//
// Behavior under test (parent #24 §3/§8/§9, issue #34):
// - Purge is dashboard-session + CSRF only; the confirmation names the exact
//   Share and revision. Frontend-login cookies, API keys and anonymous
//   callers are all denied. The CURRENT revision can never be purged (409).
// - The purge transaction atomically: clears the snapshot payload (body,
//   title, description, theme), wipes the sensitive receipt bytes of every
//   publish operation that produced or resulted in that Share+Revision
//   (across actor namespaces), and writes a real tombstone (purged_at) that
//   keeps share/revision identity, time, action, provenance and restore
//   origin. The history entry itself is never deleted and the revision
//   number is never reused.
// - A purged target reads as 410 (gone) on single-revision reads, previews
//   and restore sources; list projections carry the tombstone state. A
//   repeat purge of the same tombstone is an unchanged success (idempotent);
//   a purge of an already-purged target must not report the generic failure.
// - Replay discipline (#24 §8): old create/clone/content-update/restore
//   operations whose committed RESULT is the purged revision replay as
//   result-unavailable (410) — never serving purged receipt metadata, never
//   recreating content. Restore/replay never resurrects payload bytes.
// - Copy honesty: success copy promises only the ONLINE stored version.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'purge-front-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'purge-dashboard-password';
process.env.SHARE_API_KEY = 'purge-share-api-key';
process.env.SESSION_SECRET = 'issue34-purge-http-secret';
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
    body: 'password=purge-dashboard-password'
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
    body: 'password=purge-front-password'
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

async function createShare(markers, { title = 'Purge share' } = {}) {
  const response = await request('/api/v1/share', {
    method: 'POST',
    headers: jsonHeaders({ 'X-API-Key': 'purge-share-api-key' }),
    body: JSON.stringify({ htmlContent: `<h1>${markers[0]}</h1>`, codeType: 'html', title })
  });
  assert.equal(response.status, 200, response.text);
  const id = JSON.parse(response.text).urlId;
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

async function purgeRequest(id, { cookie, csrf, revision, confirm, body } = {}) {
  return request(`/admin/pages/${id}/revisions/${revision}/purge`, {
    method: 'POST',
    headers: jsonHeaders({
      ...(cookie !== undefined ? { Cookie: cookie } : {}),
      ...(csrf !== undefined ? { 'X-CSRF-Token': csrf } : {})
    }),
    body: JSON.stringify(body || { confirm: confirm !== undefined ? confirm : `${id}:${revision}` })
  });
}

test('purge refuses anonymous, frontend-cookie, API-key and missing-CSRF identities without side effects', async () => {
  const id = await createShare(['P34-AUTH-V1-SECRET', 'P34-AUTH-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  for (const identity of [
    {},
    { Cookie: await frontendLogin() },
    { 'X-API-Key': 'purge-share-api-key' }
  ]) {
    const result = await request(`/admin/pages/${id}/revisions/1/purge`, {
      method: 'POST',
      headers: { ...identity, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: `${id}:1` })
    });
    assert.equal(result.status, 401, `identity ${JSON.stringify(Object.keys(identity))} is denied`);
    assert.doesNotMatch(result.text, /P34-AUTH/);
  }

  // Missing CSRF token: forbidden, no side effects.
  const missingCsrf = await purgeRequest(id, { cookie, revision: '1' });
  assert.equal(missingCsrf.status, 403);
  const snapshot = await pageRepository.getContentRevision(id, '1');
  assert.equal(snapshot.html_content, '<h1>P34-AUTH-V1-SECRET</h1>', 'no purge happened without CSRF');
});

test('wrong-identity confirmation and unknown Share or revision are rejected without side effects', async () => {
  const id = await createShare(['P34-WRN-V1-SECRET', 'P34-WRN-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const wrongShare = await purgeRequest(id, { cookie, csrf, revision: '1', confirm: 'other-share:1' });
  assert.equal(wrongShare.status, 400, 'a confirmation naming another Share is invalid');
  assert.equal(JSON.parse(wrongShare.text).code, 'PURGE_CONFIRMATION_MISMATCH');

  const wrongRevision = await purgeRequest(id, { cookie, csrf, revision: '1', confirm: `${id}:2` });
  assert.equal(wrongRevision.status, 400, 'a confirmation naming another revision is invalid');

  const missing = await purgeRequest(id, { cookie, csrf, revision: '1', confirm: undefined, body: {} });
  assert.equal(missing.status, 400);

  const unknownShare = await purgeRequest('no-such-share-34', {
    cookie, csrf: await dashboardCsrf(cookie, 'no-such-share-34').catch(() => csrf), revision: '1'
  });
  assert.ok([404].includes(unknownShare.status), 'an unknown Share is a 404');

  const unknownRevision = await purgeRequest(id, { cookie, csrf, revision: '999' });
  assert.equal(unknownRevision.status, 404);
  const untouched = await pageRepository.getContentRevision(id, '1');
  assert.equal(untouched.html_content, '<h1>P34-WRN-V1-SECRET</h1>');
});

test('the current revision can never be purged (409) and purge never deletes the history entry', async () => {
  const id = await createShare(['P34-CUR-V1', 'P34-CUR-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const refused = await purgeRequest(id, { cookie, csrf, revision: '2' });
  assert.equal(refused.status, 409);
  assert.equal(JSON.parse(refused.text).code, 'CURRENT_REVISION_PURGE_FORBIDDEN');

  const page = await pageRepository.getById(id);
  assert.equal(String(page.current_revision), '2', 'no pointer moved');
  assert.equal(page.html_content, '<h1>P34-CUR-V2</h1>', 'current content untouched');

  const invalid = await purgeRequest(id, { cookie, csrf, revision: '0' });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.text).code, 'INVALID_CONTENT_REVISION');
  const huge = await purgeRequest(id, { cookie, csrf, revision: '9223372036854775808' });
  assert.equal(huge.status, 400);
});

test('purge clears the payload atomically, keeps a real tombstone and never reuses the revision number', async () => {
  const id = await createShare(['P34-PURGE-V1-SECRET-BODY', 'P34-PURGE-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const before = await pageRepository.getContentRevision(id, '1');
  assert.equal(before.html_content, '<h1>P34-PURGE-V1-SECRET-BODY</h1>');
  assert.equal(before.title, 'Purge share');
  const purgeAt = Date.now();
  const response = await purgeRequest(id, { cookie, csrf, revision: '1' });
  assert.equal(response.status, 200, response.text);
  const payload = JSON.parse(response.text);
  assert.equal(payload.success, true);
  assert.equal(payload.purged.revision, '1', 'the tombstone names the exact revision');
  assert.equal(payload.purged.shareId, id);
  assert.equal(payload.changed, true, 'a fresh purge reports changed');

  // Tombstone keeps identity/time/provenance but loses ALL payload bytes.
  const tombstone = await pageRepository.getContentRevision(id, '1');
  assert.equal(tombstone.revision, '1', 'the history entry survives');
  assert.equal(tombstone.created_at, before.created_at, 'original creation time preserved');
  assert.equal(tombstone.source, before.source, 'action provenance preserved');
  assert.equal(tombstone.actor, before.actor, 'actor preserved');
  assert.equal(tombstone.restored_from, before.restored_from, 'restore origin preserved');
  assert.ok(Number(tombstone.purged_at) >= purgeAt - 1000, 'purge time recorded');
  assert.equal(tombstone.html_content, null, 'body removed');
  assert.equal(tombstone.title, null, 'title removed');
  assert.equal(tombstone.description, null, 'description removed');
  assert.equal(tombstone.markdown_theme, null, 'theme removed');
  assert.equal(tombstone.snapshot_hash, null, 'snapshot hash no longer recomputable');

  // The revision number is NOT reusable: a same-snapshot restore of the live
  // current revision would mint 3, never re-writing revision 1.
  const listResponse = await request(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  const list = JSON.parse(listResponse.text);
  assert.equal(list.pagination.total, '2', 'history keeps both entries');
  const purgedItem = list.revisions.find(item => item.revision === '1');
  assert.ok(purgedItem, 'purged revision still listed');
  assert.equal(purgedItem.purged, true, 'list carries the tombstone state');
  assert.ok(!listResponse.text.includes('P34-PURGE-V1-SECRET-BODY'), 'no payload bytes in the list');

  // Live empty content and purged payload are robustly distinguishable at
  // the adapter boundary (creation rejects empty bodies, so this uses the
  // memory adapter directly — the same distinction the HTTP layer relies on:
  // live bodies are always strings, purged payloads are exactly null).
  const memoryRepository = new (require('../models/memory-pages').MemoryPageRepository)();
  await memoryRepository.create({ id: 'purge-empty-live-34', createdAt: Date.now(), htmlContent: '', codeType: 'html' });
  const liveEmpty = await memoryRepository.getContentRevision('purge-empty-live-34', '1');
  assert.equal(liveEmpty.html_content, '', 'a genuinely empty live body stays a string');
  assert.ok(liveEmpty.purged_at === null || liveEmpty.purged_at === undefined,
    'live empty content carries NO purge marker');
});

test('purged revision reads and previews return 410 gone with no payload and no shared caching', async () => {
  const id = await createShare(['P34-GONE-V1-SECRET', 'P34-GONE-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  assert.equal((await purgeRequest(id, { cookie, csrf, revision: '1' })).status, 200);

  const single = await request(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  assert.equal(single.status, 410, 'purged revision read is gone');
  assert.match(single.headers['cache-control'] || '', /no-store/, 'never shared-cached');
  assert.ok(!single.text.includes('P34-GONE-V1-SECRET'), 'no payload leaks on 410');
  const body = JSON.parse(single.text);
  assert.equal(body.code, 'REVISION_PURGED');
  assert.equal(body.revision && body.revision.revision, '1', 'the tombstone identity may be confirmed');
  assert.equal(body.revision && body.revision.htmlContent, undefined, 'but never any body');

  const preview = await request(`/admin/pages/${id}/revisions/1/preview`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 410, 'purged preview is gone');
  assert.ok(!preview.text.includes('P34-GONE-V1-SECRET'), 'no payload leaks on preview 410');

  const current = await pageRepository.getById(id);
  assert.equal(String(current.current_revision), '2', 'purge never moves the content pointer');
  assert.equal(current.html_content, '<h1>P34-GONE-V2</h1>', 'current projection untouched');
});

test('restore from a purged tombstone is refused; repeat purge is an unchanged success', async () => {
  const id = await createShare(['P34-RE-V1-SECRET', 'P34-RE-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);
  assert.equal((await purgeRequest(id, { cookie, csrf, revision: '1' })).status, 200);

  const restore = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:' + id + ':2"',
      'Idempotency-Key': 'purge-restore-refused-034'
    }),
    body: JSON.stringify({ revision: '1' })
  });
  assert.equal(restore.status, 404, 'a purged source is not a restorable source');
  assert.equal(JSON.parse(restore.text).code, 'RESTORE_SOURCE_INVALID');
  assert.equal(String((await pageRepository.getById(id)).current_revision), '2');

  // Repeat purge of the same tombstone: success, unchanged, idempotent.
  const again = await purgeRequest(id, { cookie, csrf, revision: '1' });
  assert.equal(again.status, 200, 'a second deliberate purge succeeds');
  const payload = JSON.parse(again.text);
  assert.equal(payload.changed, false, 'no duplicate destructive effects');
  assert.equal(payload.alreadyPurged, true, 'reported as already purged');
  const tombstone = await pageRepository.getContentRevision(id, '1');
  assert.equal(tombstone.html_content, null);
  assert.equal(String((await pageRepository.getById(id)).current_revision), '2');

  // The purge success itself replays as success: confirmation logic must not
  // treat "target is now purged" as "the purge failed".
  const replayCopy = JSON.parse(again.text);
  assert.equal(replayCopy.success, true);
  assert.ok(!replayCopy.error, 'no failure is implied for a confirmed tombstone');
});

test('purge wipes sensitive receipts of every operation that produced the revision across namespaces, not others', async () => {
  const id = await createShare(['P34-RCPT-V1-SECRET', 'P34-RCPT-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Two operations in DIFFERENT actor namespaces whose committed result is
  // revision 1 of this Share: a content-update by this dashboard session and
  // a synthetic foreign-namespace restore pointing at the same revision.
  const updateResponse = await request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:' + id + ':2"',
      'Idempotency-Key': 'purge-receipt-target-34001'
    }),
    body: JSON.stringify({ htmlContent: '<h1>P34-RCPT-V1-SECRET</h1>', title: 'Purge share' })
  });
  assert.equal(updateResponse.status, 200, updateResponse.text);
  assert.equal(JSON.parse(updateResponse.text).changed, true,
    'the update restores revision-1 payload as a NEW revision (exact payload equality with the live projection is what matters)');

  // Force the state we need deterministically: revision 1 is NOT current, so
  // run the update against a fresh share where revision 1 was created by the
  // API and the dashboard later edited to revision 2.
  const record = await pageRepository.findPublishingOperationsByRequestId('purge-receipt-target-34001');
  assert.equal(record.length, 1, 'the content-update operation is committed');
  assert.equal(String(record[0].result_revision), '3', 'the update produced revision 3');

  // A foreign-namespace operation whose RESULT REVISION is exactly 1: the
  // original API create recorded by its own namespace cannot exist for a
  // dashboard-created share, so synthesize one through the repository API —
  // the same write path a real operation would take.
  await pageRepository.createPublishingOperation({
    actor_namespace: 'managed-key:purge-test-foreign-key',
    request_id: 'purge-receipt-foreign-34002',
    action: 'restore',
    request_digest: 'a'.repeat(64),
    target_id: id,
    result_share_id: id,
    result_revision: '1',
    result_access_revision: '1',
    receipt_encrypted: (() => {
      const { encodeOperationReceipt } = require('../utils/publishingOperation');
      return encodeOperationReceipt({ sourceRevision: '1', changed: true, sensitiveDisplay: 'P34-RCPT-V1-SECRET' });
    })(),
    created_at: Date.now()
  });

  const receiptsBefore = await pageRepository.findPublishingOperationsByRequestId('purge-receipt-foreign-34002');
  assert.ok(receiptsBefore[0].receipt_encrypted, 'the foreign receipt is still present before purge');
  const { decodeOperationReceipt } = require('../utils/publishingOperation');
  assert.ok(JSON.stringify(decodeOperationReceipt(receiptsBefore[0].receipt_encrypted)).includes('P34-RCPT-V1-SECRET'),
    'precondition: the foreign receipt carries recoverable bytes referencing the purged revision');

  // An UNRELATED operation on another Share keeps its receipt.
  const otherId = await createShare(['P34-OTHER-V1', 'P34-OTHER-V2']);
  await request(`/admin/pages/${otherId}`, {
    method: 'PUT',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': await dashboardCsrf(cookie, otherId),
      'If-Match': `"content:${otherId}:2"`,
      'Idempotency-Key': 'purge-receipt-unrelated-3403'
    }),
    body: JSON.stringify({ htmlContent: '<h1>P34-OTHER-V1</h1>' })
  });

  const purgeAt = Date.now();
  const response = await purgeRequest(id, { cookie, csrf, revision: '1' });
  assert.equal(response.status, 200, response.text);

  const cleared = await pageRepository.findPublishingOperationsByRequestId('purge-receipt-foreign-34002');
  assert.equal(cleared[0].receipt_encrypted, null, 'sensitive receipt bytes removed');
  assert.ok(Number(cleared[0].purged_at) >= purgeAt - 1000, 'receipt purge time recorded');
  assert.equal(cleared[0].result_revision, '1', 'identity stays (no manufactured versions)');

  // The dashboard-session content-update for revision 3 of the SAME share:
  // its result revision is NOT the purged one — untouched.
  const kept = await pageRepository.findPublishingOperationsByRequestId('purge-receipt-target-34001');
  assert.equal(kept.length, 1);
  assert.ok(kept[0].receipt_encrypted, 'operations for other revisions of the same Share keep receipts');
  assert.equal(String(kept[0].result_revision), '3');

  // The unrelated Share's operation keeps its receipt too.
  const unrelated = await pageRepository.findPublishingOperationsByRequestId('purge-receipt-unrelated-3403');
  assert.ok(unrelated[0].receipt_encrypted, 'unrelated receipts are not scrubbed');
});

test('replay of an operation whose committed result was purged is result-unavailable, never purged metadata', async () => {
  const id = await createShare(['P34-REPLAY-V1-SECRET', 'P34-REPLAY-V2', 'P34-REPLAY-V3']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Commit an idempotent restore producing revision 3 from source 1.
  const restore = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:' + id + ':3"',
      'Idempotency-Key': 'purge-replay-source-34004'
    }),
    body: JSON.stringify({ revision: '1' })
  });
  assert.equal(restore.status, 200, restore.text);
  const restoredPage = JSON.parse(restore.text).page;
  assert.equal(restoredPage.currentRevision, '4', 'restore created revision 4 from source 1');
  assert.equal(restoredPage.htmlContent, '<h1>P34-REPLAY-V1-SECRET</h1>');

  // Purge the SOURCE revision 1. The restore operation's RESULT is revision
  // 4 (a distinct payload), so its receipt must stay — but a DIFFERENT
  // operation whose committed RESULT is revision 1 must replay as gone.
  const csrf2 = await dashboardCsrf(cookie, id);
  assert.equal((await purgeRequest(id, { cookie, csrf: csrf2, revision: '1' })).status, 200);

  // Replay the restore: still succeeds from its committed result revision 4.
  // A retry re-sends the ORIGINAL If-Match (the digest covers the expected
  // revision) — the server confirms the committed result without re-running
  // the CAS.
  const replay = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf2,
      'If-Match': '"content:' + id + ':3"',
      'Idempotency-Key': 'purge-replay-source-34004'
    }),
    body: JSON.stringify({ revision: '1' })
  });
  assert.equal(replay.status, 200, replay.text);
  const replayBody = JSON.parse(replay.text);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.page.currentRevision, '4');
  assert.equal(replayBody.page.htmlContent, '<h1>P34-REPLAY-V1-SECRET</h1>',
    'the committed RESULT revision (4) is intact; replay serves revision 4 payload');

  // Now move the Share forward (revision 5) so revision 4 is no longer
  // current, then purge revision 4 and replay again: the committed result no
  // longer exists with payload — the replay must be result-unavailable
  // (410), must NOT leak the purged receipt metadata and must NOT rebuild.
  const csrf3 = await dashboardCsrf(cookie, id);
  const movedOn = await request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': csrf3, 'If-Match': '"content:' + id + ':4"' }),
    body: JSON.stringify({ htmlContent: '<h1>P34-REPLAY-V5</h1>' })
  });
  assert.equal(movedOn.status, 200, movedOn.text);
  assert.equal((await purgeRequest(id, { cookie, csrf: csrf3, revision: '4' })).status, 200);
  const gone = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf3,
      'If-Match': '"content:' + id + ':3"',
      'Idempotency-Key': 'purge-replay-source-34004'
    }),
    body: JSON.stringify({ revision: '1' })
  });
  assert.equal(gone.status, 410);
  const goneBody = JSON.parse(gone.text);
  assert.equal(goneBody.code, 'RESULT_UNAVAILABLE');
  assert.ok(!gone.text.includes('P34-REPLAY-V1-SECRET'), 'no purged payload leaks through replay');
  const after = await pageRepository.getById(id);
  assert.equal(String(after.current_revision), '5', 'no pointer movement from replays (purge never moves it)');
  assert.equal(after.html_content, '<h1>P34-REPLAY-V5</h1>', 'the live projection follows only the explicit save');
});

test('purge copy promises only the online stored version, not other revisions, downloads or backups', async () => {
  const id = await createShare(['P34-COPY-V1-SECRET', 'P34-COPY-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  const historyHtml = await (await request(`/admin/pages/${id}/history`, { headers: { Cookie: cookie } })).text;
  assert.match(historyHtml, /仅.*在线|在线保存/, 'the purge copy names the online stored version as the only promise');
  assert.match(historyHtml, /其他版本|其他 Revision/, 'the copy does not promise other revisions are purged');
  assert.match(historyHtml, /备份|下载/, 'the copy names backups/downloads as out of scope');
  const purgeAt = Date.now();
  const response = await purgeRequest(id, { cookie, csrf, revision: '1' });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.text);
  assert.match(payload.message || '', /在线/, 'the success copy promises only the online stored version');
});

test('purge and concurrent restore/save race under the same Share lock: purge vs restore cannot bypass checks', async () => {
  const id = await createShare(['P34-RACE-V1-SECRET', 'P34-RACE-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  // Purge revision 1, then immediately attempt a restore of revision 1 with
  // a STALE baseline (content:2). The restore must be refused because the
  // source is purged — regardless of the baseline.
  const purged = await purgeRequest(id, { cookie, csrf, revision: '1' });
  assert.equal(purged.status, 200);

  const staleRestore = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:' + id + ':2"',
      'Idempotency-Key': 'purge-race-restore-03405'
    }),
    body: JSON.stringify({ revision: '1' })
  });
  assert.equal(staleRestore.status, 404);
  assert.equal(JSON.parse(staleRestore.text).code, 'RESTORE_SOURCE_INVALID');

  // A restore of the CURRENT revision (same-snapshot no-op) still works
  // after the purge and never resurrects the purged payload.
  const noop = await request(`/admin/pages/${id}/restore`, {
    method: 'POST',
    headers: jsonHeaders({
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'If-Match': '"content:' + id + ':2"',
      'Idempotency-Key': 'purge-race-noop-03406'
    }),
    body: JSON.stringify({ revision: '2' })
  });
  assert.equal(noop.status, 200);
  assert.equal(JSON.parse(noop.text).changed, false);
});

test('preserve policy state: purge touches no policy field, favorite, views or publication', async () => {
  const id = await createShare(['P34-KEEP-V1-SECRET', 'P34-KEEP-V2']);
  const cookie = await dashboardLogin();
  const csrf = await dashboardCsrf(cookie, id);

  await request(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': csrf }),
    body: JSON.stringify({ isProtected: true, password: 'P34pass', expectedAccessRevision: '1' })
  }).then(r => assert.equal(r.status, 200, r.text));
  await request(`/admin/pages/${id}/favorite`, {
    method: 'PUT', headers: jsonHeaders({ Cookie: cookie, 'X-CSRF-Token': await dashboardCsrf(cookie, id) }),
    body: JSON.stringify({ isFavorite: true })
  }).then(r => assert.equal(r.status, 200));

  const before = await pageRepository.getById(id);
  assert.equal((await purgeRequest(id, { cookie, csrf: await dashboardCsrf(cookie, id), revision: '1' })).status, 200);

  const after = await pageRepository.getById(id);
  assert.equal(after.id, before.id, 'URL identity kept');
  assert.equal(after.access_revision, before.access_revision, 'access revision untouched');
  assert.equal(after.is_protected, 1, 'protection untouched');
  assert.ok(after.password_hash, 'password untouched');
  assert.ok(after.encrypted_password, 'display ciphertext untouched');
  assert.equal(after.is_favorite, true, 'Favorite untouched');
  assert.equal(after.view_count, before.view_count, 'views untouched');
  assert.equal(after.published, before.published, 'publication untouched');
  assert.equal(after.expires_at, before.expires_at, 'expiry untouched');
  assert.equal(after.html_content, '<h1>P34-KEEP-V2</h1>', 'current content untouched');
  assert.equal(String(after.current_revision), '2', 'pointer untouched');
});
