const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'homepage-access-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 'homepage-access-dashboard';
process.env.SHARE_API_KEY = 'homepage-access-api-key';
process.env.SESSION_SECRET = 'homepage-access-session-secret';

const app = require('../app');

let server;
let baseUrl;

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

function jsonRequest(route, body, headers = {}) {
  return request(route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function loginHomepage() {
  const response = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=homepage-access-password'
  });
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('admin_session='));

  assert.equal(response.status, 302);
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=homepage-access-dashboard'
  });
  const cookie = response.headers['set-cookie']?.find(
    value => value.startsWith('dashboard_admin_session=')
  );

  assert.equal(response.status, 302);
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCredentials() {
  const cookie = await loginDashboard();
  const stats = await request('/admin/stats', { headers: { Cookie: cookie } });
  const csrfToken = stats.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];

  assert.equal(stats.status, 200);
  assert.ok(csrfToken);
  return { cookie, csrfToken };
}

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

test('public mode opens the homepage without an admin session', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });

  const response = await request('/');

  assert.equal(response.status, 200);
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('public mode allows same-origin browser publishing without an admin session', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });

  const response = await jsonRequest('/api/pages/create', {
    htmlContent: '<h1>Public browser publish</h1>',
    isProtected: false
  }, { Origin: baseUrl });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('public mode allows same-origin browser previews without an admin session', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });

  const response = await jsonRequest('/api/pages/preview', {
    htmlContent: '<h1>Public browser preview</h1>',
    codeType: 'html'
  }, { Origin: baseUrl });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.document, /Public browser preview/);
});

test('public browser publishing rejects missing and cross-origin Origin headers', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });
  const cookie = await loginHomepage();
  const body = { htmlContent: '<h1>Origin boundary</h1>' };

  const missingOrigin = await jsonRequest('/api/pages/create', body);
  const crossOrigin = await jsonRequest('/api/pages/preview', body, {
    Origin: 'https://attacker.example'
  });
  const cookieWithoutOrigin = await jsonRequest('/api/pages/create', body, {
    Cookie: cookie
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal(crossOrigin.status, 403);
  assert.equal(cookieWithoutOrigin.status, 403);
});

test('relocking blocks anonymous access while an existing homepage session remains valid', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });
  const cookie = await loginHomepage();

  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: true,
    ip: '127.0.0.1'
  });

  const anonymousHomepage = await request('/');
  const anonymousCreate = await jsonRequest('/api/pages/create', {
    htmlContent: '<h1>Blocked after relock</h1>'
  });
  const authenticatedHomepage = await request('/', {
    headers: { Cookie: cookie }
  });
  const csrfToken = authenticatedHomepage.text.match(
    /name="csrf-token" content="([^"]+)"/
  )?.[1];
  const authenticatedPreview = await jsonRequest('/api/pages/preview', {
    htmlContent: '<h1>Existing session survives relock</h1>'
  }, {
    Cookie: cookie,
    'X-CSRF-Token': csrfToken
  });

  assert.equal(anonymousHomepage.status, 302);
  assert.equal(anonymousHomepage.headers.location, '/login');
  assert.equal(anonymousCreate.status, 401);
  assert.equal(authenticatedHomepage.status, 200);
  assert.ok(csrfToken);
  assert.equal(authenticatedPreview.status, 200);
});

test('homepage access setting failures fail closed on every dynamic route', async () => {
  app.locals.pageRepository.homepagePasswordRequired = null;

  try {
    const homepage = await request('/');
    const create = await jsonRequest('/api/pages/create', {
      htmlContent: '<h1>Unavailable create</h1>'
    }, { Origin: baseUrl });
    const preview = await jsonRequest('/api/pages/preview', {
      htmlContent: '<h1>Unavailable preview</h1>'
    }, { Origin: baseUrl });

    for (const response of [homepage, create, preview]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
  } finally {
    app.locals.pageRepository.homepagePasswordRequired = true;
  }
});

test('dynamic access checks run before JSON parsing and locked CSRF checks run after it', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: true,
    ip: '127.0.0.1'
  });
  const lockedAnonymous = await request('/api/pages/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  });

  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });
  const publicWithoutOrigin = await request('/api/pages/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  });
  const publicSameOrigin = await request('/api/pages/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: '{'
  });

  assert.equal(lockedAnonymous.status, 401);
  assert.equal(publicWithoutOrigin.status, 403);
  assert.equal(publicSameOrigin.status, 400);
});

