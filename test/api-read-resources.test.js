// #36 — Read-only resource APIs: stable cursor pagination under insertion,
// separate strong ETags with 304 semantics, strict input validation and the
// list's metadata-only shape.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'issue36-read-legacy';
process.env.SESSION_SECRET = 'issue36-read-resources-secret';

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
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 304 has no body */ }
  return { status: response.status, headers: response.headers, text, body: json };
}

async function createKey(name) {
  const created = await request('/admin/apis/keys', { method: 'POST', body: { name } });
  assert.equal(created.status, 201);
  return created.body.apiKey;
}

async function createShare(title) {
  const created = await request('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': 'issue36-read-legacy' },
    body: { htmlContent: `<h1>${title}</h1>`, title }
  });
  assert.equal(created.status, 200);
  return created.body.urlId;
}

test('pagination: default 20, max 100, invalid limit and cursor are 400, last page has no cursor', async () => {
  const key = await createKey('pagination key');
  const shareIds = [];
  for (let index = 1; index <= 3; index += 1) {
    const shareId = await createShare(`Pagination ${index}`);
    shareIds.push(shareId);
    await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId } });
  }

  assert.equal((await request('/api/v1/shares?limit=0', { headers: { 'X-API-Key': key.secret } })).status, 400);
  assert.equal((await request('/api/v1/shares?limit=101', { headers: { 'X-API-Key': key.secret } })).status, 400);
  assert.equal((await request('/api/v1/shares?limit=abc', { headers: { 'X-API-Key': key.secret } })).status, 400);
  assert.equal((await request('/api/v1/shares?limit=-20', { headers: { 'X-API-Key': key.secret } })).status, 400);
  assert.equal((await request('/api/v1/shares?limit=100', { headers: { 'X-API-Key': key.secret } })).status, 200, 'the documented maximum itself is legal');

  for (const bad of ['!!!', 'eyJhIjox', 'W10=', 'eysic29ydCI6ImRlc2MifQ', 'x'.repeat(400)]) {
    const badCursor = await request(`/api/v1/shares?cursor=${encodeURIComponent(bad)}`, { headers: { 'X-API-Key': key.secret } });
    assert.equal(badCursor.status, 400, `cursor ${bad} rejected`);
    assert.equal(badCursor.body.code, 'INVALID_CURSOR');
    assert.ok(!/SELECT|ORDER/i.test(badCursor.body.error || ''), 'error text carries no SQL fragment');
  }

  const full = await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } });
  assert.equal(full.status, 200);
  assert.equal(full.body.shares.length, 3);
  assert.equal(full.body.nextCursor, undefined, 'a page smaller than the limit has no next cursor');
});

test('cursor is stable under insertion: rows are never skipped or duplicated', async () => {
  const key = await createKey('cursor stability key');
  const seen = [];
  for (let index = 1; index <= 4; index += 1) {
    const shareId = await createShare(`Cursor ${index}`);
    await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId } });
    if (index <= 2) seen.push(shareId); // first page reads the two oldest
  }

  const page1 = await request('/api/v1/shares?limit=2', { headers: { 'X-API-Key': key.secret } });
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.body.shares.map(row => row.id), seen, 'oldest first, deterministic order');
  assert.ok(page1.body.nextCursor, 'full page carries a cursor');

  // A NEW grant lands while the client is between pages: it must show up
  // later in the walk, never displace or duplicate existing rows.
  const latecomer = await createShare('Cursor Latecomer');
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId: latecomer } });

  const page2 = await request(`/api/v1/shares?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(page2.status, 200);
  const page2Ids = page2.body.shares.map(row => row.id);
  let walked = [...page1.body.shares.map(row => row.id), ...page2Ids];
  assert.equal(new Set(walked).size, walked.length, 'no duplicates across pages');
  // page2 was a full page, so the walk continues; the latecomer joins the
  // tail without ever displacing earlier rows.
  const page3 = await request(`/api/v1/shares?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(page3.status, 200);
  walked = [...walked, ...page3.body.shares.map(row => row.id)];
  assert.equal(page3.body.nextCursor, undefined, 'last page terminates the walk');
  assert.equal(new Set(walked).size, walked.length, 'still no duplicates');
  assert.deepEqual([...walked].sort(), [...seen, ...page2Ids.filter(id => !seen.includes(id)), latecomer].sort(), 'every granted Share is reached exactly once');
});

