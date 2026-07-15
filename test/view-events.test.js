const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'view-event-home-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'view-event-dashboard-password';
process.env.SESSION_SECRET = 'view-event-test-secret';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');

let server;
let baseUrl;
let dashboardCookie;

function request(route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request(new URL(route, baseUrl), {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

async function seedPage({ id, expiresAt = null, password = null }) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: `<h1>${id}</h1>`,
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

test.before(async () => {
  await seedPage({ id: 'event-public' });
  await seedPage({ id: 'event-admin-preview' });
  await seedPage({ id: 'event-awaited' });
  await seedPage({ id: 'event-origin' });
  await seedPage({ id: 'event-protected', password: '654321' });
  await seedPage({ id: 'event-expired', expiresAt: Date.now() - 60_000 });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const login = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=view-event-dashboard-password'
  });

  assert.equal(login.status, 302);
  dashboardCookie = login.headers['set-cookie'][0].split(';')[0];
});

test.after(() => {
  server.close();
});

function sameOriginHeaders(headers = {}) {
  return { Origin: baseUrl, ...headers };
}

test('GET view stays read-only and injects reporting only for a served public page', async () => {
  const publicPage = await request('/view/event-public');
  const untrustedAdminPreview = await request('/view/event-admin-preview?adminPreview=1');
  const adminPreview = await request('/view/event-admin-preview?adminPreview=1', {
    headers: { Cookie: dashboardCookie }
  });
  const protectedGate = await request('/view/event-protected');
  const expired = await request('/view/event-expired');
  const missing = await request('/view/event-missing');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /src="\/js\/view-event\.js"/);
  assert.match(publicPage.text, /data-view-event-url="\/view\/event-public\/view-event"/);
  assert.match(untrustedAdminPreview.text, /data-view-event-url="\/view\/event-admin-preview\/view-event"/);
  assert.equal((await app.locals.pageRepository.getById('event-public')).view_count, 0);

  for (const response of [adminPreview, protectedGate, expired, missing]) {
    assert.doesNotMatch(response.text, /view-event\.js|data-view-event-url/);
  }

  for (const response of [publicPage, untrustedAdminPreview, adminPreview, protectedGate, expired, missing]) {
    assert.match(response.headers['cache-control'] || '', /private, no-store/);
  }

  assert.equal((await app.locals.pageRepository.getById('event-admin-preview')).view_count, 0);
});

test('view-event response waits for the increment and counts exactly once', async () => {
  const repository = app.locals.pageRepository;
  const originalRecordViewEvent = repository.recordViewEvent.bind(repository);
  let markStarted;
  let releaseIncrement;
  let responseSettled = false;
  const incrementStarted = new Promise(resolve => { markStarted = resolve; });

  repository.recordViewEvent = async (id, now, hasAccess) => {
    if (id === 'event-awaited') {
      assert.equal(Number.isFinite(now), true);
      assert.equal(hasAccess, false);
      markStarted();
      await new Promise(resolve => { releaseIncrement = resolve; });
    }

    return originalRecordViewEvent(id, now, hasAccess);
  };

  try {
    const pendingResponse = request('/view/event-awaited/view-event', {
      method: 'POST',
      headers: sameOriginHeaders()
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    await incrementStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responseSettled, false);
    assert.equal((await repository.getById('event-awaited')).view_count, 0);

    releaseIncrement();
    const response = await pendingResponse;

    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.match(response.headers['cache-control'] || '', /private, no-store/);
    assert.equal((await repository.getById('event-awaited')).view_count, 1);
  } finally {
    repository.recordViewEvent = originalRecordViewEvent;
  }
});

test('view-event rejects cross-site, unavailable, and locked page events', async () => {
  const missingOrigin = await request('/view/event-origin/view-event', { method: 'POST' });
  const crossSite = await request('/view/event-origin/view-event', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' }
  });
  const expired = await request('/view/event-expired/view-event', {
    method: 'POST',
    headers: sameOriginHeaders()
  });
  const missing = await request('/view/event-missing/view-event', {
    method: 'POST',
    headers: sameOriginHeaders()
  });
  const locked = await request('/view/event-protected/view-event', {
    method: 'POST',
    headers: sameOriginHeaders()
  });

  assert.deepEqual(
    [missingOrigin.status, crossSite.status, expired.status, missing.status, locked.status],
    [403, 403, 410, 404, 403]
  );
  assert.equal((await app.locals.pageRepository.getById('event-origin')).view_count, 0);
  assert.equal((await app.locals.pageRepository.getById('event-expired')).view_count, 0);
  assert.equal((await app.locals.pageRepository.getById('event-protected')).view_count, 0);

  const unlock = await request('/view/event-protected/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '654321' })
  });
  const cookie = unlock.headers['set-cookie'][0].split(';')[0];
  const unlockedView = await request('/view/event-protected', { headers: { Cookie: cookie } });
  const counted = await request('/view/event-protected/view-event', {
    method: 'POST',
    headers: sameOriginHeaders({ Cookie: cookie })
  });

  assert.equal(unlock.status, 200);
  assert.match(unlockedView.text, /data-view-event-url="\/view\/event-protected\/view-event"/);
  assert.equal(counted.status, 204);
  assert.equal((await app.locals.pageRepository.getById('event-protected')).view_count, 1);
});

test('browser reporter sends once and falls back to keepalive fetch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/view-event.js'), 'utf8');

  function runReporter(beaconResult) {
    let domReadyHandler;
    let listenerOnce = false;
    const beaconCalls = [];
    const fetchCalls = [];
    const context = {
      document: {
        currentScript: { dataset: { viewEventUrl: '/view/reporter/view-event' } },
        readyState: 'loading',
        addEventListener(type, handler, options) {
          if (type === 'DOMContentLoaded') {
            domReadyHandler = handler;
            listenerOnce = options?.once === true;
          }
        }
      },
      navigator: {
        sendBeacon(url) {
          beaconCalls.push(url);
          return beaconResult;
        }
      },
      fetch(url, options) {
        fetchCalls.push({ url, options });
        return { catch() {} };
      }
    };

    vm.runInNewContext(source, context);
    domReadyHandler();
    domReadyHandler();
    return { beaconCalls, fetchCalls, listenerOnce };
  }

  const beacon = runReporter(true);
  assert.equal(beacon.listenerOnce, true);
  assert.deepEqual(beacon.beaconCalls, ['/view/reporter/view-event']);
  assert.equal(beacon.fetchCalls.length, 0);

  const fallback = runReporter(false);
  assert.deepEqual(fallback.beaconCalls, ['/view/reporter/view-event']);
  assert.equal(fallback.fetchCalls.length, 1);
  assert.equal(fallback.fetchCalls[0].url, '/view/reporter/view-event');
  assert.equal(fallback.fetchCalls[0].options.method, 'POST');
  assert.equal(fallback.fetchCalls[0].options.credentials, 'same-origin');
  assert.equal(fallback.fetchCalls[0].options.keepalive, true);
});