test('public homepage mode does not open management routes or the Share API', async () => {
  await app.locals.pageRepository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '127.0.0.1'
  });

  const recent = await request('/api/pages/list/recent');
  const protect = await jsonRequest('/api/pages/missing/protect', {
    isProtected: false
  }, { Origin: baseUrl });
  const dashboard = await request('/admin/stats');
  const shareWithoutKey = await jsonRequest('/api/v1/share', {
    htmlContent: '<h1>API still locked</h1>'
  });
  const shareWithKey = await jsonRequest('/api/v1/share', {
    htmlContent: '<h1>API key remains independent</h1>'
  }, { 'X-API-Key': 'homepage-access-api-key' });

  assert.equal(recent.status, 401);
  assert.equal(protect.status, 401);
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.location, '/admin/login');
  assert.equal(shareWithoutKey.status, 401);
  assert.equal(shareWithKey.status, 200);
});

test('homepage access setting updates return JSON 401 without a dashboard session', async () => {
  const response = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passwordRequired: false })
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error, 'Unauthorized');
});

test('homepage access setting updates require the dashboard CSRF token', async () => {
  const cookie = await loginDashboard();
  const response = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({ passwordRequired: false })
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'Invalid CSRF token');
});

test('admin stats renders the persisted homepage access state and dashboard CSRF token', async () => {
  app.locals.pageRepository.homepagePasswordRequired = true;
  const cookie = await loginDashboard();
  const response = await request('/admin/stats', {
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 200);
  assert.match(response.text, /name="csrf-token" content="[^"]+"/);
  assert.match(response.text, /id="homepage-access-toggle"[^>]*checked/);
  assert.match(response.text, /首页访问控制/);
});

test('homepage access setting updates reject non-boolean payloads', async () => {
  const { cookie, csrfToken } = await dashboardCredentials();
  const response = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ passwordRequired: 'false' })
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.match(response.body.error, /boolean/i);
});

test('homepage access setting updates persist, audit, and remain idempotent', async () => {
  app.locals.pageRepository.homepagePasswordRequired = true;
  const beforeLogs = (await app.locals.pageRepository.listAuditLogs()).filter(
    log => log.action === 'settings.homepage_password_required.update'
  ).length;
  const { cookie, csrfToken } = await dashboardCredentials();
  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRF-Token': csrfToken
  };

  const changed = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ passwordRequired: false })
  });
  const unchanged = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ passwordRequired: false })
  });

  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, {
    success: true,
    passwordRequired: false,
    changed: true
  });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.body, {
    success: true,
    passwordRequired: false,
    changed: false
  });
  assert.equal(await app.locals.pageRepository.getHomepagePasswordRequired(), false);

  const afterLogs = (await app.locals.pageRepository.listAuditLogs()).filter(
    log => log.action === 'settings.homepage_password_required.update'
  );
  assert.equal(afterLogs.length, beforeLogs + 1);
  assert.deepEqual(JSON.parse(afterLogs[0].details), { from: true, to: false });
});

test('homepage access setting updates reject malformed JSON with a JSON response', async () => {
  const { cookie, csrfToken } = await dashboardCredentials();
  const response = await request('/admin/settings/homepage-access', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken
    },
    body: '{'
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error, 'Invalid JSON body');
});

test('admin stats returns 503 instead of showing an unknown access state', async () => {
  const cookie = await loginDashboard();
  const originalGetter = app.locals.pageRepository.getHomepagePasswordRequired;
  app.locals.pageRepository.getHomepagePasswordRequired = async () => {
    throw new Error('settings database unavailable');
  };

  try {
    const response = await request('/admin/stats', {
      headers: { Cookie: cookie }
    });

    assert.equal(response.status, 503);
    assert.match(response.text, /首页访问设置暂时不可用/);
  } finally {
    app.locals.pageRepository.getHomepagePasswordRequired = originalGetter;
  }
});

test('homepage access setting write failures return 503 and preserve the old state', async () => {
  app.locals.pageRepository.homepagePasswordRequired = true;
  const { cookie, csrfToken } = await dashboardCredentials();
  const originalSetter = app.locals.pageRepository.setHomepagePasswordRequired;
  app.locals.pageRepository.setHomepagePasswordRequired = async () => {
    throw new Error('settings transaction unavailable');
  };

  try {
    const response = await request('/admin/settings/homepage-access', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ passwordRequired: false })
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'Homepage access setting is unavailable');
    assert.equal(await app.locals.pageRepository.getHomepagePasswordRequired(), true);
  } finally {
    app.locals.pageRepository.setHomepagePasswordRequired = originalSetter;
  }
});
