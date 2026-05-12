const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const DEFAULT_PASSWORD_LENGTH = 6;

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
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  createScopedToken,
  generateId,
  generateNumericPassword,
  getAppSecret,
  hashSecret,
  timingSafeEqualString,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
};
