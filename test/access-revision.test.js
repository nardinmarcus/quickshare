const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue25-synthetic-session-secret';
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const app = require('../app');
const { createScopedToken, verifyScopedToken } = require('../utils/security');
let server;
let origin;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function request(path, method = 'GET', body, cookie) {
  return fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function create() {
  const res = await request('/api/pages/create', 'POST', {
    htmlContent: '<h1>ISSUE25 PRIVATE BODY</h1>', codeType: 'html', isProtected: true, password: 'Old123'
  });
  assert.equal(res.status, 200);
  return (await res.json()).urlId;
}
async function unlock(id, password = 'Old123') {
  const res = await request(`/view/${id}/password`, 'POST', { password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('legacy, wrong-Share and stale cookies never grant protected access and unlock retains 24h TTL', async () => {
  const id = await create();
  const other = await create();
  const cookie = await unlock(id);
  const payload = verifyScopedToken(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)), 'page-access');
  assert.equal(payload.accessRevision, '1');
  const unlockResponse = await request(`/view/${id}/password`, 'POST', { password: 'Old123' });
  assert.match(unlockResponse.headers.get('set-cookie'), /Max-Age=86400/);
  const legacy = `page_access_${id}=${createScopedToken('page-access', { id }, 86400000)}`;
  const wrongShare = `page_access_${other}=${cookie.slice(cookie.indexOf('=') + 1)}`;
  for (const [target, value] of [[id, legacy], [other, wrongShare]]) {
    const response = await request(`/view/${target}`, 'GET', undefined, value);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /ISSUE25 PRIVATE BODY/);
    assert.match(text, /重新输入密码/);
    assert.equal((await request(`/view/${target}/view-event`, 'POST', undefined, value)).status, 403);
  }
});

test('off then on, expiry change and explicit revoke advance only the target Share policy', async () => {
  const id = await create();
  const other = await create();
  const originalCookie = await unlock(id);
  const otherCookie = await unlock(other);
  let res = await request(`/api/pages/${id}/protect`, 'POST', { isProtected: false, expectedAccessRevision: '1' });
  assert.equal((await res.json()).accessRevision, '2');
  assert.match(await (await request(`/view/${id}`)).text(), /ISSUE25 PRIVATE BODY/);
  res = await request(`/api/pages/${id}/protect`, 'POST', { isProtected: true, password: 'Old123', expectedAccessRevision: '2' });
  assert.equal((await res.json()).accessRevision, '3');
  assert.doesNotMatch(await (await request(`/view/${id}`, 'GET', undefined, originalCookie)).text(), /ISSUE25 PRIVATE BODY/);
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, originalCookie)).status, 403);
  const beforeExpiry = await unlock(id);
  const expiresAt = Date.now() + 3600000;
  res = await request(`/admin/pages/${id}`, 'PUT', { expiresAt, expectedAccessRevision: '3' });
  assert.equal((await res.json()).page.accessRevision, '4');
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, beforeExpiry)).status, 403);
  res = await request(`/admin/pages/${id}`, 'PUT', { expiresAt, isProtected: true, expectedAccessRevision: '4' });
  assert.equal((await res.json()).page.accessRevision, '4', 'unchanged policy does not bump');
  const beforeRevoke = await unlock(id);
  res = await request(`/admin/pages/${id}`, 'PUT', { revokeAccess: true, expectedAccessRevision: '4' });
  assert.equal((await res.json()).page.accessRevision, '5');
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, beforeRevoke)).status, 403);
  assert.equal((await request(`/view/${other}/view-event`, 'POST', undefined, otherCookie)).status, 204);
  assert.match(await (await request(`/view/${other}`, 'GET', undefined, otherCookie)).text(), /ISSUE25 PRIVATE BODY/);
});

test('content and Favorite Share changes preserve the access baseline and cookie', async () => {
  const id = await create();
  const cookie = await unlock(id);
  const updated = await request(`/admin/pages/${id}`, 'PUT', { htmlContent: 'CONTENT ONLY' });
  assert.equal((await updated.json()).page.accessRevision, '1');
  assert.equal((await request(`/admin/pages/${id}/favorite`, 'PUT', { isFavorite: true })).status, 200);
  assert.match(await (await request(`/admin/pages/${id}`)).text(), /"accessRevision":"1"/);
  assert.match(await (await request(`/view/${id}`, 'GET', undefined, cookie)).text(), /CONTENT ONLY/);
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, cookie)).status, 204);
});

