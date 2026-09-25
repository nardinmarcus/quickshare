// #38 — managed-Key revision metadata, single snapshots and conditional restore.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue38-history-legacy-key';
process.env.SMALL_BODY_LIMIT = '16kb';
process.env.SESSION_SECRET = 'issue38-api-revisions-synthetic-secret';

const app = require('../app');
let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

async function request(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(base + path, {
    method,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no JSON response */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function createKey(name) {
  const response = await request('/admin/apis/keys', { method: 'POST', body: { name } });
  assert.equal(response.status, 201);
  return response.body.apiKey;
}

async function createShare({ title, htmlContent = `<h1>${title}</h1>`, codeType = 'html', markdownTheme = null } = {}) {
  const response = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': process.env.SHARE_API_KEY },
    body: { htmlContent, codeType, title, markdownTheme }
  });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

async function grant(key, shareId, canUpdate = false) {
  return request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', body: { shareId, ...(canUpdate ? { canUpdate: true } : {}) }
  });
}

async function edit(repository, id, expectedRevision, { htmlContent, title, description, markdownTheme } = {}) {
  return repository.updatePage(id, {
    htmlContent,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(markdownTheme === undefined ? {} : { markdownTheme }),
    expectedContentRevision: String(expectedRevision),
    returnUpdated: true
  });
}

const keyHeader = secret => ({ 'X-API-Key': secret });
const etag = (id, revision) => `"content:${id}:${revision}"`;

