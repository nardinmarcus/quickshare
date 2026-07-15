const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 'resource-home-access';
process.env.ADMIN_DASHBOARD_PASSWORD = 'resource-admin-access';
process.env.SESSION_SECRET = 'resource-policy-session-secret';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');

let server;
let baseUrl;
let homeCookie;
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
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

async function login(route, password, cookieName) {
  const response = await request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password)}`
  });

  assert.equal(response.status, 302);
  return response.headers['set-cookie']
    .find((value) => value.startsWith(`${cookieName}=`))
    .split(';')[0];
}

test.before(async () => {
  const password = 'Share9!?';

  await app.locals.pageRepository.create({
    id: 'resource-protected',
    htmlContent: '<h1>Protected resource test</h1>',
    createdAt: Date.now(),
    passwordHash: await hashSecret(password),
    encryptedPassword: encryptSecret(password),
    isProtected: true,
    codeType: 'html',
    title: 'Protected resource test',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
  await app.locals.pageRepository.create({
    id: 'resource-public',
    htmlContent: '<script>window.resourcePolicyExecuted = true</script>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Public resource test',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  homeCookie = await login('/login', 'resource-home-access', 'admin_session');
  dashboardCookie = await login('/admin/login', 'resource-admin-access', 'dashboard_admin_session');
});

test.after(() => {
  server.close();
});

function assertNoHighlightAssets(html) {
  assert.doesNotMatch(html, /highlight\.js/i);
  assert.doesNotMatch(html, /syntax-highlight\.js/i);
}

function assertNoInlineExecutableScript(html) {
  assert.doesNotMatch(
    html,
    /<script(?![^>]*\bsrc=)(?![^>]*\btype=["']application\/json["'])[^>]*>/i
  );
}

test('each trusted route loads only the scripts it uses', async () => {
  const [homepage, loginPage, passwordPage, errorPage, statsPage, auditPage, apiPage] = await Promise.all([
    request('/', { headers: { Cookie: homeCookie } }),
    request('/login'),
    request('/view/resource-protected'),
    request('/view/resource-missing'),
    request('/admin/stats', { headers: { Cookie: dashboardCookie } }),
    request('/admin/audit', { headers: { Cookie: dashboardCookie } }),
    request('/admin/apis', { headers: { Cookie: dashboardCookie } })
  ]);

  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /src="\/js\/main\.js"/);
  assertNoHighlightAssets(homepage.text);

  for (const response of [loginPage, passwordPage, errorPage, statsPage, auditPage]) {
    assert.doesNotMatch(response.text, /src="\/js\/main\.js"/);
    assertNoHighlightAssets(response.text);
  }

  assert.match(loginPage.text, /src="\/js\/login\.js"/);
  assert.match(passwordPage.text, /src="\/js\/password\.js"/);
  assertNoInlineExecutableScript(loginPage.text);
  assertNoInlineExecutableScript(passwordPage.text);

  assert.equal(apiPage.status, 200);
  assert.doesNotMatch(apiPage.text, /src="\/js\/main\.js"/);
  assertNoHighlightAssets(apiPage.text);

  for (const response of [homepage, loginPage, passwordPage, errorPage, statsPage, auditPage, apiPage]) {
    assert.match(response.text, /src="\/js\/theme\.js"/);
    assert.match(response.text, /font-awesome/);
  }
});

test('extracted login and password scripts preserve their interactions', async () => {
  const [loginScript, passwordScript] = await Promise.all([
    request('/js/login.js'),
    request('/js/password.js')
  ]);

  assert.equal(loginScript.status, 200);
  assert.match(loginScript.text, /toggleButton\.addEventListener\('click'/);
  assert.match(loginScript.text, /setAttribute\('aria-label'/);

  assert.equal(passwordScript.status, 200);
  assert.match(passwordScript.text, /form\.addEventListener\('submit'/);
  assert.match(passwordScript.text, /fetch\('\/view\/'/);
  assert.match(passwordScript.text, /setAttribute\('aria-busy'/);
});

test('static assets and the conventional favicon use bounded revalidation caching', async () => {
  const [script, favicon] = await Promise.all([
    request('/js/main.js'),
    request('/favicon.ico')
  ]);

  for (const response of [script, favicon]) {
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'] || '', /\bpublic\b/);
    assert.match(response.headers['cache-control'] || '', /\bmax-age=300\b/);
    assert.match(response.headers['cache-control'] || '', /\bmust-revalidate\b/);
    assert.doesNotMatch(response.headers['cache-control'] || '', /\bimmutable\b/);
    assert.ok(response.headers.etag);
  }

  assert.match(favicon.headers['content-type'] || '', /^image\/(?:x-icon|vnd\.microsoft\.icon)/);
  assert.ok(favicon.body.length > 0);

  const revalidated = await request('/js/main.js', {
    headers: { 'If-None-Match': script.headers.etag }
  });
  const head = await request('/favicon.ico', { method: 'HEAD' });

  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, favicon.headers.etag);
});

test('Vercel applies the same bounded cache policy to platform-served assets', () => {
  const vercelConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8')
  );
  const expectedSources = ['/css/(.*)', '/js/(.*)', '/icon/(.*)', '/favicon.ico'];

  for (const source of expectedSources) {
    const rule = vercelConfig.headers?.find((candidate) => candidate.source === source);
    const cacheControl = rule?.headers?.find((header) => (
      header.key.toLowerCase() === 'cache-control'
    ));

    assert.equal(cacheControl?.value, 'public, max-age=300, must-revalidate', source);
  }
});

test('enforced CSP protects trusted UI without constraining share content or preview', async () => {
  const [loginPage, adminPage, passwordPage, homepage, sharePage] = await Promise.all([
    request('/login'),
    request('/admin/stats', { headers: { Cookie: dashboardCookie } }),
    request('/view/resource-protected'),
    request('/', { headers: { Cookie: homeCookie } }),
    request('/view/resource-public')
  ]);

  for (const response of [loginPage, adminPage]) {
    const policy = response.headers['content-security-policy'] || '';
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.match(policy, /script-src-attr 'none'/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(policy, /script-src[^;]*https:/);
  }

  const passwordPolicy = passwordPage.headers['content-security-policy'] || '';
  assert.match(passwordPolicy, /script-src 'self'(?:;|$)/);
  assert.doesNotMatch(passwordPolicy, /frame-ancestors/);
  assert.equal(homepage.headers['content-security-policy'], undefined);
  assert.equal(sharePage.headers['content-security-policy'], undefined);
  assert.match(sharePage.text, /window\.resourcePolicyExecuted = true/);
});
