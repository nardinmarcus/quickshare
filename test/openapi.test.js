const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { apiCapabilities } = require('../utils/apiCapabilities');
const { buildApiOpenApi } = require('../utils/apiOpenApi');

const openApiPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
const openApiText = fs.readFileSync(openApiPath, 'utf8');
const document = JSON.parse(openApiText); // deterministic JSON is valid YAML 1.2
const expected = buildApiOpenApi(apiCapabilities(config));

test('checked-in OpenAPI YAML is generated from the live capability definitions', () => {
  assert.deepEqual(document, expected);
  assert.equal(document.openapi, '3.1.0');
  assert.match(document.info.title, /implemented subset/);
  assert.match(document.info.description, /not a complete schema/);
  assert.deepEqual(document.components.securitySchemes.ApiKeyAuth, {
    type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Managed or legacy API Key. Legacy Keys are create-only.'
  });
});

test('publish-only state alternative and conditional endpoints are represented exactly', () => {
  const state = document.paths['/api/v1/shares/{id}/state'].get;
  assert.deepEqual(state['x-quickshare-capability'].anyOf, [
    { scope: 'share:read', grant: 'can_read' },
    { scope: 'share:publish', grant: 'can_publish' }
  ]);
  const stateSchemaRef = state.responses['200'].content['application/json'].schema.$ref;
  const stateSchema = document.components.schemas[stateSchemaRef.split('/').at(-1)];
  assert.deepEqual(stateSchema.required, ['success', 'id', 'published', 'isProtected', 'expiresAt', 'accessRevision']);
  assert.equal(stateSchema.additionalProperties, false);

  for (const action of ['unpublish', 'republish']) {
    const operation = document.paths[`/api/v1/shares/{id}/${action}`].post;
    assert.equal(operation['x-quickshare-capability'].scope, 'share:publish');
    assert.equal(operation['x-quickshare-capability'].grant, 'can_publish');
    assert.equal(operation.parameters.find(parameter => parameter.name === 'If-Match').schema.pattern,
      '^"access:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*"$');
    assert.equal(operation.parameters.find(parameter => parameter.name === 'Idempotency-Key').required, true);
    assert.equal(operation.requestBody.content['application/json'].schema.maxProperties, 0);
    assert.ok(operation.responses['410'], 'result-unavailable replay is described');
  }

  const staleReplay = document.components.schemas.PublishStateResult.oneOf.find(schema => schema.properties?.stateChangedSinceCommit);
  assert.ok(staleReplay);
  assert.deepEqual(staleReplay.required, ['success', 'action', 'requestId', 'changed', 'replayed', 'stateChangedSinceCommit']);
  assert.equal(staleReplay.additionalProperties, false, 'stale replay shape cannot leak the historical state or ETag identity');
});

test('operation-status schema conditionally requires URL only for publish actions', () => {
  const statusOperation = document.paths['/api/v1/operations/{requestId}'].get;
  const responseSchema = statusOperation.responses['200'].content['application/json'].schema;
  assert.equal(responseSchema.$ref, '#/components/schemas/OperationStatusResponse');
  const itemSchema = document.components.schemas.OperationStatusResponse.properties.operations.items;
  assert.equal(itemSchema.$ref, '#/components/schemas/OperationStatus');

  const operationStatus = document.components.schemas.OperationStatus;
  assert.equal(operationStatus.properties.url.format, 'uri');
  const publishOnlyUrl = operationStatus.allOf.find(condition => condition.if);
  assert.ok(publishOnlyUrl, 'the JSON Schema has an explicit action-dependent condition');
  assert.deepEqual(publishOnlyUrl.if.properties.action.enum, ['unpublish', 'republish']);
  assert.deepEqual(publishOnlyUrl.then.required, ['url'], 'successful publish operation statuses require the current URL');
  assert.deepEqual(publishOnlyUrl.else.not.required, ['url'], 'content/restore and other actions do not expose this publication URL');
});

test('list, content and state reads document their runtime retryable storage-error contract', () => {
  const unavailable = document.components.schemas.ReadUnavailable;
  assert.ok(unavailable, 'read-storage failures have a dedicated response schema');
  assert.deepEqual(unavailable.required, ['success', 'code', 'requestId', 'retryable', 'error']);
  assert.equal(unavailable.additionalProperties, false);
  assert.deepEqual(unavailable.properties.success, { const: false });
  assert.deepEqual(unavailable.properties.code, { const: 'API_READ_UNAVAILABLE' });
  assert.deepEqual(unavailable.properties.requestId, { type: 'null' });
  assert.deepEqual(unavailable.properties.retryable, { const: true });

  for (const path of [
    '/api/v1/shares',
    '/api/v1/shares/{id}/content',
    '/api/v1/shares/{id}/state'
  ]) {
    const response = document.paths[path].get.responses['503'];
    assert.ok(response, `${path} documents temporary storage failure`);
    assert.deepEqual(response.content['application/json'].schema, { $ref: '#/components/schemas/ReadUnavailable' });
  }
});

test('bounded document does not invent dashboard, legacy, public-view or private maintenance endpoints', () => {
  assert.equal(document.paths['/admin/apis'], undefined);
  assert.equal(document.paths['/api/pages/create'], undefined);
  assert.equal(document.paths['/view/{id}'], undefined);
  assert.equal(document.paths['/api/v1/shares/{id}/purge'], undefined);
  assert.equal(document.paths['/api/v1/keys/{id}/revisions'], undefined);
  assert.ok(Object.keys(document.paths).every(route => route.startsWith('/api/v1/')));
});
