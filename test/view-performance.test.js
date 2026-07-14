const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'view-performance-test-secret';
process.env.LOG_LEVEL = 'combined';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');

const performanceLogs = [];
const requestLogs = [];
let server;
let baseUrl;

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function abortRequest(path) {
  return new Promise((resolve) => {
    const req = http.request(new URL(path, baseUrl));
    req.on('error', resolve);
    req.end();
    setTimeout(() => req.destroy(), 5);
  });
}

async function seedPage({ id, expiresAt = null, password = null, content = `<h1>${id}</h1>` }) {
  await app.locals.pageRepository.create({
    id,
    htmlContent: content,
    createdAt: Date.now(),
    passwordHash: password ? await hashSecret(password) : null,
    encryptedPassword: password ? encryptSecret(password) : null,
    isProtected: Boolean(password),
    codeType: 'html',
    title: `private-title-${id}`,
    description: null,
    expiresAt,
    markdownTheme: null
  });
}

test.before(async () => {
  const repository = app.locals.pageRepository;
  const originalGetPublicById = repository.getPublicById.bind(repository);

  await seedPage({
    id: 'perf-served-secret-id',
    content: '<h1>private-body-marker</h1>'
  });
  await seedPage({ id: 'perf-expired-secret-id', expiresAt: Date.now() - 60_000 });
  await seedPage({ id: 'perf-protected-secret-id', password: 'private-password-marker' });
  await seedPage({
    id: 'perf-render-error-secret-id',
    content: { private: 'private-render-error-marker' }
  });
  await seedPage({ id: 'perf-slow-secret-id' });

  repository.getPublicById = async (id, now) => {
    if (id === 'perf-error-secret-id') {
      const error = new Error('private-database-error-marker');
      error.code = 'PRIVATE_DATABASE_CODE';
      throw error;
    }

    if (id === 'perf-slow-secret-id') {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return originalGetPublicById(id, now);
  };

  app.locals.viewPerformanceLogger = {
    info(line) {
      performanceLogs.push(line);
    }
  };
  app.locals.requestLogStream = {
    write(line) {
      requestLogs.push(line);
    }
  };

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

test('view requests emit one complete, bounded, and sanitized performance event', async () => {
  const served = await request('/view/perf-served-secret-id?token=private-query-marker', {
    headers: { Cookie: 'private-cookie-marker=1' }
  });
  const protectedPage = await request('/view/perf-protected-secret-id');
  const expired = await request('/view/perf-expired-secret-id');
  const missing = await request('/view/perf-missing-secret-id');
  const failed = await request('/view/perf-error-secret-id');
  const renderFailed = await request('/view/perf-render-error-secret-id');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    [served.status, protectedPage.status, expired.status, missing.status, failed.status, renderFailed.status],
    [200, 200, 410, 404, 500, 500]
  );
  assert.equal(performanceLogs.length, 6);

  const events = performanceLogs.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.outcome), [
    'served',
    'password_required',
    'expired',
    'not_found',
    'database_error',
    'render_error'
  ]);
  assert.deepEqual(events.map(event => event.status), [200, 200, 410, 404, 500, 500]);
  assert.equal(events[0].response_bytes, Buffer.byteLength(served.text));

  for (const event of events) {
    assert.equal(event.event, 'quickshare.view');
    assert.equal(event.route, '/view/:id');
    assert.equal(event.method, 'GET');
    assert.equal(typeof event.cold_start, 'boolean');
    assert.equal(Number.isFinite(event.total_ms) && event.total_ms >= 0, true);
    assert.equal(Number.isFinite(event.db_ms) && event.db_ms >= 0, true);
    assert.equal(Number.isFinite(event.render_ms) && event.render_ms >= 0, true);
    assert.equal(Number.isInteger(event.response_bytes) && event.response_bytes >= 0, true);
    assert.equal(event.content_type === null || ['html', 'markdown', 'svg', 'mermaid', 'unknown'].includes(event.content_type), true);
    assert.equal(event.protected === null || typeof event.protected === 'boolean', true);
  }

  const serialized = JSON.stringify(events);
  for (const secret of [
    'perf-served-secret-id',
    'perf-protected-secret-id',
    'perf-expired-secret-id',
    'perf-missing-secret-id',
    'perf-error-secret-id',
    'perf-render-error-secret-id',
    'private-query-marker',
    'private-cookie-marker',
    'private-title',
    'private-body-marker',
    'private-password-marker',
    'private-database-error-marker',
    'private-render-error-marker',
    'PRIVATE_DATABASE_CODE'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test('an interrupted view request emits one client_closed event', async () => {
  const initialLogCount = performanceLogs.length;

  await abortRequest('/view/perf-slow-secret-id?token=private-query-marker');
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(performanceLogs.length, initialLogCount + 1);
  const event = JSON.parse(performanceLogs.at(-1));
  assert.equal(event.outcome, 'client_closed');
  assert.equal(event.route, '/view/:id');
  assert.doesNotMatch(performanceLogs.at(-1), /perf-slow-secret-id|private-query-marker/);
});

test('mixed-case view paths stay out of generic logs', async () => {
  const initialPerformanceCount = performanceLogs.length;
  const initialRequestLogCount = requestLogs.length;
  const response = await request('/ViEw/perf-served-secret-id?token=private-query-marker');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response.status, 200);
  assert.equal(performanceLogs.length, initialPerformanceCount + 1);
  assert.equal(requestLogs.length, initialRequestLogCount);
  assert.doesNotMatch(performanceLogs.at(-1), /perf-served-secret-id|private-query-marker/);
});

test('HEAD view requests report their real method without a duplicate generic log', async () => {
  const initialPerformanceCount = performanceLogs.length;
  const initialRequestLogCount = requestLogs.length;
  const response = await request('/view/perf-served-secret-id?token=private-query-marker', {
    method: 'HEAD'
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response.status, 200);
  assert.equal(performanceLogs.length, initialPerformanceCount + 1);
  assert.equal(requestLogs.length, initialRequestLogCount);
  const event = JSON.parse(performanceLogs.at(-1));
  assert.equal(event.method, 'HEAD');
  assert.doesNotMatch(performanceLogs.at(-1), /perf-served-secret-id|private-query-marker/);
});

test('generic request logs skip GET view pages and sanitize dynamic password routes', async () => {
  const initialRequestLogCount = requestLogs.length;
  const assetResponse = await request('/css/styles.css', {
    headers: {
      Referer: `${baseUrl}/VIEW/perf-served-secret-id?token=private-referrer-query`
    }
  });
  const unknownViewResponse = await request(
    '/view/perf-served-secret-id/private-extra-segment?token=private-unknown-query'
  );
  const unknownReferrerResponse = await request('/css/login.css', {
    headers: {
      Referer: `${baseUrl}/view/perf-served-secret-id/private-referrer-segment?token=private-referrer-query`
    }
  });
  const response = await request('/view/perf-protected-secret-id/password?token=private-query-marker', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'private-cookie-marker=1'
    },
    body: JSON.stringify({ password: 'wrong-password' })
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(assetResponse.status, 200);
  assert.equal(unknownViewResponse.status, 404);
  assert.equal(unknownReferrerResponse.status, 200);
  assert.equal(response.status, 401);
  const newRequestLogs = requestLogs.slice(initialRequestLogCount);
  assert.equal(newRequestLogs.length, 4);
  assert.match(newRequestLogs[0], /\/view\/:id/);
  assert.match(newRequestLogs[1], /GET \/view\/:id\/\*/);
  assert.match(newRequestLogs[2], /\/view\/:id\/\*/);
  assert.match(newRequestLogs[3], /POST \/view\/:id\/password/);
  assert.doesNotMatch(
    newRequestLogs.join('\n'),
    /perf-served-secret-id|perf-protected-secret-id|private-extra-segment|private-referrer-segment|private-unknown-query|private-referrer-query|private-query-marker|private-cookie-marker/
  );
});
