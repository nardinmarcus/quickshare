'use strict';

// Per-Share resource grants for managed API Keys (T12, issue #36;
// parent spec #24 §3/§6). A grant is the whole relationship between a
// Key and a Share: the Share never "belongs" to the Key, and a global
// scope alone never authorizes a specific Share — management access is
// the conjunction of the Key's current scope and the matching grant.
//
// One grant row per (Key, Share) carries three independent resource
// permissions with one invariant: update implies read (an editor must
// be able to read back what it edits), while publish does NOT imply
// read — a publish-only grant exposes only the restricted state fields
// (ID, published, isProtected, expiresAt, accessRevision), never the
// title, description or body.

const GRANT_PERMISSION_NAMES = Object.freeze(['read', 'update', 'publish']);

// Normalizes a caller-supplied permission set into the stored shape,
// applying the update-implies-read invariant. Returns null when the
// input is not an object or names an unknown permission, so write
// paths refuse it instead of silently dropping a permission the owner
// asked for. A set with every permission false is representable here;
// callers that require at least one permission check that themselves.
function normalizeGrantPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  for (const key of Object.keys(value)) {
    if (!GRANT_PERMISSION_NAMES.includes(key)) {
      return null;
    }

    if (typeof value[key] !== 'boolean') {
      return null;
    }
  }

  const permissions = {
    read: value.read === true,
    update: value.update === true,
    publish: value.publish === true
  };

  if (permissions.update) {
    permissions.read = true;
  }

  return permissions;
}

function grantPermissionsFromRow(row) {
  if (!row) {
    return { read: false, update: false, publish: false };
  }

  const permissions = {
    read: row.can_read === true,
    update: row.can_update === true,
    publish: row.can_publish === true
  };

  if (permissions.update) {
    permissions.read = true;
  }

  return permissions;
}

function hasAnyGrantPermission(permissions) {
  return Boolean(permissions && (permissions.read || permissions.update || permissions.publish));
}

// --- Granted-Share list cursor -------------------------------------------
//
// The list is ordered by (created_at, id) ascending — creation time,
// then the Share ID as the tiebreak — and the cursor names the last
// row of the previous page in exactly those terms. The cursor is an
// opaque base64url JSON object; it carries no secret and no SQL, and
// anything that does not decode to precisely this shape is refused
// with 400 by the route (parent spec #24 §7).
//
// Both repository adapters must apply ONE comparison consistently to
// sorting and to cursor filtering: compareShareListPosition below is
// that comparison for the memory adapter (code-unit string order, NOT
// localeCompare — the two disagree on mixed-case IDs sharing a
// timestamp, which would silently skip rows between pages), and the
// Postgres adapter expresses the same (created_at, id) tuple order in
// SQL so its ORDER BY and its keyset filter cannot disagree either.

function compareShareListPosition(left, right) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }

  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? -1 : 1;
}

function encodeShareListCursor(position) {
  const payload = JSON.stringify({
    createdAt: position.createdAt,
    id: position.id
  });

  return Buffer.from(payload, 'utf8').toString('base64url');
}

function parseShareListCursor(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const keys = Object.keys(parsed).sort();

  if (keys.length !== 2 || keys[0] !== 'createdAt' || keys[1] !== 'id') {
    return null;
  }

  if (typeof parsed.createdAt !== 'number'
    || !Number.isFinite(parsed.createdAt)
    || parsed.createdAt < 0) {
    return null;
  }

  if (typeof parsed.id !== 'string' || parsed.id.length === 0 || parsed.id.length > 128) {
    return null;
  }

  return { createdAt: parsed.createdAt, id: parsed.id };
}

module.exports = {
  GRANT_PERMISSION_NAMES,
  compareShareListPosition,
  encodeShareListCursor,
  grantPermissionsFromRow,
  hasAnyGrantPermission,
  normalizeGrantPermissions,
  parseShareListCursor
};
