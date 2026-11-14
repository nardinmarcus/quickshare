'use strict';

// API credential identity for the v1 API (ticket T05, issue #29).
//
// Two credential kinds can call the v1 API:
// - the legacy environment-variable Key (`SHARE_API_KEY`), a single shared
//   secret with no database row, no ID and no rotation from inside the app;
// - managed Keys stored in `api_keys`, each with a stable logical ID and a
//   `credential_version` that starts at 1 and advances on every rotation.
//
// Authentication records the identity it verified on the request, including
// the managed Key's credential version at that moment. A publishing write
// then re-checks, inside its own transaction and under the Key row lock,
// that the recorded version is still current: if a rotation or a delete
// committed in between, the write is refused with
// ApiKeyCredentialChangedError instead of silently publishing under a
// credential the owner has already revoked. Rotation therefore keeps the
// logical Key ID while invalidating every previously verified secret.
//
// Credential versions are decimal strings in JSON (the database column is
// BIGINT), mirroring the Share access_revision convention (T01).

const MANAGED_API_KEY_PATTERN = /^qs\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,})$/;
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const API_KEY_CREDENTIAL_CHANGED_CODE = 'api_key_credential_changed';

class ApiKeyCredentialChangedError extends Error {
  constructor(message = 'API key credential changed after it was verified; retry with the current credential') {
    super(message);
    this.name = 'ApiKeyCredentialChangedError';
    this.code = API_KEY_CREDENTIAL_CHANGED_CODE;
    this.status = 401;
    this.retryable = false;
  }
}

function isApiKeyCredentialChangedError(error) {
  return Boolean(error) && (
    error instanceof ApiKeyCredentialChangedError
    || error.code === API_KEY_CREDENTIAL_CHANGED_CODE
  );
}

// Parses a presented managed credential `qs.<id>.<secret>`. Returns null
// for anything that is not shaped like a managed Key (including the legacy
// shared secret, which is compared separately).
function parseManagedApiKeyCredential(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = MANAGED_API_KEY_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  return { id: match[1], secret: match[2] };
}

function toCredentialVersionString(value) {
  if (value === undefined || value === null || value === '') {
    return '1';
  }

  if (typeof value === 'bigint') {
    return value > 0n ? value.toString() : '1';
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '1';
  }

  if (typeof value === 'string' && DECIMAL_INTEGER_PATTERN.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed > 0n ? parsed.toString() : '1';
  }

  return '1';
}

function nextCredentialVersion(value) {
  return (BigInt(toCredentialVersionString(value)) + 1n).toString();
}

function credentialVersionMatches(current, expected) {
  if (current === undefined || current === null || expected === undefined || expected === null) {
    return false;
  }

  return toCredentialVersionString(current) === toCredentialVersionString(expected);
}

// --- Scopes (T12, issue #36) ---------------------------------------------
//
// Operation permissions use scopes (parent spec #24 §6): a scope says
// what KIND of operation a credential may attempt; a per-Share grant
// (utils/shareGrants.js) says WHICH Shares it may touch. Authorization
// for a managed resource is always the conjunction of the two. The
// scope vocabulary is fixed; create (T05/T08), read (T12) and update
// (T13) have consuming routes, while publish remains vocabulary for a
// later ticket — and the admin only assigns the scopes whose behavior
// is implemented (see app.js).
const API_KEY_SCOPES = Object.freeze([
  'share:create',
  'share:read',
  'share:update',
  'share:publish'
]);

const CREATE_ONLY_API_KEY_SCOPES = Object.freeze(['share:create']);

// The scopes with no stored representation: a row predating migration
// 010, or an unparseable stored value, is create-only — the upgrade
// default — never silently more.
function parseApiKeyScopes(value) {
  let parsed = value;

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed) {
      return [...CREATE_ONLY_API_KEY_SCOPES];
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return [...CREATE_ONLY_API_KEY_SCOPES];
    }
  }

  if (!Array.isArray(parsed)) {
    return [...CREATE_ONLY_API_KEY_SCOPES];
  }

  const present = new Set(
    parsed.filter(scope => typeof scope === 'string' && API_KEY_SCOPES.includes(scope))
  );

  return API_KEY_SCOPES.filter(scope => present.has(scope));
}

// Normalizes a caller-supplied scope list for storage. Returns null
// when any entry is not a known scope, so write paths can refuse the
// input instead of silently dropping a scope the owner asked for.
function normalizeApiKeyScopes(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const present = new Set();

  for (const scope of value) {
    if (typeof scope !== 'string' || !API_KEY_SCOPES.includes(scope)) {
      return null;
    }

    present.add(scope);
  }

  return API_KEY_SCOPES.filter(scope => present.has(scope));
}

function serializeApiKeyScopes(scopes) {
  return JSON.stringify(parseApiKeyScopes(scopes));
}

// The identity recorded on a request after a managed Key verifies. Only
// non-secret fields are kept: the secret itself is never stored on the
// request, logged, or returned after authentication.
function managedCredentialIdentity(apiKeyRow) {
  return {
    type: 'managed',
    keyId: apiKeyRow.id,
    name: apiKeyRow.name,
    credentialVersion: toCredentialVersionString(apiKeyRow.credential_version),
    scopes: parseApiKeyScopes(apiKeyRow.scopes)
  };
}

// The legacy environment-variable credential has no logical Key ID and no
// credential version: it can only be replaced by changing the environment
// and restarting, which invalidates every in-flight process anyway. It is
// create-only by construction (parent spec #24 §6): no stored scopes,
// and management capabilities are never granted to it.
function legacyCredentialIdentity() {
  return {
    type: 'legacy',
    keyId: null,
    name: null,
    credentialVersion: null,
    scopes: [...CREATE_ONLY_API_KEY_SCOPES]
  };
}

module.exports = {
  API_KEY_CREDENTIAL_CHANGED_CODE,
  API_KEY_SCOPES,
  CREATE_ONLY_API_KEY_SCOPES,
  ApiKeyCredentialChangedError,
  credentialVersionMatches,
  isApiKeyCredentialChangedError,
  legacyCredentialIdentity,
  managedCredentialIdentity,
  nextCredentialVersion,
  normalizeApiKeyScopes,
  parseApiKeyScopes,
  parseManagedApiKeyCredential,
  serializeApiKeyScopes,
  toCredentialVersionString
};
