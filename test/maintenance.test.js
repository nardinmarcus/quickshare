const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'maint-auth-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'maint-dashboard-password';
process.env.SHARE_API_KEY = 'maint-api-key';
process.env.SESSION_SECRET = 'maint-session-secret';

const app = require('../app');
const { MemoryPageRepository } = require('../models/memory-pages');
const {
  MemoryPublishingGate,
  PublishingPausedError,
  isPublishingPausedError
} = require('../utils/publishing');
const { createCsrfToken, encryptSecret, hashSecret } = require('../utils/security');

const repository = app.locals.pageRepository;

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
      res.on('data', chunk => { text += chunk; });
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
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent('maint-dashboard-password')}`
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function loginAdmin() {
  const response = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent('maint-auth-password')}`
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

function csrfFor(cookie) {
  return createCsrfToken(cookie.slice(cookie.indexOf('=') + 1));
}

async function seedPage({ id, password = null }) {
  await repository.create({
    id,
    htmlContent: `<h1>${id}</h1>`,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: id,
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
}

function assertMaintenance503(response, label) {
  assert.equal(response.status, 503, `${label}: expected 503, got ${response.status} (${response.text})`);
  assert.equal(response.body?.success, false, label);
  assert.equal(response.body?.code, 'maintenance', label);
  assert.equal(response.body?.retryable, true, label);
}

test('publishing writes are unpaused by default and the toggle is audited', async () => {
  const repo = new MemoryPageRepository();

  assert.equal(await repo.getPublishingWritesPaused(), false);

  const paused = await repo.setPublishingWritesPaused({ paused: true, ip: '203.0.113.30' });
  assert.deepEqual(paused, { paused: true, changed: true });
  assert.equal(await repo.getPublishingWritesPaused(), true);

  const repeated = await repo.setPublishingWritesPaused({ paused: true, ip: '203.0.113.31' });
  assert.deepEqual(repeated, { paused: true, changed: false });

  const resumed = await repo.setPublishingWritesPaused({ paused: false, ip: '203.0.113.32' });
  assert.deepEqual(resumed, { paused: false, changed: true });
  assert.equal(await repo.getPublishingWritesPaused(), false);

  const logs = await repo.listAuditLogs();
  const toggleLogs = logs.filter(log => log.action === 'settings.publishing_writes_paused.update');
  assert.equal(toggleLogs.length, 2);
  assert.deepEqual(JSON.parse(toggleLogs[1].details), { from: false, to: true });
  assert.deepEqual(JSON.parse(toggleLogs[0].details), { from: true, to: false });
  assert.equal(toggleLogs[1].ip, '203.0.113.30');

  await assert.rejects(
    repo.setPublishingWritesPaused({ paused: 'yes' }),
    /paused must be a boolean/
  );
});

test('while paused the memory repository refuses every publishing write but keeps reads', async () => {
  const repo = new MemoryPageRepository();
  await repo.create({
    id: 'maint-repo-page',
    htmlContent: '<p>body</p>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Repo page',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
  await repo.createApiKey({
    id: 'maint-repo-key',
    name: 'Key',
    keyHash: 'hash',
    keyPrefix: 'qs.prefix',
    createdAt: Date.now()
  });

  await repo.setPublishingWritesPaused({ paused: true, ip: '203.0.113.40' });

  const writes = [
    () => repo.create({ id: 'maint-repo-new', htmlContent: 'x', createdAt: Date.now() }),
    () => repo.updatePage('maint-repo-page', { title: 'Changed' }),
    () => repo.updatePageWithAccessPolicy('maint-repo-page', { title: 'Changed' }, {}),
    () => repo.updateProtection('maint-repo-page', { isProtected: true, passwordHash: 'h', encryptedPassword: 'e' }),
    () => repo.updateProtectionWithAccessRevision('maint-repo-page', { isProtected: true, passwordHash: 'h', encryptedPassword: 'e' }, {}),
    () => repo.revokeAccess('maint-repo-page', null),
    () => repo.setFavorite('maint-repo-page', true),
    () => repo.deletePage('maint-repo-page'),
    () => repo.deletePages(['maint-repo-page']),
    () => repo.createApiKey({ id: 'maint-repo-key-2', name: 'K2', keyHash: 'h', keyPrefix: 'p', createdAt: Date.now() }),
    () => repo.deleteApiKey('maint-repo-key'),
    () => repo.setHomepagePasswordRequired({ passwordRequired: false, ip: '203.0.113.41' })
  ];

  for (const write of writes) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(write(), error => isPublishingPausedError(error));
  }

  // Reads and background bookkeeping are not blocked.
  const page = await repo.getById('maint-repo-page');
  assert.equal(page.title, 'Repo page');
  assert.equal((await repo.listAdminPages({ limit: 10 })).length, 1);
  assert.equal(await repo.getHomepagePasswordRequired(), true);
  await repo.touchApiKey('maint-repo-key');
  assert.ok((await repo.getApiKeyById('maint-repo-key')).last_used_at);

  // View events are not counted during maintenance.
  assert.equal(await repo.recordViewEvent('maint-repo-page', Date.now(), false), 'maintenance');
  assert.equal((await repo.getById('maint-repo-page')).view_count, 0);

  // Nothing was mutated by the refused writes.
  assert.equal(await repo.getById('maint-repo-new'), null);

  await repo.setPublishingWritesPaused({ paused: false, ip: '203.0.113.42' });
  await repo.create({ id: 'maint-repo-new', htmlContent: 'x', createdAt: Date.now() });
  assert.ok(await repo.getById('maint-repo-new'));
  assert.equal(await repo.recordViewEvent('maint-repo-page', Date.now(), false), 'counted');
});

test('memory gate drains in-flight writes and rejects writers queued behind the pause', async () => {
  const gate = new MemoryPublishingGate();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const firstWrite = gate.runWrite(async () => {
    events.push('first:enter');
    await firstGate;
    events.push('first:exit');
    return 'first-result';
  });

  await new Promise(resolve => setImmediate(resolve));

  let pauseSettled = false;
  const pause = gate.setPaused(true).then((result) => {
    pauseSettled = true;
    events.push('paused');
    return result;
  });

  // Let the toggle actually register its exclusive request (in Postgres
  // terms: the pg_advisory_xact_lock call has been issued and is waiting).
  await new Promise(resolve => setImmediate(resolve));

  // A writer arriving while the drain is in progress must queue, not join.
  let secondSettled = false;
  const secondWrite = gate.runWrite(async () => {
    events.push('second:ran');
    return 'second-result';
  }).then(
    (result) => { secondSettled = true; return { ok: true, result }; },
    (error) => { secondSettled = true; return { ok: false, error }; }
  );

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(pauseSettled, false, 'pause must wait for the in-flight write');
  assert.equal(secondSettled, false, 'queued writer must wait behind the drain');
  assert.deepEqual(events, ['first:enter']);

  releaseFirst();
  assert.equal(await firstWrite, 'first-result');
  assert.deepEqual(await pause, { paused: true, changed: true });

  const second = await secondWrite;
  assert.equal(second.ok, false, 'writer queued behind the pause is refused, not run');
  assert.ok(second.error instanceof PublishingPausedError);
  assert.deepEqual(events, ['first:enter', 'first:exit', 'paused']);

  // Immediate refusal while paused; resume restores writes.
  await assert.rejects(gate.runWrite(async () => {}), error => isPublishingPausedError(error));
  assert.deepEqual(await gate.setPaused(false), { paused: false, changed: true });
  assert.equal(await gate.runWrite(async () => 'after-resume'), 'after-resume');
});

test('HTTP: paused publishing returns maintenance 503 on every write entrypoint while reads and login stay up', async () => {
  await seedPage({ id: 'maint-http-public' });
  await seedPage({ id: 'maint-http-protected', password: 'Secret1!' });

  // Sanity: publishing works before the pause.
  const created = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '<p>before pause</p>',
    codeType: 'html'
  }, { 'X-API-Key': 'maint-api-key' });
  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);

  await repository.setPublishingWritesPaused({ paused: true, ip: '203.0.113.50' });

  try {
    // Create via the managed API.
    assertMaintenance503(await jsonRequest('/api/v1/share', 'POST', {
      htmlContent: '<p>during pause</p>',
      codeType: 'html'
    }, { 'X-API-Key': 'maint-api-key' }), 'api v1 create');

    // Reads stay available: public view, protected unlock (a read path),
    // and the public metadata endpoint.
    const view = await request('/view/maint-http-public');
    assert.equal(view.status, 200);
    assert.match(view.text, /maint-http-public/);

    const unlock = await jsonRequest('/view/maint-http-protected/password', 'POST', { password: 'Secret1!' });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.valid, true);

    const metadata = await request('/api/pages/maint-http-public');
    assert.equal(metadata.status, 200);

    // View events are refused and not counted during maintenance.
    const viewEvent = await request('/view/maint-http-public/view-event', {
      method: 'POST',
      headers: { Origin: baseUrl }
    });
    assert.equal(viewEvent.status, 503);
    assert.equal((await repository.getById('maint-http-public')).view_count, 0);

    // Login still works during maintenance (it performs no gated write).
    const dashboardCookie = await loginDashboard();
    const adminCookie = await loginAdmin();

    // Authenticated admin reads stay available.
    const adminList = await request('/admin/pages', { headers: { Cookie: dashboardCookie } });
    assert.equal(adminList.status, 200);

    const dashboardCsrf = csrfFor(dashboardCookie);
    const adminCsrf = csrfFor(adminCookie);
    const dashboardHeaders = { Cookie: dashboardCookie, 'X-CSRF-Token': dashboardCsrf };
    const page = await repository.getById('maint-http-public');
    const revision = String(page.access_revision);

    // Edit, clone, delete, batch delete.
    assertMaintenance503(await jsonRequest('/admin/pages/maint-http-public', 'PUT', {
      title: 'Nope'
    }, dashboardHeaders), 'admin edit');
    assert.equal((await repository.getById('maint-http-public')).title, 'maint-http-public');

    assertMaintenance503(await request('/admin/pages/maint-http-public/clone', {
      method: 'POST',
      headers: { Cookie: dashboardCookie, 'X-CSRF-Token': dashboardCsrf }
    }), 'admin clone');

    assertMaintenance503(await jsonRequest('/admin/pages/maint-http-public', 'DELETE', undefined, dashboardHeaders), 'admin delete');
    assertMaintenance503(await jsonRequest('/admin/pages/batch', 'DELETE', {
      ids: ['maint-http-public']
    }, dashboardHeaders), 'admin batch delete');

    // Favorite, access revoke, protect.
    assertMaintenance503(await jsonRequest('/admin/pages/maint-http-public/favorite', 'PUT', {
      isFavorite: true
    }, dashboardHeaders), 'admin favorite');

    assertMaintenance503(await jsonRequest('/admin/pages/maint-http-public/revoke-access', 'POST', {
      expectedAccessRevision: revision
    }, dashboardHeaders), 'admin revoke-access');

    assertMaintenance503(await jsonRequest('/api/pages/maint-http-public/protect', 'POST', {
      isProtected: true,
      expectedAccessRevision: revision
    }, { Cookie: adminCookie, 'X-CSRF-Token': adminCsrf }), 'api protect');

    // Management writes: API keys and the homepage access setting.
    assertMaintenance503(await jsonRequest('/admin/apis/keys', 'POST', {
      name: 'During pause'
    }, dashboardHeaders), 'api key create');

    assertMaintenance503(await jsonRequest('/admin/settings/homepage-access', 'PUT', {
      passwordRequired: false
    }, dashboardHeaders), 'homepage access setting');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '203.0.113.51' });
  }

  // After a controlled resume, publishing and view counting work again.
  const after = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '<p>after resume</p>',
    codeType: 'html'
  }, { 'X-API-Key': 'maint-api-key' });
  assert.equal(after.status, 200);
  assert.equal(after.body.success, true);

  const counted = await request('/view/maint-http-public/view-event', {
    method: 'POST',
    headers: { Origin: baseUrl }
  });
  assert.equal(counted.status, 204);
  assert.equal((await repository.getById('maint-http-public')).view_count, 1);
});
