'use strict';

// The single definition of what the v1 API actually supports (ticket T05,
// issue #29). `GET /api/v1/capabilities` serializes this module, the Share
// creation route enforces the same content types and body limits, and
// docs/api-capabilities.md describes the same shape — so the documented
// capabilities cannot drift away from the real HTTP behavior.
//
// Scopes and per-Share grants arrived with T12 (issue #36): a managed Key
// now reports ITS OWN scopes, and the read-only management operations are
// advertised only to a managed credential whose scopes include them. The
// legacy environment Key is create-only by construction and never sees a
// management operation here. Nothing in this definition may advertise an
// operation the routes do not implement. The granted content update
// (T13, issue #37) is the one management write: it is advertised only to
// a managed credential holding BOTH the read and update scopes, because
// that is exactly the conjunction its route enforces — the per-Share
// update grant is additionally required at call time and, being
// per-resource data, is never part of this document. The publish scope
// remains stored vocabulary for a later ticket, not a capability.

const config = require('../config');
const { getMarkdownThemeOptions } = require('./markdownThemeCatalog');
const { parseApiKeyScopes } = require('./apiKeyIdentity');

const API_PROTOCOL_VERSION = 1;

// The four Share content types, in canonical order. app.js builds its
// accepted-type set from this list.
const API_CONTENT_TYPES = Object.freeze(['html', 'markdown', 'svg', 'mermaid']);

// The scopes a credential with no stored scope row holds (the legacy Key,
// and a managed Key migrated by 010 before any owner edit): create-only.
const CREATE_ONLY_SCOPES = Object.freeze(['share:create']);

const SHARE_CREATE_OPERATION = Object.freeze({
  id: 'share.create',
  method: 'POST',
  path: '/api/v1/share'
});

// Read-only resource management (T12). Each operation additionally
// requires the matching per-Share grant at call time; the capabilities
// document advertises the operation when the credential's scopes allow
// attempting it, never the grants themselves (per-resource data does
// not belong in a connection document).
const SHARE_LIST_OPERATION = Object.freeze({
  id: 'share.list',
  method: 'GET',
  path: '/api/v1/shares',
  pagination: Object.freeze({ defaultLimit: 20, maxLimit: 100, cursor: 'opaque' })
});

const SHARE_CONTENT_READ_OPERATION = Object.freeze({
  id: 'share.content.read',
  method: 'GET',
  path: '/api/v1/shares/:id/content'
});

const SHARE_STATE_READ_OPERATION = Object.freeze({
  id: 'share.state.read',
  method: 'GET',
  path: '/api/v1/shares/:id/state'
});

// Granted content update (T13): full-snapshot replacement of one
// granted Share's content. Requires the read AND update scopes plus an
// update grant on the target, a concrete content If-Match and an
// Idempotency-Key; it reuses the dashboard content transaction, so its
// result is confirmable through operation.status in the caller's own
// namespace exactly like a create.
const SHARE_CONTENT_UPDATE_OPERATION = Object.freeze({
  id: 'share.content.update',
  method: 'PUT',
  path: '/api/v1/shares/:id/content'
});

const CONNECTION_OPERATIONS = Object.freeze([
  Object.freeze({ id: 'connection.me', method: 'GET', path: '/api/v1/me' }),
  Object.freeze({ id: 'connection.capabilities', method: 'GET', path: '/api/v1/capabilities' }),
  // Operation confirmation (T08): scoped to the caller's own credential
  // namespace and part of the create capability — it confirms what a
  // create did, it does not manage Shares.
  Object.freeze({ id: 'operation.status', method: 'GET', path: '/api/v1/operations/:requestId' })
]);

function parseByteLimit(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value || '').trim());

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Math.floor(amount * multipliers[unit]);
}

function getMarkdownThemePresetIds() {
  return getMarkdownThemeOptions().map(option => option.id);
}

