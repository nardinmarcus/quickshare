'use strict';

// The single definition of what the v1 API actually supports (ticket T05,
// issue #29). `GET /api/v1/capabilities` serializes this module, the Share
// creation route enforces the same content types and body limits, and
// docs/api-capabilities.md describes the same shape — so the documented
// capabilities cannot drift away from the real HTTP behavior.
//
// At this stage both credential kinds (legacy environment Key and managed
// Keys) are create-only: the only write operation is Share creation.
// Later tickets add scopes/grants and management operations by extending
// this definition; nothing here may advertise an operation the routes do
// not implement.

const config = require('../config');
const { getMarkdownThemeOptions } = require('./markdownThemeCatalog');

const API_PROTOCOL_VERSION = 1;

// The four Share content types, in canonical order. app.js builds its
// accepted-type set from this list.
const API_CONTENT_TYPES = Object.freeze(['html', 'markdown', 'svg', 'mermaid']);

// Effective scopes at the create-only stage. Stored scopes/grants arrive
// with later tickets; until then every valid credential holds exactly this
// list, for both credential kinds.
const CREATE_ONLY_SCOPES = Object.freeze(['share:create']);

const SHARE_CREATE_OPERATION = Object.freeze({
  id: 'share.create',
  method: 'POST',
  path: '/api/v1/share'
});

const CONNECTION_OPERATIONS = Object.freeze([
  Object.freeze({ id: 'connection.me', method: 'GET', path: '/api/v1/me' }),
  Object.freeze({ id: 'connection.capabilities', method: 'GET', path: '/api/v1/capabilities' })
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
// is 'managed' or 'legacy'; at the create-only stage both kinds receive the
// same operations and scopes. The document contains no secret material and
// no per-resource data: it describes the API surface, never other Keys or
// Shares.
function buildCapabilities({ credentialType } = {}) {
  return {
    protocolVersion: API_PROTOCOL_VERSION,
    credentialType: credentialType || null,
    scopes: [...CREATE_ONLY_SCOPES],
    operations: [
      { ...SHARE_CREATE_OPERATION },
      ...CONNECTION_OPERATIONS.map(operation => ({ ...operation }))
    ],
    contentTypes: [...API_CONTENT_TYPES],
    markdownThemePresets: getMarkdownThemePresetIds(),
    limits: {
      shareRequestBody: config.shareBodyLimit,
      shareRequestBodyBytes: parseByteLimit(config.shareBodyLimit),
      smallRequestBody: config.smallBodyLimit,
      smallRequestBodyBytes: parseByteLimit(config.smallBodyLimit)
    },
    conditionalWrites: [
      {
        operation: SHARE_CREATE_OPERATION.id,
        requiresIfMatch: false,
        requiresIdempotencyKey: false,
        // Publishing writes pass the write-maintenance gate (T04): during
        // a maintenance window creation is refused, while the connection
        // checks (me / capabilities) stay available.
        maintenanceRefusal: { status: 503, code: 'maintenance', retryable: true },
        // A managed-Key write re-verifies the credential version it first
        // authenticated with; a rotation or delete that committed first
        // refuses the write with 401 instead of publishing (T05).
        credentialRecheck: { status: 401, code: 'api_key_credential_changed', retryable: false }
      }
    ]
  };
}

module.exports = {
  API_CONTENT_TYPES,
  API_PROTOCOL_VERSION,
  CONNECTION_OPERATIONS,
  CREATE_ONLY_SCOPES,
  SHARE_CREATE_OPERATION,
  buildCapabilities,
  getMarkdownThemePresetIds,
  parseByteLimit
};
