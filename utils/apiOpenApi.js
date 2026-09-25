const DETAILS = Object.freeze({
  'share:create': {
    operationId: 'createShare', summary: 'Create a Share',
    description: 'Creates a Share. Idempotency-Key is optional for legacy compatibility; when supplied, a matching replay confirms the original result.',
    responses: ['200', '400', '401', '413', '503']
  },
  'share:create:status': {
    operationId: 'getOperationStatus', summary: 'Confirm an operation',
    description: 'Returns metadata only within the current credential namespace. Content-update and restore operations require their current scope and Share grant. Authorized publish-operation metadata includes the current canonical public URL only while the Share and result remain available; access-changed replays do not imply the committed state is still current.',
    responses: ['200', '400', '401', '403', '404', '410', '503']
  },
  'share:list': {
    operationId: 'listGrantedShares', summary: 'List readable Shares',
    description: 'Requires share:read and can_read grants. Publish-only grants are excluded.',
    responses: ['200', '400', '401', '403', '503']
  },
  'share:content:read': {
    operationId: 'getShareContent', summary: 'Read current Share content',
    description: 'Requires share:read and can_read for this Share. Returns the current content snapshot and a strong content ETag.',
    responses: ['200', '304', '401', '403', '404', '503']
  },
  'share:state:read': {
    operationId: 'getShareState', summary: 'Read minimal Share state',
    description: 'Requires either share:read with can_read, or share:publish with can_publish for this Share. Publish-only access reveals no title, description, body, list, history or content metadata. The response includes a server-generated current canonical public URL. GET always returns the URL-bearing representation; ETag remains the access-state write/CAS validator, not a conditional GET validator.',
    responses: ['200', '401', '403', '404', '503']
  },
  'share:content:update': {
    operationId: 'updateShareContent', summary: 'Conditionally replace Share content',
    description: 'Requires a managed Key with share:read and share:update plus can_read and can_update grants. Requires a concrete strong content If-Match and Idempotency-Key.',
    responses: ['200', '400', '401', '403', '404', '409', '410', '412', '413', '428', '503']
  },
  'share:revisions:read': {
    operationId: 'listShareRevisions', summary: 'List Share revisions',
    description: 'Requires share:read and can_read. Returns revision metadata only.',
    responses: ['200', '400', '401', '403', '404', '503']
  },
  'share:revision:read': {
    operationId: 'getShareRevision', summary: 'Read one Share revision',
    description: 'Requires share:read and can_read. A purged revision returns 410 without payload.',
    responses: ['200', '400', '401', '403', '404', '410', '503']
  },
  'share:restore': {
    operationId: 'restoreShareRevision', summary: 'Conditionally restore a Share revision',
    description: 'Requires share:read and share:update plus can_read and can_update. The body contains only revision; the current content ETag is used for If-Match.',
    responses: ['200', '400', '401', '403', '404', '409', '410', '412', '413', '428', '503']
  },
  'share:unpublish': {
    operationId: 'unpublishShare', summary: 'Unpublish a Share',
    description: 'Requires a managed Key with share:publish and the Share can_publish grant. Requires a concrete strong access-state If-Match, Idempotency-Key and an empty JSON object body. Does not change content, password or expiry.',
    responses: ['200', '400', '401', '403', '404', '409', '410', '412', '413', '428', '503']
  },
  'share:republish': {
    operationId: 'republishShare', summary: 'Republish a Share',
    description: 'Requires a managed Key with share:publish and the Share can_publish grant. Requires a concrete strong access-state If-Match, Idempotency-Key and an empty JSON object body. Does not remove protection or extend expiry.',
    responses: ['200', '400', '401', '403', '404', '409', '410', '412', '413', '428', '503']
  },
  'identity:read': {
    operationId: 'getApiIdentity', summary: 'Read API credential identity',
    description: 'Returns the current API credential identity and scopes without its secret, hash or resource grants.',
    responses: ['200', '401', '503']
  },
  'capabilities:read': {
    operationId: 'getApiCapabilities', summary: 'Read implemented API capabilities',
    description: 'Returns the live capability definitions, content types, Markdown Presets, parser limits and implemented scopes for this instance.',
    responses: ['200', '401', '503']
  }
});

const JSON_CONTENT = { 'application/json': { schema: { type: 'object' } } };

function pathForOpenApi(path) {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
}