test('access baseline accepts only canonical decimal strings and concurrent policy saves have one winner', async () => {
  const id = await create();
  for (const value of [null, 1, '', '01', '0', '-1', '*', '1,2', '9223372036854775808']) {
    assert.equal((await request(`/admin/pages/${id}`, 'PUT', { revokeAccess: true, expectedAccessRevision: value })).status, 400);
  }
  const responses = await Promise.all(['A', 'B'].map(title => request(`/admin/pages/${id}`, 'PUT', {
    title, revokeAccess: true, expectedAccessRevision: '1'
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 412]);
});

test('password verification racing rotation never signs the new revision with the old password', async () => {
  const id = await create();
  const [unlocking, rotating] = await Promise.all([
    request(`/view/${id}/password`, 'POST', { password: 'Old123' }),
    request(`/admin/pages/${id}`, 'PUT', { isProtected: true, password: 'New123', expectedAccessRevision: '1' })
  ]);
  assert.equal(rotating.status, 200);
  assert.equal(unlocking.status, 200, 'old password request started before rotation');
  const cookie = unlocking.headers.get('set-cookie').split(';')[0];
  const payload = verifyScopedToken(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)), 'page-access');
  assert.equal(payload.accessRevision, '1');
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, cookie)).status, 403);
});

test('revocation completes during password verification without upgrading its unlock cookie', async () => {
  const id = await create();
  const completion = [];
  const [unlocking, revoking] = await Promise.all([
    request(`/view/${id}/password`, 'POST', { password: 'Old123' }).then(r => { completion.push('unlock'); return r; }),
    request(`/admin/pages/${id}`, 'PUT', { revokeAccess: true, expectedAccessRevision: '1' }).then(r => { completion.push('revoke'); return r; })
  ]);
  assert.equal(unlocking.status, 200);
  assert.equal(revoking.status, 200);
  assert.deepEqual(completion, ['revoke', 'unlock'], 'exercise a completed revocation while hash verification is pending');
  const cookie = unlocking.headers.get('set-cookie').split(';')[0];
  const payload = verifyScopedToken(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)), 'page-access');
  assert.equal(payload.accessRevision, '1');
  assert.doesNotMatch(await (await request(`/view/${id}`, 'GET', undefined, cookie)).text(), /ISSUE25 PRIVATE BODY/);
});

test('existing protection API reads its baseline then returns only the committed access revision', async () => {
  const id = await create();
  const metadata = await (await request(`/api/pages/${id}`)).json();
  assert.equal(metadata.page.accessRevision, '1');
  const res = await request(`/api/pages/${id}/protect`, 'POST', { isProtected: false, expectedAccessRevision: metadata.page.accessRevision });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accessRevision, '2');
});

test('owner detail displays its access baseline and explicit revoke control', async () => {
  const id = await create();
  const html = await (await request(`/admin/pages/${id}`)).text();
  assert.match(html, /id="revoke-access-btn"/);
  assert.match(html, /"accessRevision":"1"/);
  assert.match(await (await request('/js/admin-detail.js')).text(), /expectedAccessRevision: originalData.accessRevision/);
});

test('policy preconditions reject missing and stale baselines without partially saving content', async () => {
  const id = await create();
  const missing = await request(`/admin/pages/${id}`, 'PUT', { htmlContent: 'UNSAVED', expiresAt: null });
  assert.equal(missing.status, 428);
  const changed = await request(`/admin/pages/${id}`, 'PUT', { revokeAccess: true, expectedAccessRevision: '1' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).page.accessRevision, '2');
  const stale = await request(`/admin/pages/${id}`, 'PUT', { htmlContent: 'UNSAVED', isProtected: false, expectedAccessRevision: '1' });
  assert.equal(stale.status, 412);
  const cookie = await unlock(id);
  assert.match(await (await request(`/view/${id}`, 'GET', undefined, cookie)).text(), /ISSUE25 PRIVATE BODY/);
  assert.equal((await request(`/api/pages/${id}/protect`, 'POST', { isProtected: false })).status, 428);
  assert.equal((await request(`/api/pages/${id}/protect`, 'POST', { isProtected: false, expectedAccessRevision: '1' })).status, 412);
});

test('rotating Share password revokes old unlock for both content and view events', async () => {
  const id = await create();
  const cookie = await unlock(id);
  assert.match(await (await request(`/view/${id}`, 'GET', undefined, cookie)).text(), /ISSUE25 PRIVATE BODY/);
  const changed = await request(`/admin/pages/${id}`, 'PUT', { isProtected: true, password: 'New123', expectedAccessRevision: '1' });
  assert.equal(changed.status, 200);
  assert.doesNotMatch(await (await request(`/view/${id}`, 'GET', undefined, cookie)).text(), /ISSUE25 PRIVATE BODY/);
  assert.equal((await request(`/view/${id}/view-event`, 'POST', undefined, cookie)).status, 403);
  const freshCookie = await unlock(id, 'New123');
  assert.match(await (await request(`/view/${id}`, 'GET', undefined, freshCookie)).text(), /ISSUE25 PRIVATE BODY/);
});
