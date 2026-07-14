const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCsrfToken,
  createScopedToken,
  decryptSecret,
  encryptSecret,
  hashSecret,
  isValidCustomPassword,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
} = require('../utils/security');

test('custom passwords accept only the approved 4-12 character ASCII allowlist', () => {
  assert.equal(isValidCustomPassword('Abc1'), true);
  assert.equal(isValidCustomPassword('Abcdef123!~?'), true);

  for (const symbol of '!@#$%^&*()_+-=.,?~') {
    assert.equal(isValidCustomPassword(`Ab1${symbol}`), true, `expected ${symbol} to be allowed`);
  }

  for (const password of [
    'Ab1',
    'Abcdef1234567',
    ' Abc1',
    'Abc1 ',
    'Ab c1',
    '密码Ab1',
    'Ａbc1',
    'Ab1🙂',
    'Ab1/',
    'Ab1:',
    'Ab1\\',
    'Ab1"',
    "Ab1'",
    'Ab1\n'
  ]) {
    assert.equal(isValidCustomPassword(password), false, `expected ${JSON.stringify(password)} to be rejected`);
  }
});

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