function parameter(name, description, schema = { type: 'string' }, required = true, inType = 'header') {
  return { name, in: inType, required, description, schema };
}

function operationFor(capability) {
  const details = DETAILS[capability.id];
  if (!details) throw new Error(`OpenAPI metadata missing for capability ${capability.id}`);
  const op = {
    operationId: details.operationId,
    summary: details.summary,
    description: details.description,
    security: [{ ApiKeyAuth: [] }],
    'x-quickshare-capability': capability,
    parameters: []
  };

  if (capability.path.includes(':id')) {
    op.parameters.push(parameter('id', 'Share ID.', { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, true, 'path'));
  }
  if (capability.path.includes(':revision')) {
    op.parameters.push(parameter('revision', 'Positive decimal content revision; use a string above JavaScript safe integer range.', { type: 'string', pattern: '^[1-9][0-9]*$' }, true, 'path'));
  }
  if (capability.path.includes(':requestId')) {
    op.parameters.push(parameter('requestId', 'Credential-namespace operation identifier.', { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }, true, 'path'));
  }
  if (capability.id === 'share:list' || capability.id === 'share:revisions:read') {
    op.parameters.push(parameter('limit', 'Page size; default 20, maximum 100.', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, false, 'query'));
    op.parameters.push(parameter('cursor', 'Opaque stable keyset cursor.', { type: 'string' }, false, 'query'));
  }
  if (capability.id === 'share:content:read') {
    op.parameters.push(parameter('If-None-Match', 'Optional cache validator; responses remain private/no-store.', { type: 'string' }, false));
  }
  if (['share:content:update', 'share:restore'].includes(capability.id)) {
    op.parameters.push(parameter('If-Match', 'One concrete strong content ETag from the corresponding content representation.', { type: 'string', pattern: '^"content:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*"$' }));
    op.parameters.push(parameter('Idempotency-Key', 'Request identity, 16–128 ASCII letters, digits, hyphens or underscores.', { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }));
  }
  if (['share:unpublish', 'share:republish'].includes(capability.id)) {
    op.parameters.push(parameter('If-Match', 'One concrete strong state ETag from GET /api/v1/shares/{id}/state; content ETags, wildcard, weak tags and tag lists are rejected.', { type: 'string', pattern: '^"access:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*"$' }));
    op.parameters.push(parameter('Idempotency-Key', 'Request identity; retries must reuse the original value and input.', { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }));
  }

  if (capability.id === 'share:create') {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object', required: ['htmlContent'], additionalProperties: false,
        properties: {
          htmlContent: { type: 'string', minLength: 1 },
          codeType: { type: 'string', enum: ['html', 'markdown', 'svg', 'mermaid'] },
          title: { type: 'string' }, description: { type: 'string' },
          isProtected: { type: 'boolean' }, password: { type: 'string' },
          expiresAt: { oneOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }] },
          markdownTheme: { type: 'string' }
        }
      } } }
    };
  } else if (capability.id === 'share:content:update') {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object', required: ['htmlContent', 'title', 'description', 'markdownTheme'], additionalProperties: false,
        properties: {
          htmlContent: { type: 'string', minLength: 1 }, title: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] }, markdownTheme: { type: ['string', 'null'] },
          codeType: { type: 'string', enum: ['html', 'markdown', 'svg', 'mermaid'], description: 'Optional; must equal the Share’s immutable type.' }
        }
      } } }
    };
  } else if (capability.id === 'share:restore') {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object', required: ['revision'], additionalProperties: false,
        properties: { revision: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }] } }
      } } }
    };
  } else if (['share:unpublish', 'share:republish'].includes(capability.id)) {
    op.requestBody = {
      required: true,
      description: 'Empty object only. The deployment parser limit is reported by GET /api/v1/capabilities.',
      content: { 'application/json': { schema: { type: 'object', maxProperties: 0, additionalProperties: false } } }
    };
  }

  op.responses = Object.fromEntries(details.responses.map(status => {
    let schema = { type: 'object' };
    if (status === '200' && capability.id === 'share:create:status') schema = { $ref: '#/components/schemas/OperationStatusResponse' };
    if (status === '200' && capability.id === 'share:state:read') schema = { $ref: '#/components/schemas/ShareState' };
    if (status === '200' && ['share:unpublish', 'share:republish'].includes(capability.id)) schema = { $ref: '#/components/schemas/PublishStateResult' };
    if (status === '200' && capability.id === 'identity:read') schema = { $ref: '#/components/schemas/Identity' };
    if (status === '200' && capability.id === 'capabilities:read') schema = { $ref: '#/components/schemas/Capabilities' };
    return [status, {
      description: responseDescriptions(status),
      ...(status === '304' ? {} : { content: { 'application/json': { schema: status === '200' || status === '201'
        ? schema
        : status === '503' && ['share:list', 'share:content:read', 'share:state:read'].includes(capability.id)
          ? { $ref: '#/components/schemas/ReadUnavailable' }
          : { $ref: '#/components/schemas/Error' } } } })
    }];
  }));
  return op;
}