test('content and state carry separate strong ETags with honest 304 semantics', async () => {
  const key = await createKey('etag key');
  const shareId = await createShare('ETag Share');
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId } });

  const content = await request(`/api/v1/shares/${shareId}/content`, { headers: { 'X-API-Key': key.secret } });
  const contentEtag = content.headers.get('etag');
  assert.match(contentEtag, new RegExp(`^"content:${shareId}:1"$`));

  const state = await request(`/api/v1/shares/${shareId}/state`, { headers: { 'X-API-Key': key.secret } });
  const stateEtag = state.headers.get('etag');
  assert.match(stateEtag, new RegExp(`^"access:${shareId}:1"$`));
  assert.notEqual(contentEtag, stateEtag, 'the two validator families never collide');

  const revalidate = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': contentEtag }
  });
  assert.equal(revalidate.status, 304);
  assert.equal(revalidate.text, '', '304 has no body');
  assert.equal(revalidate.headers.get('etag'), contentEtag);

  const revalidateState = await request(`/api/v1/shares/${shareId}/state`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': stateEtag }
  });
  assert.equal(revalidateState.status, 304);

  // Cross-family and stale tags answer 200 again, never a false 304.
  assert.equal((await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': stateEtag }
  })).status, 200, 'a state tag never validates content');

  // Wildcard means "already have it" per RFC; GET If-None-Match uses weak
  // comparison, so a weakly-tagged current validator is a 304 (RFC 9110
  // §13.1.2). The WRITE-side If-Match protocol stays strong-only.
  assert.equal((await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': '*' }
  })).status, 304);
  assert.equal((await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': `W/${contentEtag}` }
  })).status, 304, 'weak comparison validates the current tag for GETs');

  // A dashboard content save bumps the content tag and 304 stops matching.
  const repository = app.locals.pageRepository;
  const saved = await repository.updatePage(shareId, {
    htmlContent: '<h1>ETag Share v2</h1>',
    title: 'ETag Share v2',
    expectedContentRevision: '1'
  });
  assert.ok(saved, 'content save commits');

  const stale = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': contentEtag }
  });
  assert.equal(stale.status, 200, 'stale tag serves fresh content');
  assert.equal(stale.body.revision, '2');
  assert.match(stale.headers.get('etag'), new RegExp(`^"content:${shareId}:2"$`));

  // Protection change bumps the ACCESS tag while the content tag holds.
  const stateBefore = await request(`/api/v1/shares/${shareId}/state`, { headers: { 'X-API-Key': key.secret } });
  const protectedEtag = stateBefore.headers.get('etag');
  await app.locals.pageRepository.updateProtection(shareId, { isProtected: true, expectedAccessRevision: '1' });
  const stateAfter = await request(`/api/v1/shares/${shareId}/state`, { headers: { 'X-API-Key': key.secret } });
  assert.notEqual(stateAfter.headers.get('etag'), protectedEtag, 'policy change moves the access validator');
  assert.equal(stateAfter.body.isProtected, true);
  const contentAfter = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': stale.headers.get('etag') }
  });
  assert.equal(contentAfter.status, 304, 'policy change does NOT move the content validator');
});

test('list is metadata-only: never the body, never policy secrets', async () => {
  const key = await createKey('shape key');
  const shareId = await createShare('Shape Probe');
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId } });

  const list = await request('/api/v1/shares', { headers: { 'X-API-Key': key.secret } });
  assert.equal(list.status, 200);
  const row = list.body.shares.find(item => item.id === shareId);
  assert.ok(row, 'granted share listed');
  for (const field of ['id', 'createdAt', 'codeType', 'title', 'description', 'markdownTheme', 'currentRevision', 'accessRevision', 'published', 'isProtected', 'expiresAt']) {
    assert.ok(field in row, `list exposes ${field}`);
  }
  for (const forbidden of ['htmlContent', 'password', 'encrypted', 'favorite', 'viewCount', 'grants']) {
    assert.ok(!(forbidden in row), `list never exposes ${forbidden}`);
  }
  assert.equal(typeof row.currentRevision, 'string', 'revisions travel as decimal strings');
  assert.equal(typeof row.accessRevision, 'string');
});

test('If-None-Match uses RFC9110 weak comparison for GETs: W/ tags and multi-tag lists validate (St5)', async () => {
  const key = await createKey('weak etag key');
  const shareId = await createShare('Weak ETag Share');
  await request(`/admin/apis/keys/${key.id}/grants`, { method: 'POST', body: { shareId } });

  const content = await request(`/api/v1/shares/${shareId}/content`, { headers: { 'X-API-Key': key.secret } });
  assert.equal(content.status, 200);
  const etag = content.headers.get('etag');

  // A weakly-tagged current ETag validates under weak comparison.
  const weak = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': `W/${etag}` }
  });
  assert.equal(weak.status, 304, 'W/<current strong tag> is a 304 for GET');

  // Multi-tag headers: 304 when ANY listed tag matches weakly.
  const multi = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': `"content:${shareId}:999", ${etag}` }
  });
  assert.equal(multi.status, 304, 'a matching tag inside a list yields 304');

  // A list with no matching tag still serves 200.
  const miss = await request(`/api/v1/shares/${shareId}/content`, {
    headers: { 'X-API-Key': key.secret, 'If-None-Match': `"content:${shareId}:999", "access:${shareId}:1"` }
  });
  assert.equal(miss.status, 200, 'a non-matching list serves fresh content');

  // Strong exact match stays 304 and a stale strong tag stays 200.
  assert.equal((await request(`/api/v1/shares/${shareId}/content`, { headers: { 'X-API-Key': key.secret, 'If-None-Match': etag } })).status, 304);
  assert.equal((await request(`/api/v1/shares/${shareId}/content`, { headers: { 'X-API-Key': key.secret, 'If-None-Match': `"content:${shareId}:999"` } })).status, 200);
});