// The capabilities document for one verified credential. `credentialType`
// is 'managed' or 'legacy'; `scopes` is the credential's own effective
// scope list (managed Keys read theirs from the stored row; the legacy
// Key is always create-only). The document contains no secret material
// and no per-resource data: it describes the API surface, never other
// Keys, Shares or grants.
function buildCapabilities({ credentialType, scopes } = {}) {
  const isManaged = credentialType === 'managed';
  const effectiveScopes = isManaged
    ? parseApiKeyScopes(scopes === undefined ? [...CREATE_ONLY_SCOPES] : scopes)
    : [...CREATE_ONLY_SCOPES];
  const hasScope = scope => effectiveScopes.includes(scope);

  const operations = [];

  if (hasScope('share:create')) {
    operations.push({ ...SHARE_CREATE_OPERATION });
  }

  operations.push(...CONNECTION_OPERATIONS.map(operation => ({ ...operation })));

  // Read-only management (T12): managed credentials only, and only the
  // operations the credential's scopes actually allow attempting. The
  // state read matches either the read or the publish scope (whichever
  // grant kind the Share carries); the list and content reads are read
  // operations. A publish-scope-only credential is told about the state
  // read and the (metadata-neutralized) list, never about content.
  const readOperations = [];

  if (isManaged && (hasScope('share:read') || hasScope('share:update') || hasScope('share:publish'))) {
    readOperations.push({
      ...SHARE_LIST_OPERATION,
      pagination: { ...SHARE_LIST_OPERATION.pagination }
    });
  }

  if (isManaged && hasScope('share:read')) {
    readOperations.push({ ...SHARE_CONTENT_READ_OPERATION });
  }

  if (isManaged && (hasScope('share:read') || hasScope('share:publish'))) {
    readOperations.push({ ...SHARE_STATE_READ_OPERATION });
  }

  operations.push(...readOperations);

  // Granted content update (T13): advertised only when the credential
  // could actually attempt it — managed, holding BOTH the read and the
  // update scope. The grant half of the conjunction is per-resource
  // data and stays out of this document.
  const canUpdate = isManaged && hasScope('share:read') && hasScope('share:update');

  if (canUpdate) {
    operations.push({ ...SHARE_CONTENT_UPDATE_OPERATION });
  }

  const conditionalWrites = [];

  if (hasScope('share:create')) {
    conditionalWrites.push({
      operation: SHARE_CREATE_OPERATION.id,
      requiresIfMatch: false,
      requiresIdempotencyKey: false,
      // Optional idempotent create (T08): sending an Idempotency-Key
      // makes the create safe to retry — the same key with the same
      // input replays the original result, the same key with different
      // input is refused, and a committed outcome stays confirmable
      // via operation.status. Without the header the create is NOT
      // idempotent and behaves exactly as before.
      idempotency: {
        header: 'Idempotency-Key',
        required: false,
        replaySupported: true,
        keyFormat: '16-128 characters of [A-Za-z0-9_-]; clients generate a UUID v4',
        confirmationOperation: 'operation.status',
        conflict: { status: 409, code: 'idempotency_conflict', retryable: false },
        resultUnavailable: { status: 410, code: 'operation_result_unavailable', retryable: false },
        invalidKey: { status: 400, code: 'invalid_idempotency_key', retryable: false }
      },
      // Publishing writes pass the write-maintenance gate (T04): during
      // a maintenance window creation is refused, while the connection
      // checks (me / capabilities) stay available.
      maintenanceRefusal: { status: 503, code: 'maintenance', retryable: true },
      // A managed-Key write re-verifies the credential version it first
      // authenticated with; a rotation or delete that committed first
      // refuses the write with 401 instead of publishing (T05).
      credentialRecheck: { status: 401, code: 'api_key_credential_changed', retryable: false }
    });
  }

  if (canUpdate) {
    conditionalWrites.push({
      operation: SHARE_CONTENT_UPDATE_OPERATION.id,
      requiresIfMatch: true,
      requiresIdempotencyKey: true,
      // Mandatory idempotent update (T13): the Idempotency-Key is not
      // optional here — without it the write is refused 400 — and the
      // concrete content If-Match names the exact Revision the caller
      // based its snapshot on. A retry with the same identifier and
      // input replays the committed result (even after the tag has
      // gone stale); the same identifier with different input is a
      // 409; the outcome stays confirmable via operation.status.
      idempotency: {
        header: 'Idempotency-Key',
        required: true,
        replaySupported: true,
        keyFormat: '16-128 characters of [A-Za-z0-9_-]; clients generate a UUID v4',
        confirmationOperation: 'operation.status',
        conflict: { status: 409, code: 'idempotency_conflict', retryable: false },
        resultUnavailable: { status: 410, code: 'operation_result_unavailable', retryable: false },
        invalidKey: { status: 400, code: 'invalid_idempotency_key', retryable: false }
      },
      maintenanceRefusal: { status: 503, code: 'maintenance', retryable: true },
      // The write re-verifies, inside its transaction, both the
      // credential version it first authenticated with and the
      // caller's current grant: a rotation, deletion or revocation
      // that committed first refuses the write (401 / 404) instead of
      // letting it land under an authorization that no longer exists.
      credentialRecheck: { status: 401, code: 'api_key_credential_changed', retryable: false }
    });
  }

  const document = {
    protocolVersion: API_PROTOCOL_VERSION,
    credentialType: credentialType || null,
    scopes: effectiveScopes,
    operations,
    contentTypes: [...API_CONTENT_TYPES],
    markdownThemePresets: getMarkdownThemePresetIds(),
    limits: {
      shareRequestBody: config.shareBodyLimit,
      shareRequestBodyBytes: parseByteLimit(config.shareBodyLimit),
      smallRequestBody: config.smallBodyLimit,
      smallRequestBodyBytes: parseByteLimit(config.smallBodyLimit)
    },
    conditionalWrites
  };

  if (readOperations.length > 0) {
    // Conditional reads (T12): the content and state representations
    // carry SEPARATE strong ETags (parent spec #24 §4) — a content tag
    // never validates a state response or vice versa. If-None-Match is
    // evaluated with the RFC 7232 weak comparison for GET: a weak tag
    // naming the current representation, or `*`, answers 304. Both
    // responses are private/no-store; no shared cache is involved.
    document.conditionalReads = readOperations
      .filter(operation => operation.id !== SHARE_LIST_OPERATION.id)
      .map(operation => ({
        operation: operation.id,
        etagFormat: operation.id === SHARE_CONTENT_READ_OPERATION.id
          ? '"content:<Share ID>:<Revision>"'
          : '"access:<Share ID>:<Access Revision>"',
        ifNoneMatch: { weakComparison: true, notModifiedStatus: 304 },
        cacheControl: 'private, no-store'
      }));
    // Authorization failures are part of the read contract (parent spec
    // #24 §6): no/invalid credential 401, missing operation scope 403,
    // scope held but no matching grant on the target 404 — the 404
    // never distinguishes "exists but not granted" from "absent".
    document.managementAuthorization = {
      unauthenticated: { status: 401 },
      missingScope: { status: 403, code: 'insufficient_scope', retryable: false },
      noGrant: { status: 404, code: 'share_not_found', retryable: false }
    };
  }

  return document;
}

module.exports = {
  API_CONTENT_TYPES,
  API_PROTOCOL_VERSION,
  CONNECTION_OPERATIONS,
  CREATE_ONLY_SCOPES,
  SHARE_CONTENT_READ_OPERATION,
  SHARE_CONTENT_UPDATE_OPERATION,
  SHARE_CREATE_OPERATION,
  SHARE_LIST_OPERATION,
  SHARE_STATE_READ_OPERATION,
  buildCapabilities,
  getMarkdownThemePresetIds,
  parseByteLimit
};
