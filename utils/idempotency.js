'use strict';

// Publish-operation idempotency (ticket T08, issue #32; parent spec #24
// §8). A create or clone that carries a client request identifier is
// executed at most once per credential namespace:
//
// - the identifier travels in the `Idempotency-Key` header (API and
//   browser create) or the clone form's `requestId` field; clients
//   generate UUID v4 values, and the server accepts 16–128 characters of
//   ASCII letters, digits, hyphens and underscores, rejecting everything
//   else — the identifier is a dedup key, never a credential;
// - the namespace is derived from the verified identity (managed Key
//   logical ID, an irreversible fingerprint of the legacy Key, the
//   dashboard owner session, or the signed anonymous publish session), so
//   a receipt can never be replayed across credentials; Key rotation
//   keeps the logical ID, so the new secret can still confirm operations
//   the old secret committed;
// - the request digest is an HMAC, keyed by a secret derived from the
//   application secret, over the action, the target, per-field presence
//   bits and the normalized input. It is computed BEFORE any random ID,
//   generated password or timestamp exists, so a retry of the same
//   intent digests identically while a genuinely new publish intent —
//   which always carries a fresh identifier — is never deduplicated.
//   Neither the request body nor any password is ever stored: the stored
//   HMAC is one-way, and the receipt keeps only the response fields,
//   encrypted, with no content body.

const crypto = require('crypto');
const { getAppSecret } = require('./security');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const IDEMPOTENCY_CONFLICT_CODE = 'idempotency_conflict';
const OPERATION_RESULT_UNAVAILABLE_CODE = 'operation_result_unavailable';

// Same identifier, different input: the identifier was already committed
// for another payload, so the request is refused (409) instead of
// creating a second Share or replaying the wrong result.
class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency-Key was already used with a different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.code = IDEMPOTENCY_CONFLICT_CODE;
    this.status = 409;
    this.retryable = false;
  }
}

function isIdempotencyConflictError(error) {
  return Boolean(error) && (
    error instanceof IdempotencyConflictError || error.code === IDEMPOTENCY_CONFLICT_CODE
  );
}

// The operation committed, but its result no longer exists (the Share was
// fully deleted and the record kept only as a dedup tombstone). The retry
// must not resurrect or replace the result (410).
class OperationResultUnavailableError extends Error {
  constructor(message = 'The operation committed, but its result is no longer available') {
    super(message);
    this.name = 'OperationResultUnavailableError';
    this.code = OPERATION_RESULT_UNAVAILABLE_CODE;
    this.status = 410;
    this.retryable = false;
  }
}

function isOperationResultUnavailableError(error) {
  return Boolean(error) && (
    error instanceof OperationResultUnavailableError
    || error.code === OPERATION_RESULT_UNAVAILABLE_CODE
  );
}

// Parses an Idempotency-Key header (or clone form field). Absent is a
// legitimate legacy request that creates without dedup; present but
// malformed is a client error — the value must never be silently ignored,
// or the client would believe an unkeyed create was idempotent.
function parseIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') {
    return { provided: false, valid: false, value: null };
  }

  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return { provided: true, valid: false, value: null };
  }

  return { provided: true, valid: true, value };
}

// Client request identifiers are UUID v4 (§8). randomUUID is available on
// every supported runtime; the server itself does not mint identifiers
// for API callers — this helper exists for the operator/drill tooling and
// tests that act as clients.
function generateRequestId() {
  return crypto.randomUUID();
}

function deriveKey(label) {
  return crypto
    .createHmac('sha256', getAppSecret())
    .update(`quickshare:${label}`)
    .digest();
}

function hmacHex(label, value) {
  return crypto.createHmac('sha256', deriveKey(label)).update(String(value)).digest('hex');
}

// --- Credential namespaces -------------------------------------------------
//
// A namespace string is stored on the operation record; it is an internal
// dedup scope, never returned to clients (the operations query reports
// only the actor KIND). The legacy fingerprint is an irreversible HMAC of
// the environment secret, so replacing SHARE_API_KEY (its only "rotation")
// moves old operations into a namespace the new secret cannot reach —
// exactly the isolation the spec requires for the legacy credential.

function managedKeyNamespace(keyId) {
  return `key:managed:${keyId}`;
}

function legacyKeyNamespace(legacySecret) {
  return `key:legacy:${hmacHex('legacy-key-fingerprint', legacySecret || '')}`;
}

function dashboardNamespace() {
  return 'session:dashboard-owner';
}

function browserOwnerNamespace() {
  return 'session:browser-owner';
}

// The anonymous publish session is identified by the random session id
// inside its signed cookie; only its HMAC is ever stored or compared.
function publishSessionNamespace(sessionId) {
  return `session:publish:${hmacHex('publish-session-namespace', sessionId || '')}`;
}

// A short non-secret fingerprint of a namespace, rendered into the
// homepage so the browser client can bind a stored pending publish to the
// session that minted it (the cookie itself is httpOnly). Two tabs share
// one cookie, but a cleared/rotated session changes the tag, and a
// pending pair from the old session must not be silently submitted under
// the new namespace.
function namespaceTag(namespace) {
  return hmacHex('namespace-tag', namespace).slice(0, 16);
}

function namespaceKind(namespace) {
  if (typeof namespace !== 'string') {
    return null;
  }

  if (namespace.startsWith('key:managed:')) return 'managed_key';
  if (namespace.startsWith('key:legacy:')) return 'legacy_key';
  if (namespace.startsWith('session:dashboard-owner')) return 'dashboard';
  if (namespace.startsWith('session:browser-owner')) return 'browser_owner';
  if (namespace.startsWith('session:publish:')) return 'publish_session';
  return 'unknown';
}

// --- Request digest --------------------------------------------------------
//
// Canonical JSON with recursively sorted keys, so the digest does not
// depend on property order in the parsed request body.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

// The digest covers the action, the target (source Share for a clone,
// null for a create), field presence, and the normalized input values.
// `presence` maps a field name to whether the caller actually supplied a
// non-null value for it: supplying a field and omitting it are different
// requests even when the effective defaults would coincide (the one
// documented fold is that an explicit null counts as not supplied, the
// same way the create route itself treats null as absent). The custom
// password participates through the HMAC input only — it is never stored.
function computeRequestHmac({ action, targetId = null, presence = {}, values = {} }) {
  const payload = canonicalJson({
    action,
    target: targetId ?? null,
    presence,
    values
  });

  return crypto
    .createHmac('sha256', deriveKey('publish-request-digest'))
    .update(payload)
    .digest('hex');
}

function requestHmacMatches(stored, candidate) {
  if (typeof stored !== 'string' || typeof candidate !== 'string') {
    return false;
  }

  const left = Buffer.from(stored);
  const right = Buffer.from(candidate);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  IDEMPOTENCY_CONFLICT_CODE,
  OPERATION_RESULT_UNAVAILABLE_CODE,
  IdempotencyConflictError,
  OperationResultUnavailableError,
  browserOwnerNamespace,
  computeRequestHmac,
  dashboardNamespace,
  generateRequestId,
  isIdempotencyConflictError,
  isOperationResultUnavailableError,
  legacyKeyNamespace,
  managedKeyNamespace,
  namespaceKind,
  namespaceTag,
  parseIdempotencyKey,
  publishSessionNamespace,
  requestHmacMatches
};
