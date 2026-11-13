const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'access-revision-key';
process.env.SESSION_SECRET = 'access-revision-secret';

const app = require('../app');
const {
  createScopedToken,
  encryptSecret,
  hashSecret
} = require('../utils/security');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
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
    }, (res) => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(path, method, body, headers = {}) {
  return request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function seedPage({ id, password = null, expiresAt = null }) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: `<h1>secret-body-${id}</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: id,
    description: null,
    expiresAt,
    markdownTheme: null
  });
}

async function unlock(id, password) {
  const response = await jsonRequest(`/view/${id}/password`, 'POST', { password });
  assert.equal(response.status, 200);
  assert.equal(response.body.valid, true);
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

async function revisionOf(id) {
  const page = await app.locals.pageRepository.getById(id);
  return page.access_revision;
}

test('new shares start at access revision 1 and unlock issues a revision-bound cookie', async () => {
  await seedPage({ id: 't01-basic', password: 'First1!' });

  assert.equal(await revisionOf('t01-basic'), '1');

  const cookie = await unlock('t01-basic', 'First1!');
  const token = cookie.slice(`page_access_t01-basic=`.length);
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

  assert.equal(payload.id, 't01-basic');
  assert.equal(payload.accessRevision, '1');
  assert.ok(payload.exp - payload.iat <= 24 * 60 * 60 * 1000);

  const view = await request('/view/t01-basic', { headers: { Cookie: cookie } });
  assert.equal(view.status, 200);
  assert.match(view.text, /secret-body-t01-basic/);

  const counted = await viewEvent('t01-basic', cookie);
  assert.equal(counted.status, 204);
  assert.equal((await app.locals.pageRepository.getById('t01-basic')).view_count, 1);
});

test('changing the password through the protect entry revokes the old cookie for body and view events', async () => {
  await seedPage({ id: 't01-rotate', password: 'First1!' });
  await seedPage({ id: 't01-bystander', password: 'Other1!' });

  const oldCookie = await unlock('t01-rotate', 'First1!');
  const bystanderCookie = await unlock('t01-bystander', 'Other1!');

  const rotated = await jsonRequest('/api/pages/t01-rotate/protect', 'POST', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: '1'
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.accessRevision, '2');
  assert.equal(await revisionOf('t01-rotate'), '2');

  // The counterexample from the parent spec: the old cookie used to still
  // read the body and report views after a password change.
  const staleView = await request('/view/t01-rotate', { headers: { Cookie: oldCookie } });
  assert.equal(staleView.status, 200);
  assert.doesNotMatch(staleView.text, /secret-body-t01-rotate/);
  assert.match(staleView.text, /此内容受密码保护/);

  const staleEvent = await viewEvent('t01-rotate', oldCookie);
  assert.equal(staleEvent.status, 403);
  assert.equal((await app.locals.pageRepository.getById('t01-rotate')).view_count, 0);

  // The new password mints a current-revision cookie that works.
  const newCookie = await unlock('t01-rotate', 'Second2@');
  const freshView = await request('/view/t01-rotate', { headers: { Cookie: newCookie } });
  assert.match(freshView.text, /secret-body-t01-rotate/);
  assert.equal((await viewEvent('t01-rotate', newCookie)).status, 204);

  // Another Share is completely unaffected by the rotation.
  assert.equal(await revisionOf('t01-bystander'), '1');
  const bystanderView = await request('/view/t01-bystander', { headers: { Cookie: bystanderCookie } });
  assert.match(bystanderView.text, /secret-body-t01-bystander/);
});

test('legacy unversioned access cookies are rejected and must unlock again', async () => {
  await seedPage({ id: 't01-legacy', password: 'First1!' });

  const legacyToken = createScopedToken('page-access', { id: 't01-legacy' }, 60_000);
  const legacyCookie = `page_access_t01-legacy=${legacyToken}`;

  const view = await request('/view/t01-legacy', { headers: { Cookie: legacyCookie } });
  assert.doesNotMatch(view.text, /secret-body-t01-legacy/);
  assert.match(view.text, /此内容受密码保护/);

  const event = await viewEvent('t01-legacy', legacyCookie);
  assert.equal(event.status, 403);
  assert.equal((await app.locals.pageRepository.getById('t01-legacy')).view_count, 0);
});

test('protect entry enforces the expectedAccessRevision precondition', async () => {
  await seedPage({ id: 't01-precondition', password: 'First1!' });

  const missing = await jsonRequest('/api/pages/t01-precondition/protect', 'POST', {
    isProtected: true,
    password: 'Second2@'
  });
  assert.equal(missing.status, 428);

  const stale = await jsonRequest('/api/pages/t01-precondition/protect', 'POST', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: '99'
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.accessRevision, '1');

  const invalid = await jsonRequest('/api/pages/t01-precondition/protect', 'POST', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: 'v1'
  });
  assert.equal(invalid.status, 400);

  // None of the rejected attempts changed the policy.
  assert.equal(await revisionOf('t01-precondition'), '1');
  await unlock('t01-precondition', 'First1!');
});

test('turning protection off and on again does not resurrect the old cookie', async () => {
  await seedPage({ id: 't01-off-on', password: 'First1!' });
  const oldCookie = await unlock('t01-off-on', 'First1!');

  const off = await jsonRequest('/api/pages/t01-off-on/protect', 'POST', {
    isProtected: false,
    expectedAccessRevision: '1'
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.accessRevision, '2');

  const on = await jsonRequest('/api/pages/t01-off-on/protect', 'POST', {
    isProtected: true,
    password: 'Third3#',
    expectedAccessRevision: '2'
  });
  assert.equal(on.status, 200);
  assert.equal(on.body.accessRevision, '3');

  const staleView = await request('/view/t01-off-on', { headers: { Cookie: oldCookie } });
  assert.doesNotMatch(staleView.text, /secret-body-t01-off-on/);
  assert.equal((await viewEvent('t01-off-on', oldCookie)).status, 403);
});

test('a credential minted from a pre-rotation read carries the old revision and fails after rotation', async () => {
  await seedPage({ id: 't01-mint-race', password: 'First1!' });

  // Simulate a password verification that read revision 1 (together with the
  // hash) and then, after a rotation to revision 2, presents the credential
  // it minted from that read. It must not be upgraded to the latest revision.
  const rotated = await jsonRequest('/api/pages/t01-mint-race/protect', 'POST', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: '1'
  });
  assert.equal(rotated.status, 200);

  const staleMinted = createScopedToken('page-access', {
    id: 't01-mint-race',
    accessRevision: '1'
  }, 60_000);
  const view = await request('/view/t01-mint-race', {
    headers: { Cookie: `page_access_t01-mint-race=${staleMinted}` }
  });
  assert.doesNotMatch(view.text, /secret-body-t01-mint-race/);
});

test('admin save: content-only needs no precondition and does not advance; access changes require it and revoke', async () => {
  await seedPage({ id: 't01-admin', password: 'First1!' });
  const oldCookie = await unlock('t01-admin', 'First1!');

  const contentOnly = await jsonRequest('/admin/pages/t01-admin', 'PUT', {
    title: 'Renamed title'
  });
  assert.equal(contentOnly.status, 200);
  assert.equal(contentOnly.body.page.accessRevision, '1');
  assert.equal(await revisionOf('t01-admin'), '1');

  const missing = await jsonRequest('/admin/pages/t01-admin', 'PUT', {
    isProtected: true,
    password: 'Second2@'
  });
  assert.equal(missing.status, 428);

  const stale = await jsonRequest('/admin/pages/t01-admin', 'PUT', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: '7'
  });
  assert.equal(stale.status, 412);

  const changed = await jsonRequest('/admin/pages/t01-admin', 'PUT', {
    isProtected: true,
    password: 'Second2@',
    expectedAccessRevision: '1'
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.page.accessRevision, '2');

  const staleView = await request('/view/t01-admin', { headers: { Cookie: oldCookie } });
  assert.doesNotMatch(staleView.text, /secret-body-t01-admin/);
});

test('admin expiry change advances the revision and revokes; unchanged expiry does not', async () => {
  const firstExpiry = Date.now() + 3_600_000;
  const secondExpiry = Date.now() + 7_200_000;
  await seedPage({ id: 't01-expiry', password: 'First1!', expiresAt: firstExpiry });
  const cookie = await unlock('t01-expiry', 'First1!');

  const unchanged = await jsonRequest('/admin/pages/t01-expiry', 'PUT', {
    isProtected: true,
    expiresAt: firstExpiry,
    expectedAccessRevision: '1'
  });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.page.accessRevision, '1');

  const changed = await jsonRequest('/admin/pages/t01-expiry', 'PUT', {
    isProtected: true,
    expiresAt: secondExpiry,
    expectedAccessRevision: '1'
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.page.accessRevision, '2');

  const staleView = await request('/view/t01-expiry', { headers: { Cookie: cookie } });
  assert.doesNotMatch(staleView.text, /secret-body-t01-expiry/);
});

test('admin revoke-access entry revokes without changing password or content', async () => {
  await seedPage({ id: 't01-revoke', password: 'First1!' });
  const cookie = await unlock('t01-revoke', 'First1!');

  const missing = await jsonRequest('/admin/pages/t01-revoke/revoke-access', 'POST', {});
  assert.equal(missing.status, 428);

  const stale = await jsonRequest('/admin/pages/t01-revoke/revoke-access', 'POST', {
    expectedAccessRevision: '5'
  });
  assert.equal(stale.status, 412);

  const revoked = await jsonRequest('/admin/pages/t01-revoke/revoke-access', 'POST', {
    expectedAccessRevision: '1'
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.accessRevision, '2');

  const staleView = await request('/view/t01-revoke', { headers: { Cookie: cookie } });
  assert.doesNotMatch(staleView.text, /secret-body-t01-revoke/);
  assert.equal((await viewEvent('t01-revoke', cookie)).status, 403);

  // Password and content are untouched: the same password unlocks again.
  const freshCookie = await unlock('t01-revoke', 'First1!');
  const freshView = await request('/view/t01-revoke', { headers: { Cookie: freshCookie } });
  assert.match(freshView.text, /secret-body-t01-revoke/);
});

test('favorite changes do not advance the access revision', async () => {
  await seedPage({ id: 't01-favorite', password: 'First1!' });
  const repository = app.locals.pageRepository;

  const result = await repository.setFavorite('t01-favorite', true);
  assert.equal(result.changed, true);
  assert.equal(await revisionOf('t01-favorite'), '1');
});

test('admin detail and metadata expose the access revision as a decimal string', async () => {
  await seedPage({ id: 't01-expose', password: 'First1!' });

  const metadata = await request('/api/pages/t01-expose');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.page.accessRevision, '1');

  const detail = await request('/admin/pages/t01-expose');
  assert.equal(detail.status, 200);
  assert.match(detail.text, /"accessRevision":"1"/);
  assert.match(detail.text, /id="revoke-access-btn"/);
  assert.match(detail.text, /撤销已解锁访问/);
});
