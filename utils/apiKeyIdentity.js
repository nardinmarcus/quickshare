// Scope vocabulary (parent #24 §6, implemented by #36). Only `share:create`
// and `share:read` exist in this milestone; `share:update` and
// `share:publish` are reserved names so later tickets never re-key the
// column. A scope alone never authorizes anything: per-Share grants and,
// for writes, the publishing locks decide the rest.
const KNOWN_SCOPES = Object.freeze(['share:create', 'share:read', 'share:update', 'share:publish']);
const CREATE_ONLY_SCOPES = Object.freeze(['share:create']);
const READ_SCOPE = 'share:read';

function invalidApiKey() {
  return Object.assign(new Error('Invalid API key'), { code: 'INVALID_API_KEY', status: 401 });
}

/**
 * Scopes of a managed key row. Rows predating migration 010 (or any adapter
 * path that leaves scopes unset) stay conservative: create-only, the exact
// pre-#36 behavior. Unknown or empty values never widen access.
 */
function managedScopes(record) {
  const raw = Array.isArray(record?.scopes) ? record.scopes.filter(scope => KNOWN_SCOPES.includes(scope)) : null;
  const scopes = raw && raw.length > 0 ? raw : [...CREATE_ONLY_SCOPES];
  return Object.freeze(scopes);
}

function managedIdentity(record) {
  if (!record || !/^[1-9][0-9]*$/.test(record.credential_version)) throw invalidApiKey();
  return Object.freeze({
    credentialKind: 'managed',
    id: record.id,
    name: record.name,
    credentialVersion: record.credential_version,
    scopes: managedScopes(record)
  });
}

module.exports = { invalidApiKey, managedIdentity, managedScopes, KNOWN_SCOPES, CREATE_ONLY_SCOPES, READ_SCOPE };
