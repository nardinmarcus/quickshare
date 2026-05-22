const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCsrfToken,
  createScopedToken,
  decryptSecret,
  encryptSecret,
  hashSecret,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
} = require('../utils/security');

test('hashSecret verifies only the original secret', async () => {
  const hash = await hashSecret('correct-password');

  assert.equal(await verifySecret('correct-password', hash), true);
  assert.equal(await verifySecret('wrong-password', hash), false);
});

test('encryptSecret stores recoverable secrets without plaintext', () => {
  const encrypted = encryptSecret('123456');

  assert.notEqual(encrypted, '123456');
  assert.match(encrypted, /^secret-v1\$/);
  assert.equal(decryptSecret(encrypted), '123456');
});

test('decryptSecret returns null for invalid encrypted values', () => {
  assert.equal(decryptSecret('scrypt$not-a-recoverable-secret'), null);
  assert.equal(decryptSecret('secret-v1$bad$value'), null);
});

test('scoped tokens reject the wrong scope', () => {
  const token = createScopedToken('admin', { user: 'admin' }, 60_000);

  assert.equal(verifyScopedToken(token, 'admin').user, 'admin');
  assert.equal(verifyScopedToken(token, 'page-access'), null);
});

test('csrf tokens are bound to the admin session token', () => {
  const sessionToken = createScopedToken('admin', {}, 60_000);
  const csrfToken = createCsrfToken(sessionToken);

  assert.equal(verifyCsrfToken(sessionToken, csrfToken), true);
  assert.equal(verifyCsrfToken('different-session', csrfToken), false);
});
