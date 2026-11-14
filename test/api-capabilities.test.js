const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { hashSecret } = require('../utils/security');
const { getMarkdownThemeOptions } = require('../utils/markdownThemeCatalog');

// Connection identity & capabilities (T05, issue #29): /api/v1/me and
// /api/v1/capabilities must describe the credential that was actually
// verified and the operations the instance really supports — for the
// legacy environment Key and for managed Keys alike — without ever
// exposing secret material.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 'legacy-test-key-456';

const app = require('../app');

let server;
let baseUrl;

const MANAGED_ID = 'capabilities-managed-key';
const MANAGED_SECRET = 'capabilities-managed-secret-12345';
let managedKeyHash;

test.before(async () => {
  managedKeyHash = await hashSecret(MANAGED_SECRET);
  await app.locals.pageRepository.createApiKey({
    id: MANAGED_ID,
    name: 'Capabilities managed key',
    keyHash: managedKeyHash,
    keyPrefix: 'qs.capabili…',
    createdAt: Date.now()
  });

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

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const managedHeaders = { 'X-API-Key': `qs.${MANAGED_ID}.${MANAGED_SECRET}` };
const legacyHeaders = { 'X-API-Key': 'legacy-test-key-456' };

test('GET /api/v1/me rejects missing, invalid, and malformed credentials', async () => {
  const missing = await request('/api/v1/me');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.success, false);

  const wrong = await request('/api/v1/me', { headers: { 'X-API-Key': 'not-a-key' } });
  assert.equal(wrong.status, 401);

  const malformedManaged = await request('/api/v1/me', {
    headers: { 'X-API-Key': 'qs.no-such-key.a-secret-that-is-long-enough' }
  });
  assert.equal(malformedManaged.status, 401);

  const wrongManagedSecret = await request('/api/v1/me', {
    headers: { 'X-API-Key': `qs.${MANAGED_ID}.wrong-secret-that-is-long-enough` }
  });
  assert.equal(wrongManagedSecret.status, 401);
});

test('GET /api/v1/me describes the legacy credential without leaking it', async () => {
  const res = await request('/api/v1/me', { headers: legacyHeaders });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.origin, baseUrl);
  assert.deepEqual(res.body.credential, {
    type: 'legacy',
    keyId: null,
    name: null,
    credentialVersion: null,
    scopes: ['share:create']
  });
  assert.ok(!res.text.includes('legacy-test-key-456'));
});

test('GET /api/v1/me describes a managed Key identity without secret material', async () => {
  const res = await request('/api/v1/me', { headers: managedHeaders });

  assert.equal(res.status, 200);
  assert.equal(res.body.origin, baseUrl);
  assert.deepEqual(res.body.credential, {
    type: 'managed',
    keyId: MANAGED_ID,
    name: 'Capabilities managed key',
    credentialVersion: '1',
    scopes: ['share:create']
  });
  assert.ok(!res.text.includes(MANAGED_SECRET));
  assert.ok(!res.text.includes(managedKeyHash));
  assert.ok(!res.text.includes('key_hash'));
});

test('GET /api/v1/capabilities returns the real create-only surface for both credential kinds', async () => {
  const expectedPresetIds = getMarkdownThemeOptions().map(option => option.id);
  assert.equal(expectedPresetIds.length, 12);

  for (const [headers, type] of [[legacyHeaders, 'legacy'], [managedHeaders, 'managed']]) {
    const res = await request('/api/v1/capabilities', { headers });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const capabilities = res.body.capabilities;
    assert.equal(capabilities.protocolVersion, 1);
    assert.equal(capabilities.credentialType, type);
    assert.deepEqual(capabilities.scopes, ['share:create']);
    assert.deepEqual(capabilities.contentTypes, ['html', 'markdown', 'svg', 'mermaid']);
    assert.deepEqual(capabilities.markdownThemePresets, expectedPresetIds);
    assert.equal(capabilities.limits.shareRequestBody, '2mb');
    assert.equal(capabilities.limits.shareRequestBodyBytes, 2 * 1024 * 1024);
    // Create-only stage: exactly one write operation plus the connection
    // reads and operation confirmation (T08 — part of the create
    // capability, not a management grant). No management operation may
    // be advertised before it exists.
    assert.deepEqual(
      capabilities.operations.map(operation => operation.id),
      ['share.create', 'connection.me', 'connection.capabilities', 'operation.status']
    );
    assert.deepEqual(capabilities.operations[0], {
      id: 'share.create',
      method: 'POST',
      path: '/api/v1/share'
    });
    assert.equal(capabilities.conditionalWrites.length, 1);
    assert.equal(capabilities.conditionalWrites[0].operation, 'share.create');
    assert.equal(capabilities.conditionalWrites[0].requiresIfMatch, false);
    // T08: optional idempotency is advertised exactly as implemented —
    // header optional, replay supported, 409/410 machine-readable.
    assert.equal(capabilities.conditionalWrites[0].requiresIdempotencyKey, false);
    assert.deepEqual(capabilities.conditionalWrites[0].idempotency, {
      header: 'Idempotency-Key',
      required: false,
      replaySupported: true,
      keyFormat: '16-128 characters of [A-Za-z0-9_-]; clients generate a UUID v4',
      confirmationOperation: 'operation.status',
      conflict: { status: 409, code: 'idempotency_conflict', retryable: false },
      resultUnavailable: { status: 410, code: 'operation_result_unavailable', retryable: false },
      invalidKey: { status: 400, code: 'invalid_idempotency_key', retryable: false }
    });
    assert.deepEqual(capabilities.conditionalWrites[0].maintenanceRefusal, {
      status: 503,
      code: 'maintenance',
      retryable: true
    });
    assert.ok(!res.text.includes('key_hash'));
    assert.ok(!res.text.includes(MANAGED_SECRET));
  }
});

test('every advertised content type is really accepted by Share creation', async () => {
  const capabilities = (await request('/api/v1/capabilities', { headers: managedHeaders })).body.capabilities;
  const samples = {
    html: '<h1>Capability html</h1>',
    markdown: '# Capability markdown',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
    mermaid: 'graph TD; A-->B'
  };

  for (const codeType of capabilities.contentTypes) {
    const res = await request('/api/v1/share', {
      method: 'POST',
      headers: managedHeaders,
      body: { htmlContent: samples[codeType], codeType }
    });

    assert.equal(res.status, 200, `content type ${codeType} must be creatable`);
    assert.equal(res.body.codeType, codeType);
  }
});

test('connection checks stay available during write maintenance while creation is refused', async () => {
  const repository = app.locals.pageRepository;
  await repository.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const me = await request('/api/v1/me', { headers: managedHeaders });
    assert.equal(me.status, 200);

    const capabilities = await request('/api/v1/capabilities', { headers: managedHeaders });
    assert.equal(capabilities.status, 200);

    const create = await request('/api/v1/share', {
      method: 'POST',
      headers: managedHeaders,
      body: { htmlContent: '<h1>must not be created</h1>' }
    });
    assert.equal(create.status, 503);
    assert.equal(create.body.code, 'maintenance');
  } finally {
    await repository.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }
});
