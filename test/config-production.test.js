const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, 'config.js');
const testSalt = Buffer.alloc(16, 1).toString('base64url');
const testKey = crypto.scryptSync('test-password', testSalt, 64).toString('base64url');
const validHash = `scrypt$${testSalt}$${testKey}`;
const validSessionSecret = 's'.repeat(40);

function loadProductionConfig(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    AUTH_ENABLED: 'true',
    ADMIN_PASSWORD_HASH: validHash,
    ADMIN_DASHBOARD_PASSWORD_HASH: validHash,
    SESSION_SECRET: validSessionSecret,
    ...overrides
  };

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[name];
    }
  }

  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env
  });
}

test('production rejects plaintext passwords even when hashes are configured', () => {
  const frontend = loadProductionConfig({ AUTH_PASSWORD: 'plaintext-frontend' });
  const dashboard = loadProductionConfig({ ADMIN_DASHBOARD_PASSWORD: 'plaintext-dashboard' });

  assert.notEqual(frontend.status, 0);
  assert.match(frontend.stderr, /AUTH_PASSWORD is not allowed in production/i);
  assert.notEqual(dashboard.status, 0);
  assert.match(dashboard.stderr, /ADMIN_DASHBOARD_PASSWORD is not allowed in production/i);
});

test('production requires real scrypt hash values', () => {
  const frontend = loadProductionConfig({ ADMIN_PASSWORD_HASH: 'plaintext-disguised-as-hash' });
  const dashboard = loadProductionConfig({ ADMIN_DASHBOARD_PASSWORD_HASH: 'plaintext-disguised-as-hash' });
  const malformedLengths = loadProductionConfig({ ADMIN_PASSWORD_HASH: 'scrypt$c2FsdA$a2V5' });

  assert.notEqual(frontend.status, 0);
  assert.match(frontend.stderr, /ADMIN_PASSWORD_HASH must be a scrypt hash/i);
  assert.notEqual(dashboard.status, 0);
  assert.match(dashboard.stderr, /ADMIN_DASHBOARD_PASSWORD_HASH must be a scrypt hash/i);
  assert.notEqual(malformedLengths.status, 0);
  assert.match(malformedLengths.stderr, /ADMIN_PASSWORD_HASH must be a scrypt hash/i);
});

test('production validates SESSION_SECRET presence and strength during startup', () => {
  const missing = loadProductionConfig({ SESSION_SECRET: '' });
  const compatibilityAlias = loadProductionConfig({ SESSION_SECRET: '', AUTH_SECRET: validSessionSecret });
  const short = loadProductionConfig({ SESSION_SECRET: 'short' });
  const placeholder = loadProductionConfig({ SESSION_SECRET: 'change-this-to-a-long-random-secret' });

  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SESSION_SECRET is required in production/i);
  assert.notEqual(compatibilityAlias.status, 0);
  assert.match(compatibilityAlias.stderr, /SESSION_SECRET is required in production/i);
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /SESSION_SECRET must be at least 32 bytes/i);
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /SESSION_SECRET must be at least 32 bytes/i);
});

test('VERCEL_ENV=production enforces production security without NODE_ENV', () => {
  const result = loadProductionConfig({
    NODE_ENV: undefined,
    VERCEL_ENV: 'production',
    AUTH_PASSWORD: 'plaintext-frontend'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_PASSWORD is not allowed in production/i);
});

test('dotenv production mode is loaded before security validation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quickshare-config-'));
  fs.writeFileSync(path.join(directory, '.env'), [
    'NODE_ENV=production',
    'AUTH_ENABLED=true',
    `ADMIN_PASSWORD_HASH=${validHash}`,
    `ADMIN_DASHBOARD_PASSWORD_HASH=${validHash}`,
    `SESSION_SECRET=${validSessionSecret}`,
    'AUTH_PASSWORD=plaintext-from-dotenv'
  ].join('\n'));

  try {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AUTH_PASSWORD is not allowed in production/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production accepts hash-only authentication configuration', () => {
  const result = loadProductionConfig();

  assert.equal(result.status, 0, result.stderr);
});

test('production may disable authentication without hashes but still rejects plaintext variables', () => {
  const disabled = loadProductionConfig({
    AUTH_ENABLED: 'false',
    ADMIN_PASSWORD_HASH: '',
    ADMIN_DASHBOARD_PASSWORD_HASH: ''
  });
  const disabledWithPlaintext = loadProductionConfig({
    AUTH_ENABLED: 'false',
    ADMIN_PASSWORD_HASH: '',
    ADMIN_DASHBOARD_PASSWORD_HASH: '',
    AUTH_PASSWORD: 'dormant-plaintext'
  });
  const disabledWithoutSecret = loadProductionConfig({
    AUTH_ENABLED: 'false',
    ADMIN_PASSWORD_HASH: '',
    ADMIN_DASHBOARD_PASSWORD_HASH: '',
    SESSION_SECRET: ''
  });

  assert.equal(disabled.status, 0, disabled.stderr);
  assert.notEqual(disabledWithPlaintext.status, 0);
  assert.match(disabledWithPlaintext.stderr, /AUTH_PASSWORD is not allowed in production/i);
  assert.notEqual(disabledWithoutSecret.status, 0);
  assert.match(disabledWithoutSecret.stderr, /SESSION_SECRET is required in production/i);
});

test('production launcher contains no embedded password or world-writable session setup', () => {
  const launcher = fs.readFileSync(path.join(projectRoot, 'start-production.sh'), 'utf8');

  assert.doesNotMatch(launcher, /AUTH_PASSWORD\s*=/);
  assert.doesNotMatch(launcher, /chmod\s+777/);
  assert.match(launcher, /exec\s+node\b/);
});
