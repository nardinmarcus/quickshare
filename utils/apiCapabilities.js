const bytes = require('bytes');
const { MARKDOWN_THEME_CATALOG } = require('./markdownThemeCatalog');

const CONTENT_TYPES = Object.freeze(['html', 'markdown', 'svg', 'mermaid']);
const CREATE_SHARE = Object.freeze({ id: 'share:create', method: 'POST', path: '/api/v1/share', scope: 'share:create' });
const SHARE_CREATE_STATUS = Object.freeze({ id: 'share:create:status', method: 'GET', path: '/api/v1/operations/:requestId', scope: 'share:create' });
const SHARE_LIST = Object.freeze({ id: 'share:list', method: 'GET', path: '/api/v1/shares', scope: 'share:read', grant: 'can_read' });
const SHARE_CONTENT_READ = Object.freeze({ id: 'share:content:read', method: 'GET', path: '/api/v1/shares/:id/content', scope: 'share:read', grant: 'can_read' });
const SHARE_STATE_READ = Object.freeze({
  id: 'share:state:read',
  method: 'GET',
  path: '/api/v1/shares/:id/state',
  anyOf: Object.freeze([
    Object.freeze({ scope: 'share:read', grant: 'can_read' }),
    Object.freeze({ scope: 'share:publish', grant: 'can_publish' })
  ])
});
const SHARE_CONTENT_UPDATE = Object.freeze({ id: 'share:content:update', method: 'PUT', path: '/api/v1/shares/:id/content', scopes: Object.freeze(['share:read', 'share:update']), grants: Object.freeze(['can_read', 'can_update']) });
const SHARE_REVISIONS_READ = Object.freeze({ id: 'share:revisions:read', method: 'GET', path: '/api/v1/shares/:id/revisions', scope: 'share:read', grant: 'can_read' });
const SHARE_REVISION_READ = Object.freeze({ id: 'share:revision:read', method: 'GET', path: '/api/v1/shares/:id/revisions/:revision', scope: 'share:read', grant: 'can_read' });
const SHARE_RESTORE = Object.freeze({ id: 'share:restore', method: 'POST', path: '/api/v1/shares/:id/restore', scopes: Object.freeze(['share:read', 'share:update']), grants: Object.freeze(['can_read', 'can_update']) });
const SHARE_UNPUBLISH = Object.freeze({ id: 'share:unpublish', method: 'POST', path: '/api/v1/shares/:id/unpublish', scope: 'share:publish', grant: 'can_publish' });
const SHARE_REPUBLISH = Object.freeze({ id: 'share:republish', method: 'POST', path: '/api/v1/shares/:id/republish', scope: 'share:publish', grant: 'can_publish' });
const API_IDENTITY = Object.freeze({ id: 'identity:read', method: 'GET', path: '/api/v1/me' });
const API_CAPABILITIES = Object.freeze({ id: 'capabilities:read', method: 'GET', path: '/api/v1/capabilities' });
const IMPLEMENTED_SCOPES = Object.freeze(['share:create', 'share:read', 'share:update', 'share:publish']);
const NOT_IMPLEMENTED_SCOPES = Object.freeze([]);

// Shared by HTTP parsing, capability discovery, dashboard documentation and
// the bounded OpenAPI subset. Body limits count the decoded request body,
// not raw Share content bytes.
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
    operations: [CREATE_SHARE, SHARE_CREATE_STATUS, SHARE_LIST, SHARE_CONTENT_READ, SHARE_STATE_READ, SHARE_CONTENT_UPDATE,
      SHARE_REVISIONS_READ, SHARE_REVISION_READ, SHARE_RESTORE, SHARE_UNPUBLISH, SHARE_REPUBLISH,
      API_IDENTITY, API_CAPABILITIES],
    scopes: Object.freeze({
      implemented: IMPLEMENTED_SCOPES,
      notImplemented: NOT_IMPLEMENTED_SCOPES
    }),
    idempotency: Object.freeze({
      header: 'Idempotency-Key',
      pattern: '^[A-Za-z0-9_-]{16,128}$',
      appliesTo: ['share:create', 'share:content:update', 'share:restore', 'share:unpublish', 'share:republish'],
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
  SHARE_REVISIONS_READ,
  SHARE_REVISION_READ,
  SHARE_RESTORE,
  SHARE_UNPUBLISH,
  SHARE_REPUBLISH,
  API_IDENTITY,
  API_CAPABILITIES,
  IMPLEMENTED_SCOPES,
  NOT_IMPLEMENTED_SCOPES,
  apiCapabilities
};
