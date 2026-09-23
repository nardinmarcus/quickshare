const bytes = require('bytes');
const { MARKDOWN_THEME_CATALOG } = require('./markdownThemeCatalog');

const CONTENT_TYPES = Object.freeze(['html', 'markdown', 'svg', 'mermaid']);
const CREATE_SHARE = Object.freeze({ id: 'share:create', method: 'POST', path: '/api/v1/share' });
const SHARE_CREATE_STATUS = Object.freeze({ id: 'share:create:status', method: 'GET', path: '/api/v1/operations/:requestId' });
// Read-only resource APIs (#36): each also requires a per-Share read grant;
// scopes filter what a credential MAY ask for, grants decide what it sees.
const SHARE_LIST = Object.freeze({ id: 'share:list', method: 'GET', path: '/api/v1/shares' });
const SHARE_CONTENT_READ = Object.freeze({ id: 'share:content:read', method: 'GET', path: '/api/v1/shares/:id/content' });
const SHARE_STATE_READ = Object.freeze({ id: 'share:state:read', method: 'GET', path: '/api/v1/shares/:id/state' });
const SHARE_CONTENT_UPDATE = Object.freeze({ id: 'share:content:update', method: 'PUT', path: '/api/v1/shares/:id/content' });
const IMPLEMENTED_SCOPES = Object.freeze(['share:create', 'share:read', 'share:update']);
const NOT_IMPLEMENTED_SCOPES = Object.freeze(['share:publish']);

// Managed Key conditional content updates share the existing operation
// ledger; publication-state writes remain unavailable until their ticket.

// Shared by HTTP parsing, discovery and the dashboard API documentation.
// These are request-body limits, not a promise about raw Share content size.
function apiCapabilities(config) {
  const shareRequestBodyBytes = bytes.parse(config.shareBodyLimit);
  const smallRequestBodyBytes = bytes.parse(config.smallBodyLimit);
  if (![shareRequestBodyBytes, smallRequestBodyBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('HTTP body limits must resolve to positive integer bytes');
  }
  return Object.freeze({
    protocolVersion: '1',
    contentTypes: CONTENT_TYPES,
    markdownThemePresets: MARKDOWN_THEME_CATALOG.map(preset => preset.id),
    limits: { shareRequestBodyBytes, smallRequestBodyBytes, rawContentBytes: null },
    operations: [CREATE_SHARE, SHARE_CREATE_STATUS, SHARE_LIST, SHARE_CONTENT_READ, SHARE_STATE_READ, SHARE_CONTENT_UPDATE],
    // Truthful scope surface: content update is live; publish-state writes
    // stay unadvertised until their ticket lands.
    scopes: Object.freeze({
      implemented: IMPLEMENTED_SCOPES,
      notImplemented: NOT_IMPLEMENTED_SCOPES
    }),
    idempotency: Object.freeze({
      header: 'Idempotency-Key',
      pattern: '^[A-Za-z0-9_-]{16,128}$',
      appliesTo: ['share:create', 'share:content:update'],
      conflictStatus: 409,
      replayRequiresSameInput: true
    })
  });
}

module.exports = {
  CONTENT_TYPES,
  CREATE_SHARE,
  SHARE_CREATE_STATUS,
  SHARE_LIST,
  SHARE_CONTENT_READ,
  SHARE_STATE_READ,
  SHARE_CONTENT_UPDATE,
  IMPLEMENTED_SCOPES,
  NOT_IMPLEMENTED_SCOPES,
  apiCapabilities
};
