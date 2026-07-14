const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const DEFAULT_PASSWORD_LENGTH = 6;
const CUSTOM_PASSWORD_ERROR = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';
const CUSTOM_PASSWORD_PATTERN = /^[A-Za-z0-9!@#$%^&*()_+\-=.,?~]{4,12}$/;
const ENCRYPTED_SECRET_PREFIX = 'secret-v1';

function getAppSecret() {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }

  return secret || 'dev-only-change-me';
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function generateId(byteLength = 9) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function generateNumericPassword(length = DEFAULT_PASSWORD_LENGTH) {
  let password = '';

  for (let index = 0; index < length; index += 1) {
    password += crypto.randomInt(0, 10).toString();
  }

  return password;
}

function isValidCustomPassword(password) {
  return typeof password === 'string' && CUSTOM_PASSWORD_PATTERN.test(password);
}

function parseCustomPassword(password) {
  if (password === undefined || password === null || password === '') {
    return {
      provided: false,
      value: null,
      error: null
    };
  }

  if (!isValidCustomPassword(password)) {
    return {
      provided: true,
      value: null,
      error: CUSTOM_PASSWORD_ERROR
    };
  }

  return {
    provided: true,
    value: password,
    error: null
  };
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await scryptAsync(String(secret), salt, 64);

  return `scrypt$${salt}$${key.toString('base64url')}`;
}

async function verifySecret(secret, storedValue) {
  if (!storedValue) {
    return false;
  }

  if (!storedValue.startsWith('scrypt$')) {
    return timingSafeEqualString(secret, storedValue);
  }

  const [, salt, expectedKey] = storedValue.split('$');

  if (!salt || !expectedKey) {
    return false;
  }

  const key = await scryptAsync(String(secret), salt, 64);
  return timingSafeEqualString(key.toString('base64url'), expectedKey);
}

function encryptionKey() {
  return crypto
    .createHash('sha256')
    .update(`quickshare:encrypted-secret:${getAppSecret()}`)
    .digest();
}

function encryptSecret(secret) {
  if (!secret) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(secret), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_SECRET_PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url')
  ].join('$');
}

function decryptSecret(storedValue) {
  if (!storedValue || typeof storedValue !== 'string') {
    return null;
  }

  const [prefix, iv, authTag, encrypted] = storedValue.split('$');

  if (prefix !== ENCRYPTED_SECRET_PREFIX || !iv || !authTag || !encrypted) {
    return null;
  }

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(iv, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    return null;
  }
}

function signPayload(payload, options = {}) {
  const secret = options.secret || getAppSecret();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
}

function verifyPayload(token, options = {}) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const secret = options.secret || getAppSecret();
  const [body, signature] = token.split('.');

  if (!body || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  if (!timingSafeEqualString(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

function createScopedToken(scope, payload, ttlMs) {
  const now = Date.now();

  return signPayload({
    ...payload,
    scope,
    iat: now,
    exp: now + ttlMs
  });
}

function verifyScopedToken(token, scope) {
  const payload = verifyPayload(token);

  if (!payload || payload.scope !== scope) {
    return null;
  }

  return payload;
}

function createCsrfToken(sessionToken) {
  return crypto
    .createHmac('sha256', getAppSecret())
    .update(`csrf:${sessionToken}`)
    .digest('base64url');
}

function verifyCsrfToken(sessionToken, csrfToken) {
  if (!sessionToken || !csrfToken) {
    return false;
  }

  return timingSafeEqualString(createCsrfToken(sessionToken), csrfToken);
}

module.exports = {
  CUSTOM_PASSWORD_ERROR,
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  createScopedToken,
  decryptSecret,
  encryptSecret,
  generateId,
  generateNumericPassword,
  getAppSecret,
  hashSecret,
  isValidCustomPassword,
  parseCustomPassword,
  timingSafeEqualString,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
};
