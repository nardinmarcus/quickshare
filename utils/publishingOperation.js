const { createHash, createHmac } = require('node:crypto');
const { decryptSecret, encryptSecret, getAppSecret } = require('./security');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const INVALID_REQUEST_ID_MESSAGE = 'Idempotency-Key must be 16-128 ASCII letters, digits, hyphens or underscores';
const NAMESPACE_MANAGED_KEY = 'managed-key';
const NAMESPACE_LEGACY_KEY = 'legacy-key';
const NAMESPACE_PUBLISH_SESSION = 'publish-session';
const NAMESPACE_DASHBOARD_SESSION = 'dashboard-session';

/**
 * Idempotency request ids come from clients. The parent contract accepts
 * 16-128 ASCII letters, digits, hyphens and underscores so ids are safe to
 * log, store and carry in URLs.
 */
function isvalidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function digestKeyMaterial() {
  return createHash('sha256')
    .update(`quickshare:operation-digest:${getAppSecret()}`)
    .digest();
}

/**
 * HMAC over the normalized request descriptor. Computed BEFORE any random
 * Share id, generated password, timestamp or time-derived title exists, so a
 * retried operation produces the same digest. The digest is keyed by the
 * application secret; request bodies and passwords are never stored.
 */
function operationRequestDigest({ action, targetId, fields, presence }) {
  // Canonical fixed-shape payload: normalized values plus, when the caller
  // provides it, the business-field presence map required by #24 L211.
  // Omitting the key entirely (clone intents) keeps clone digests stable.
  const canonical = presence === undefined
    ? JSON.stringify({ action, targetId: targetId === undefined ? null : targetId, fields })
    : JSON.stringify({ action, targetId: targetId === undefined ? null : targetId, fields, presence });
  return createHmac('sha256', digestKeyMaterial()).update(canonical, 'utf8').digest('hex');
}

function resolveApiCredentialNamespace(identity) {
  if (identity?.credentialKind === 'managed') {
    return `${NAMESPACE_MANAGED_KEY}:${identity.id}`;
  }
  if (identity?.credentialKind === 'legacy' && typeof identity.legacySecret === 'string') {
    // Irreversible fingerprint of the legacy secret: rotating the environment
    // variable starts a fresh namespace without ever storing the secret.
    const fingerprint = createHash('sha256').update(`quickshare:legacy-key:${identity.legacySecret}`).digest('hex');
    return `${NAMESPACE_LEGACY_KEY}:${fingerprint}`;
  }
  throw new Error('API credential namespace requires a verified identity');
}

function resolveBrowserPublishNamespace(sessionId) {
  return `${NAMESPACE_PUBLISH_SESSION}:${sessionId}`;
}

function resolveDashboardSessionNamespace(fingerprint) {
  return `${NAMESPACE_DASHBOARD_SESSION}:${fingerprint}`;
}

function namespaceKind(actorNamespace) {
  const kind = String(actorNamespace || '').split(':', 1)[0];
  return [
    NAMESPACE_MANAGED_KEY,
    NAMESPACE_LEGACY_KEY,
    NAMESPACE_PUBLISH_SESSION,
    NAMESPACE_DASHBOARD_SESSION
  ].includes(kind) ? kind : 'unknown';
}

/**
 * The creation receipt (e.g. the generated password) is the only sensitive
 * replay material. It reuses the existing secret-encryption capability and is
 * cleared when the resulting Share is deleted.
 */
function encodeOperationReceipt(receipt) {
  if (!receipt) return null;
  return encryptSecret(JSON.stringify(receipt));
}

function decodeOperationReceipt(encoded) {
  if (!encoded) return null;
  const raw = decryptSecret(encoded);
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw);
    return receipt && typeof receipt === 'object' ? receipt : null;
  } catch {
    return null;
  }
}

module.exports = {
  INVALID_REQUEST_ID_MESSAGE,
  isvalidRequestId,
  operationRequestDigest,
  resolveApiCredentialNamespace,
  resolveBrowserPublishNamespace,
  resolveDashboardSessionNamespace,
  namespaceKind,
  encodeOperationReceipt,
  decodeOperationReceipt
};