// This tracer-bullet starts RED: the managed-Key history API is not present on BASE.
test('managed Key reads bounded metadata pages and one tombstone-safe snapshot', async () => {
  const readKey = await createKey('issue38 read key');
  const share = await createShare({ title: 'History target', htmlContent: '<h1>body marker v1</h1>' });
  const other = await createShare({ title: 'Unrelated target' });

  const path = `/api/v1/shares/${share.urlId}/revisions`;
  const missingKey = await request(path);
  assert.equal(missingKey.status, 401);
  assert.equal(missingKey.body.requestId, null);
  assert.equal(missingKey.body.retryable, false);
  const invalidKey = await request(path, { headers: keyHeader('invalid-key') });
  assert.equal(invalidKey.status, 401);
  assert.equal(invalidKey.body.code, 'INVALID_API_KEY');
  const unauthorized = await request(path, { headers: keyHeader(readKey.secret) });
  assert.equal(unauthorized.status, 403, 'a create-only key has no read scope');
  assert.equal(unauthorized.headers.get('cache-control'), 'private, no-store');

  assert.equal((await grant(readKey, share.urlId)).status, 201);
  assert.equal((await edit(app.locals.pageRepository, share.urlId, 1, {
    htmlContent: '<h1>body marker v2</h1>', title: 'History target v2'
  })).current_revision, '2');
  assert.equal((await edit(app.locals.pageRepository, share.urlId, 2, {
    htmlContent: '<h1>body marker v3</h1>', title: 'History target v3'
  })).current_revision, '3');

  const missingGrant = await request(`/api/v1/shares/${other.urlId}/revisions`, { headers: keyHeader(readKey.secret) });
  const missingShare = await request('/api/v1/shares/absent-issue38/revisions', { headers: keyHeader(readKey.secret) });
  assert.equal(missingGrant.status, 404);
  assert.equal(missingShare.status, 404);
  assert.equal(missingGrant.body.code, missingShare.body.code, 'grant and Share absence are indistinguishable');

  const first = await request(`${path}?limit=2`, { headers: keyHeader(readKey.secret) });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(first.body.revisions.map(row => row.revision), ['3', '2']);
  assert.ok(first.body.nextCursor);
  for (const row of first.body.revisions) {
    assert.equal(typeof row.createdAt, 'number');
    assert.equal(typeof row.source, 'string');
    assert.equal(typeof row.current, 'boolean');
    assert.equal(row.current, row.revision === '3');
    for (const forbidden of ['htmlContent', 'title', 'description', 'snapshotHash', 'actor', 'password', 'favorite', 'grants', 'url']) {
      assert.equal(forbidden in row, false, `history metadata excludes ${forbidden}`);
    }
  }
  const next = await request(`${path}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, { headers: keyHeader(readKey.secret) });
  assert.equal(next.status, 200);
  assert.deepEqual(next.body.revisions.map(row => row.revision), ['1']);
  assert.equal(next.body.nextCursor, undefined);
  for (const invalid of ['!!!', 'W10', 'eyJyIjoiMDAxIn0']) {
    const rejected = await request(`${path}?cursor=${encodeURIComponent(invalid)}`, { headers: keyHeader(readKey.secret) });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'INVALID_CURSOR');
  }

  const single = await request(`${path}/1`, { headers: keyHeader(readKey.secret) });
  assert.equal(single.status, 200);
  assert.equal(single.body.revision.htmlContent, '<h1>body marker v1</h1>');
  assert.equal(single.body.revision.title, 'History target');
  assert.equal(single.body.revision.revision, '1');
  assert.equal(single.body.revision.current, false);
  assert.equal('url' in single.body.revision, false, 'history snapshots do not add a public URL field');
  assert.equal((await request(`${path}/999`, { headers: keyHeader(readKey.secret) })).status, 404);
  assert.equal((await request(`${path}/01`, { headers: keyHeader(readKey.secret) })).status, 400);

  const purged = await request(`/admin/pages/${share.urlId}/revisions/1/purge`, {
    method: 'POST', body: { confirm: `${share.urlId}:1` }
  });
  assert.equal(purged.status, 200, purged.text);

  const afterPurge = await request(path, { headers: keyHeader(readKey.secret) });
  const tombstone = afterPurge.body.revisions.find(row => row.revision === '1');
  assert.ok(tombstone);
  assert.equal(tombstone.purged, true);
  assert.equal(tombstone.current, false);
  assert.equal('title' in tombstone, false);
  const gone = await request(`${path}/1`, { headers: keyHeader(readKey.secret) });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'REVISION_PURGED');
  for (const secret of ['body marker v1', 'History target', 'snapshotHash', 'htmlContent', 'title', 'description']) {
    assert.equal(gone.text.includes(secret), false, `tombstone response excludes ${secret}`);
  }
});

test('history defaults to 20, caps at 100, and a cursor walk excludes concurrent higher revisions', async () => {
  const key = await createKey('issue38 cursor key');
  const share = await createShare({ title: 'Cursor v1' });
  assert.equal((await grant(key, share.urlId)).status, 201);
  const repository = app.locals.pageRepository;
  for (let revision = 1; revision < 25; revision += 1) {
    await edit(repository, share.urlId, revision, {
      htmlContent: `<h1>cursor ${revision + 1}</h1>`, title: `Cursor v${revision + 1}`
    });
  }

  const path = `/api/v1/shares/${share.urlId}/revisions`;
  const first = await request(path, { headers: keyHeader(key.secret) });
  assert.equal(first.status, 200);
  assert.equal(first.body.revisions.length, 20);
  assert.equal(first.body.revisions[0].revision, '25');
  assert.ok(first.body.nextCursor);
  await edit(repository, share.urlId, 25, { htmlContent: '<h1>cursor 26</h1>', title: 'Cursor v26' });

  const seen = first.body.revisions.map(row => row.revision);
  let cursor = first.body.nextCursor;
  while (cursor) {
    const page = await request(`${path}?cursor=${encodeURIComponent(cursor)}`, { headers: keyHeader(key.secret) });
    assert.equal(page.status, 200);
    seen.push(...page.body.revisions.map(row => row.revision));
    cursor = page.body.nextCursor;
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  assert.equal(seen.includes('26'), false, 'new higher revision does not shift the existing cursor walk');
  assert.deepEqual(seen, Array.from({ length: 25 }, (_, index) => String(25 - index)));

  const maximum = await request(`${path}?limit=100`, { headers: keyHeader(key.secret) });
  assert.equal(maximum.body.revisions.length, 26);
  assert.equal(maximum.body.nextCursor, undefined);
  for (const invalid of ['0', '101', '1.5']) {
    const response = await request(`${path}?limit=${invalid}`, { headers: keyHeader(key.secret) });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_LIMIT');
  }
});

test('managed Key restore is conditional, replayable, no-op safe and keeps access policy', async () => {
  const key = await createKey('issue38 edit key');
  const share = await createShare({
    title: 'Restore v1',
    htmlContent: '# exact v1\r\nbody',
    codeType: 'markdown',
    markdownTheme: 'github'
  });
  assert.equal((await grant(key, share.urlId, true)).status, 201);
  const repository = app.locals.pageRepository;
  const pageBefore = await repository.getById(share.urlId);
  await repository.updateProtection(share.urlId, {
    isProtected: true, passwordHash: 'synthetic-password-hash', encryptedPassword: 'synthetic-encrypted-password',
    expectedAccessRevision: String(pageBefore.access_revision)
  });
  let accessPage = await repository.getById(share.urlId);
  await repository.updatePage(share.urlId, {
    expiresAt: Date.now() - 1000, expectedAccessRevision: String(accessPage.access_revision)
  });
  accessPage = await repository.getById(share.urlId);
  await repository.setPublished(share.urlId, {
    published: false, expectedAccessRevision: String(accessPage.access_revision)
  });
  await repository.setFavorite(share.urlId, true);
  const policyBefore = await repository.getById(share.urlId);
  const privateHistory = await request(`/api/v1/shares/${share.urlId}/revisions`, { headers: keyHeader(key.secret) });
  assert.equal(privateHistory.status, 200, 'management history ignores protected, expired and unpublished public policy');
  assert.equal(privateHistory.body.revisions.length, 1);

  await edit(repository, share.urlId, 1, {
    htmlContent: '# changed v2\nbody', title: 'Restore v2', description: 'v2 description', markdownTheme: 'claude'
  });
  const current = await request(`/api/v1/shares/${share.urlId}/content`, { headers: keyHeader(key.secret) });
  assert.equal(current.status, 200);
  const path = `/api/v1/shares/${share.urlId}/restore`;
  const requestId = 'issue38-restore-main-0001';
  const body = { revision: '1' };

  const missingId = await request(path, { method: 'POST', headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag') }, body });
  assert.equal(missingId.status, 428);
  const missingMatch = await request(path, { method: 'POST', headers: { 'X-API-Key': key.secret, 'Idempotency-Key': 'issue38-restore-main-0002' }, body });
  assert.equal(missingMatch.status, 428);
  for (const invalid of ['*', 'W/' + current.headers.get('etag'), '"access:any:1"']) {
    const rejected = await request(path, {
      method: 'POST', headers: { 'X-API-Key': key.secret, 'If-Match': invalid, 'Idempotency-Key': 'issue38-restore-main-0003' }, body
    });
    assert.equal(rejected.status, 400);
  }
  for (const revision of ['0', '01', '1.0', '-1', '9223372036854775808', 9007199254740992, null]) {
    const rejected = await request(path, {
      method: 'POST', headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag'), 'Idempotency-Key': `issue38-invalid-source-${Math.random().toString(36).slice(2, 12)}` },
      body: { revision }
    });
    assert.equal(rejected.status, 400, String(revision));
  }
  const unknownField = await request(path, {
    method: 'POST', headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag'), 'Idempotency-Key': 'issue38-restore-extra-0001' },
    body: { revision: '1', published: true }
  });
  assert.equal(unknownField.status, 400);

  const restored = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': current.headers.get('etag'), 'Idempotency-Key': requestId },
    body
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body.action, 'restore');
  assert.equal(restored.body.changed, true);
  assert.equal(restored.body.page.currentRevision, '3');
  assert.equal(restored.body.page.htmlContent, '# exact v1\r\nbody');
  assert.equal(restored.body.page.title, 'Restore v1');
  assert.equal(restored.body.page.codeType, 'markdown');
  assert.equal(restored.body.page.markdownTheme, 'github');
  const restoreRevision = await repository.getContentRevision(share.urlId, '3');
  assert.equal(restoreRevision.source, 'api-restore');
  assert.equal(restoreRevision.actor, `api-key:${key.id}`);
  assert.equal(restoreRevision.restored_from, '1');
  const restoreAudit = (await repository.listAuditLogs()).find(log =>
    log.action === 'page.restore' && log.pageId === share.urlId);
  assert.ok(restoreAudit);
  assert.deepEqual(JSON.parse(restoreAudit.details), {
    sourceRevision: '1', revision: '3', changed: true, source: 'api'
  });
  assert.match(restored.headers.get('etag'), /:3"$/);
  assert.equal(restored.headers.get('cache-control'), 'private, no-store');
  const policyAfter = await repository.getById(share.urlId);
  for (const field of ['access_revision', 'is_protected', 'expires_at', 'published', 'is_favorite', 'view_count']) {
    assert.equal(policyAfter[field], policyBefore[field], `restore leaves ${field} unchanged`);
  }

  const noop = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '3'), 'Idempotency-Key': 'issue38-restore-noop-0001' },
    body
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);
  assert.equal(noop.body.page.currentRevision, '3', 'unchanged restore creates no revision');

  const smallBodyBytes = 16 * 1024;
  const validRestoreJson = JSON.stringify(body);
  const exactLimitBody = validRestoreJson + ' '.repeat(smallBodyBytes - Buffer.byteLength(validRestoreJson));
  assert.equal(Buffer.byteLength(exactLimitBody), smallBodyBytes);
  const exactLimit = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '3'), 'Idempotency-Key': 'issue38-restore-16k-0001' },
    rawBody: exactLimitBody
  });
  assert.equal(exactLimit.status, 200, exactLimit.text);
  assert.equal(exactLimit.body.changed, false);

  const overLimitBody = validRestoreJson + ' '.repeat(smallBodyBytes + 1 - Buffer.byteLength(validRestoreJson));
  assert.equal(Buffer.byteLength(overLimitBody), smallBodyBytes + 1);
  const overLimit = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '3'), 'Idempotency-Key': 'issue38-restore-16k-0002' },
    rawBody: overLimitBody
  });
  assert.equal(overLimit.status, 413);
  assert.equal(overLimit.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(overLimit.body.requestId, 'issue38-restore-16k-0002');
  assert.equal(overLimit.body.retryable, false);

  await edit(repository, share.urlId, 3, { htmlContent: '# later v4', title: 'Later v4', markdownTheme: 'claude' });
  const replay = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '2'), 'Idempotency-Key': requestId },
    body
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true, 'committed result replays before stale If-Match CAS');
  assert.equal(replay.body.page.currentRevision, '3');
  assert.equal(replay.body.page.htmlContent, '# exact v1\r\nbody', 'replay returns its original result snapshot');

  const conflict = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '2'), 'Idempotency-Key': requestId },
    body: { revision: '2' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_ID_CONFLICT');

  const anonymousStatus = await request('/api/v1/operations/' + requestId);
  assert.equal(anonymousStatus.status, 401);
  assert.equal(anonymousStatus.body.requestId, requestId);
  assert.equal(anonymousStatus.body.retryable, false);
  const invalidStatus = await request('/api/v1/operations/invalid', { headers: keyHeader(key.secret) });
  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatus.body.requestId, null);

  const status = await request('/api/v1/operations/' + requestId, { headers: keyHeader(key.secret) });
  assert.equal(status.status, 200);
  assert.equal(status.body.operations[0].action, 'restore');
  assert.equal(status.body.operations[0].revision, '3');
  for (const forbidden of ['htmlContent', 'exact v1', 'title', 'description', 'receipt', 'sourceRevision', 'url']) {
    assert.equal(status.text.includes(forbidden), false, `operation status excludes ${forbidden}`);
  }
  const unrelatedKey = await createKey('issue38 unrelated key');
  assert.equal((await request('/api/v1/operations/' + requestId, { headers: keyHeader(unrelatedKey.secret) })).status, 404,
    'operation IDs are isolated to the current Key namespace');

  const purged = await request(`/admin/pages/${share.urlId}/revisions/1/purge`, {
    method: 'POST', body: { confirm: `${share.urlId}:1` }
  });
  assert.equal(purged.status, 200, purged.text);
  const replayAfterSourcePurge = await request(path, {
    method: 'POST',
    headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '2'), 'Idempotency-Key': requestId },
    body
  });
  assert.equal(replayAfterSourcePurge.status, 410);
  assert.equal(replayAfterSourcePurge.body.code, 'RESULT_UNAVAILABLE');
  for (const forbidden of ['exact v1', 'Restore v1', 'htmlContent', 'title', 'receipt']) {
    assert.equal(replayAfterSourcePurge.text.includes(forbidden), false);
  }
  const unavailableStatus = await request('/api/v1/operations/' + requestId, { headers: keyHeader(key.secret) });
  assert.equal(unavailableStatus.status, 410);
  assert.equal(unavailableStatus.body.code, 'RESULT_UNAVAILABLE');
});

test('history and restore errors do not expose resources without current scope and grant', async () => {
  const key = await createKey('issue38 revoked key');
  const share = await createShare({ title: 'Denied history' });
  const readGrant = await grant(key, share.urlId);
  assert.equal(readGrant.status, 201);
  const noEdit = await request(`/api/v1/shares/${share.urlId}/restore`, {
    method: 'POST', headers: { 'X-API-Key': key.secret, 'If-Match': etag(share.urlId, '1'), 'Idempotency-Key': 'issue38-restore-noedit-0001' },
    body: { revision: '1' }
  });
  assert.equal(noEdit.status, 403);

  await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'PUT', body: { canUpdate: true } });
  await request(`/admin/apis/keys/${key.id}/grants/${share.urlId}`, { method: 'PUT', body: { canUpdate: false } });
  const noGrantReplay = await request('/api/v1/operations/issue38-restore-never-made-0001', { headers: keyHeader(key.secret) });
  assert.equal(noGrantReplay.status, 404);
  const unknownSource = await request(`/api/v1/shares/${share.urlId}/revisions/9`, { headers: keyHeader(key.secret) });
  assert.equal(unknownSource.status, 404);
});