function responseDescriptions(status) {
  return ({
    '200': 'Success.', '201': 'Created.', '304': 'Not modified.', '400': 'Invalid request.',
    '401': 'Missing, invalid or revoked API Key.', '403': 'Required scope is not enabled for this credential.',
    '404': 'Resource is missing or the matching resource grant is absent.', '409': 'Idempotency key conflicts with another request.',
    '410': 'Requested result or revision is unavailable.', '412': 'The strong If-Match validator is stale.',
    '413': 'Request body exceeds the configured parser limit.', '428': 'A required If-Match or Idempotency-Key is missing.',
    '503': 'The service or storage is temporarily unavailable.'
  })[status] || 'Response.';
}

function buildApiOpenApi(capabilities) {
  const paths = {};
  for (const capability of capabilities.operations) {
    const path = pathForOpenApi(capability.path);
    paths[path] ||= {};
    paths[path][capability.method.toLowerCase()] = operationFor(capability);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'QuickShare Share API (implemented subset)',
      version: capabilities.protocolVersion,
      description: 'This document covers the public /api/v1 Share API operations currently exposed by this repository. It is not a complete schema for every QuickShare route; dashboard, legacy /api/pages, public view, private client-maintenance actions and Key/history purge are intentionally excluded.'
    },
    paths,
    components: {
      securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Managed or legacy API Key. Legacy Keys are create-only.' } },
      schemas: {
        Identity: {
          type: 'object', required: ['success', 'origin', 'credentialKind', 'scopes'],
          properties: {
            success: { const: true }, origin: { type: 'string', format: 'uri' },
            credentialKind: { type: 'string', enum: ['legacy', 'managed'] },
            id: { type: 'string' }, name: { type: 'string' },
            credentialVersion: { type: 'string', pattern: '^[1-9][0-9]*$' },
            scopes: { type: 'array', items: { type: 'string', enum: capabilities.scopes.implemented } }
          }
        },
        Capabilities: {
          type: 'object', required: ['success', 'protocolVersion', 'contentTypes', 'markdownThemePresets', 'limits', 'operations', 'scopes', 'idempotency'],
          properties: {
            success: { const: true }, protocolVersion: { const: capabilities.protocolVersion },
            contentTypes: { type: 'array', items: { type: 'string', enum: capabilities.contentTypes } },
            markdownThemePresets: { type: 'array', items: { type: 'string', enum: capabilities.markdownThemePresets } },
            limits: { $ref: '#/components/schemas/Limits' },
            operations: { type: 'array', items: { type: 'object', required: ['id', 'method', 'path'], properties: { id: { type: 'string' }, method: { type: 'string' }, path: { type: 'string' } } } },
            scopes: { type: 'object' }, idempotency: { type: 'object' }
          }
        },
        ShareState: {
          type: 'object', required: ['success', 'id', 'published', 'isProtected', 'expiresAt', 'accessRevision'],
          allOf: [{ required: ['url'] }],
          additionalProperties: false,
          properties: {
            success: { const: true }, id: { type: 'string' }, published: { type: 'boolean' },
            isProtected: { type: 'boolean' }, expiresAt: { type: ['integer', 'null'] },
            accessRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
            url: { type: 'string', format: 'uri', description: 'Current canonical public URL generated by the server; not a persisted creation-time URL.' }
          }
        },
        PublishStateResult: {
          oneOf: [
            {
              type: 'object', required: ['success', 'action', 'requestId', 'changed', 'id', 'published', 'isProtected', 'expiresAt', 'accessRevision', 'url'],
              properties: {
                success: { const: true }, action: { type: 'string', enum: ['unpublish', 'republish'] },
                requestId: { type: 'string' }, changed: { type: 'boolean' }, id: { type: 'string' },
                published: { type: 'boolean' }, isProtected: { type: 'boolean' }, expiresAt: { type: ['integer', 'null'] },
                accessRevision: { type: 'string', pattern: '^[1-9][0-9]*$' }, replayed: { type: 'boolean' },
                url: { type: 'string', format: 'uri', description: 'Current canonical public URL generated by the server; not a persisted creation-time URL.' }
              }
            },
            {
              type: 'object', required: ['success', 'action', 'requestId', 'changed', 'replayed', 'stateChangedSinceCommit'],
              allOf: [{ required: ['url'] }],
              properties: {
                success: { const: true }, action: { type: 'string', enum: ['unpublish', 'republish'] },
                requestId: { type: 'string' }, changed: { type: 'boolean' }, replayed: { const: true },
                stateChangedSinceCommit: { const: true },
                url: { type: 'string', format: 'uri', description: 'Current canonical public URL; historical access-state fields are omitted because state changed since commit.' }
              }, additionalProperties: false
            }
          ]
        },
        OperationStatusResponse: {
          type: 'object', required: ['success', 'requestId', 'operations'], additionalProperties: false,
          properties: {
            success: { const: true }, requestId: { type: 'string' },
            operations: { type: 'array', items: { $ref: '#/components/schemas/OperationStatus' } }
          }
        },
        OperationStatus: {
          type: 'object', required: ['namespaceKind', 'action', 'status', 'shareId', 'revision', 'createdAt'],
          allOf: [{
            if: { required: ['action'], properties: { action: { enum: ['unpublish', 'republish'] } } },
            then: { required: ['url'] },
            else: { not: { required: ['url'] } }
          }],
          additionalProperties: false,
          properties: {
            namespaceKind: { type: 'string', enum: ['managed-key', 'legacy-key', 'publish-session', 'dashboard-session', 'unknown'] },
            action: { type: 'string' }, status: { type: 'string', enum: ['succeeded', 'result-unavailable'] },
            shareId: { type: ['string', 'null'] }, revision: { type: ['string', 'null'] },
            accessRevision: { type: ['string', 'null'] }, createdAt: { type: 'integer' },
            stateChangedSinceCommit: { const: true },
            url: { type: 'string', format: 'uri', description: 'Current canonical public URL, included only for an authorized publish operation while its Share and result are available; never the persisted creation-time URL.' }
          }
        },
        Error: {
          type: 'object', required: ['success', 'code', 'retryable', 'error'],
          properties: {
            success: { const: false }, code: { type: 'string' }, requestId: { type: ['string', 'null'] },
            retryable: { type: 'boolean' }, error: { type: 'string' }
          }
        },
        ReadUnavailable: {
          type: 'object', required: ['success', 'code', 'requestId', 'retryable', 'error'],
          additionalProperties: false,
          properties: {
            success: { const: false }, code: { const: 'API_READ_UNAVAILABLE' }, requestId: { type: 'null' },
            retryable: { const: true }, error: { type: 'string' }
          }
        },
        Limits: { type: 'object', required: ['shareRequestBodyBytes', 'smallRequestBodyBytes', 'rawContentBytes'], properties: {
          shareRequestBodyBytes: { type: 'integer', minimum: 1, description: 'Configured decoded JSON request-body limit; query GET /api/v1/capabilities for this instance.' },
          smallRequestBodyBytes: { type: 'integer', minimum: 1, description: 'Configured decoded small JSON request-body limit; query GET /api/v1/capabilities for this instance.' },
          rawContentBytes: { type: 'null', description: 'No independent raw content byte allowance.' }
        } }
      }
    },
    'x-quickshare-capabilities': {
      protocolVersion: capabilities.protocolVersion,
      contentTypes: capabilities.contentTypes,
      markdownThemePresets: capabilities.markdownThemePresets,
      scopes: capabilities.scopes,
      idempotency: capabilities.idempotency
    }
  };
}

function serializeOpenApiAsYaml(document) {
  // JSON is a strict YAML 1.2 subset. This preserves one deterministic,
  // dependency-free serialization that can be parsed by OpenAPI YAML tools.
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (require.main === module) {
  const config = require('../config');
  const { apiCapabilities } = require('./apiCapabilities');
  process.stdout.write(serializeOpenApiAsYaml(buildApiOpenApi(apiCapabilities(config))));
}

module.exports = { buildApiOpenApi, serializeOpenApiAsYaml, pathForOpenApi };
