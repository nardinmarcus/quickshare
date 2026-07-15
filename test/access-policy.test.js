const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'access-policy-key';
process.env.SESSION_SECRET = 'access-policy-secret';

const app = require('../app');
const { decryptSecret, encryptSecret, hashSecret } = require('../utils/security');

const PASSWORD_ERROR = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';

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
  const data = JSON.stringify(body);
  return request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: data
  });
}

async function seedPage({ id, password = null }) {
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
    expiresAt: null,
    markdownTheme: null
  });
}

test('homepage exposes atomic publish settings before the publish action', async () => {
  const homepage = await request('/');
  const script = await request('/js/main.js');
  const settingsPosition = homepage.text.indexOf('id="publish-settings"');
  const publishPosition = homepage.text.indexOf('id="generate-button"');
  const resultPosition = homepage.text.indexOf('id="result-section"');

  assert.equal(homepage.status, 200);
  assert.ok(settingsPosition >= 0);
  assert.ok(settingsPosition < publishPosition);
  assert.ok(publishPosition < resultPosition);
  assert.match(homepage.text, /持有链接可访问/);
  assert.match(homepage.text, /密码保护/);
  assert.match(homepage.text, /id="share-title"/);
  assert.match(homepage.text, /id="share-description"/);
  assert.match(homepage.text, /id="share-expires"/);
  assert.match(homepage.text, /aria-describedby="custom-password-hint"/);
  assert.match(homepage.text, /发布并生成链接/);
  assert.doesNotMatch(script.text, /\/api\/pages\/\$\{urlId\}\/protect/);
});

test('browser create stores all publish settings atomically', async () => {
  const expiresAt = Date.now() + 3_600_000;
  const response = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '# Atomic publish\n\nBody',
    codeType: 'markdown',
    title: 'Atomic title',
    description: 'Atomic description',
    expiresAt,
    markdownTheme: 'github',
    isProtected: true,
    password: 'Ab9!_?~'
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.password, 'Ab9!_?~');
  const page = await app.locals.pageRepository.getById(response.body.urlId);
  assert.equal(page.title, 'Atomic title');
  assert.equal(page.description, 'Atomic description');
  assert.equal(page.expires_at, expiresAt);
  assert.equal(page.markdown_theme, 'github');
  assert.equal(page.is_protected, 1);
  assert.equal(decryptSecret(page.encrypted_password), 'Ab9!_?~');

  const metadataResponse = await request(`/api/pages/${response.body.urlId}`);
  assert.equal(metadataResponse.body.page.expiresAt, expiresAt);
  assert.equal(metadataResponse.body.page.markdownTheme, 'github');

  const unlockResponse = await jsonRequest(`/view/${response.body.urlId}/password`, 'POST', {
    password: 'Ab9!_?~'
  });
  assert.equal(unlockResponse.status, 200);
  assert.equal(unlockResponse.body.valid, true);
});

test('share API stores all publish settings and preserves its existing response fields', async () => {
  const expiresAt = Date.now() + 7_200_000;
  const response = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '# API atomic publish',
    codeType: 'markdown',
    title: 'API title',
    description: 'API description',
    expiresAt,
    markdownTheme: 'notion',
    isProtected: true,
    password: 'Case9+.,'
  }, { 'X-API-Key': 'access-policy-key' });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.password, 'Case9+.,');
  assert.ok(response.body.url.endsWith(`/view/${response.body.urlId}`));
  const page = await app.locals.pageRepository.getById(response.body.urlId);
  assert.equal(page.title, 'API title');
  assert.equal(page.description, 'API description');
  assert.equal(page.expires_at, expiresAt);
  assert.equal(page.markdown_theme, 'notion');
  assert.equal(decryptSecret(page.encrypted_password), 'Case9+.,');
});

test('all password write routes reject the same invalid custom-password characters', async () => {
  await seedPage({ id: 'protect-invalid' });
  await seedPage({ id: 'admin-invalid', password: 'Valid9!?' });

  const responses = await Promise.all([
    jsonRequest('/api/pages/create', 'POST', {
      htmlContent: '<h1>Invalid browser password</h1>',
      isProtected: false,
      password: ' Ab1'
    }),
    jsonRequest('/api/v1/share', 'POST', {
      htmlContent: '<h1>Invalid API password</h1>',
      isProtected: true,
      password: 'Ab1🙂'
    }, { 'X-API-Key': 'access-policy-key' }),
    jsonRequest('/api/pages/protect-invalid/protect', 'POST', {
      isProtected: true,
      password: 'Ab1/'
    }),
    jsonRequest('/admin/pages/admin-invalid', 'PUT', {
      isProtected: true,
      password: 'Ab1 password'
    })
  ]);

  for (const response of responses) {
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error, PASSWORD_ERROR);
  }
});

test('empty passwords keep automatic generation and existing protected admin passwords', async () => {
  await seedPage({ id: 'protect-auto' });
  await seedPage({ id: 'admin-auto' });
  await seedPage({ id: 'admin-keep', password: 'Keep9!?' });

  const browserCreateResponse = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<h1>Browser auto password</h1>',
    isProtected: true,
    password: ''
  });
  const protectResponse = await jsonRequest('/api/pages/protect-auto/protect', 'POST', {
    isProtected: true,
    password: ''
  });
  const adminAutoResponse = await jsonRequest('/admin/pages/admin-auto', 'PUT', {
    isProtected: true,
    password: ''
  });
  const adminKeepResponse = await jsonRequest('/admin/pages/admin-keep', 'PUT', {
    isProtected: true,
    password: ''
  });

  assert.match(browserCreateResponse.body.password, /^\d{6}$/);
  assert.match(protectResponse.body.password, /^\d{6}$/);
  assert.match(adminAutoResponse.body.page.password, /^\d{6}$/);
  assert.equal(adminKeepResponse.body.page.password, 'Keep9!?');
});

test('creation rejects malformed or non-future expiry values', async () => {
  const responses = await Promise.all([
    jsonRequest('/api/pages/create', 'POST', {
      htmlContent: '<h1>Past expiry</h1>',
      expiresAt: Date.now() - 1
    }),
    jsonRequest('/api/v1/share', 'POST', {
      htmlContent: '<h1>Malformed expiry</h1>',
      expiresAt: 'tomorrow'
    }, { 'X-API-Key': 'access-policy-key' })
  ]);

  for (const response of responses) {
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error, '到期时间必须晚于当前时间');
  }
});
