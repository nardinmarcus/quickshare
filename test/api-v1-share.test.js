const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'test-key-123';

const app = require('../app');

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('POST /api/v1/share creates page with valid API key', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: '<h1>Hello from CLI</h1>',
    codeType: 'html',
    title: 'Test Page'
  }, { 'X-API-Key': 'test-key-123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.url.includes('/view/'));
  assert.equal(res.body.codeType, 'html');
  assert.equal(res.body.isProtected, false);
});

test('POST /api/v1/share rejects missing API key', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: '<h1>Hello</h1>'
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('POST /api/v1/share rejects wrong API key', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: '<h1>Hello</h1>'
  }, { 'X-API-Key': 'wrong-key' });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('POST /api/v1/share rejects empty content', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: ''
  }, { 'X-API-Key': 'test-key-123' });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
});

test('POST /api/v1/share auto-detects markdown', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: '# Hello\n\nThis is **markdown**'
  }, { 'X-API-Key': 'test-key-123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.codeType, 'markdown');
});

test('POST /api/v1/share supports password protection', async () => {
  const res = await post('/api/v1/share', {
    htmlContent: '<h1>Secret</h1>',
    isProtected: true
  }, { 'X-API-Key': 'test-key-123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.isProtected, true);
  assert.ok(res.body.password);
  assert.ok(/^\d{6}$/.test(res.body.password));
});
