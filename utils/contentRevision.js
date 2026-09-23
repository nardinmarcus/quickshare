// Content revisions travel as canonical decimal strings, including above 2^53.
const MAX_CONTENT_REVISION = 9223372036854775807n;

const crypto = require('node:crypto');

/**
 * Deterministic SHA-256 over the fixed content-snapshot payload (parent #24 §3
 * snapshot hash). Identical payloads MUST produce identical digests in both
 * repository adapters: canonical JSON with fixed key order and undefined
 * normalized to null. Original characters (including CRLF) enter the hash.
 */
function contentSnapshotHash(snapshot) {
  const canonical = JSON.stringify({
    htmlContent: snapshot.htmlContent === undefined ? null : snapshot.htmlContent,
    codeType: snapshot.codeType === undefined ? null : snapshot.codeType,
    title: snapshot.title === undefined ? null : snapshot.title,
    description: snapshot.description === undefined ? null : snapshot.description,
    markdownTheme: snapshot.markdownTheme === undefined ? null : snapshot.markdownTheme
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function isContentRevision(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_CONTENT_REVISION;
}

function contentError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = status === 428
    ? 'CONTENT_PRECONDITION_REQUIRED'
    : status === 412 ? 'CONTENT_REVISION_CONFLICT' : 'INVALID_CONTENT_REVISION';
  return error;
}

function contentEtag(shareId, revision) {
  // Strong HTTP entity-tag: always the quoted form.
  return `"content:${shareId}:${revision}"`;
}

/**
 * Access-state entity-tag (#24 §4, served by GET /api/v1/shares/:id/state):
 * a strong tag from the SAME quoted convention as contentEtag, covering
 * published/isProtected/expiresAt/accessRevision and nothing else.
 */
function accessEtag(shareId, accessRevision) {
  return `"access:${shareId}:${accessRevision}"`;
}

/**
 * If-None-Match evaluation for the read-only resource GETs (#36). RFC 9110
 * §13.1.2: GET/HEAD If-None-Match uses WEAK comparison — an opaque tag
 * matches when its value equals the current tag's value, regardless of the
 * weakness indicator, and a comma-separated list matches when ANY member
 * does; `*` always matches. The tags this service GENERATES stay strong
 * (the #36 guarantee); only the request-side comparison is weak. The write
 * path (If-Match via parseContentEtag) keeps strict STRONG comparison.
 */
function ifNoneMatchMatches(rawHeader, etag) {
  if (typeof rawHeader !== 'string') return false;
  const value = rawHeader.trim();
  if (value === '') return false;
  if (value === '*') return true;
  const weakValue = opaqueTagValue(etag);
  if (weakValue === null) return false;
  return value.split(',')
    .map(tag => opaqueTagValue(tag.trim()))
    .some(tagValue => tagValue !== null && tagValue === weakValue);
}

/**
 * Extracts the opaque value between the final pair of double quotes,
 * ignoring an optional leading weakness indicator. Returns null for
 * malformed tags (unquoted, unclosed, empty) so they never match.
 */
function opaqueTagValue(tag) {
  if (typeof tag !== 'string' || tag.length < 2) return null;
  const withoutWeakness = /^[Ww]\//.test(tag) ? tag.slice(2) : tag;
  if (!withoutWeakness.startsWith('"') || !withoutWeakness.endsWith('"') || withoutWeakness.length < 2) {
    return null;
  }
  return withoutWeakness.slice(1, -1);
}

/**
 * Parses the dashboard content If-Match value. HTTP strong comparison only:
 * exactly one double-quoted strong tag of the "content:<Share ID>:<Revision>"
 * family. Missing values are a 428; weak tags, wildcards, tag lists, bare
 * tokens, single-quoted aliases and foreign families are a 400.
 */
function parseContentEtag(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw contentError(428, '请刷新 Share 后重新保存内容；未保存的输入已保留。');
  }
  const value = String(raw).trim();
  if (/^[Ww]\//.test(value)) {
    throw contentError(400, 'If-Match must be a strong content tag, not a weak validator');
  }
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    // Bare tokens, single-quoted aliases, "*" and garbage are all invalid
    // preconditions: the content protocol has no unquoted legacy form.
    throw contentError(400, 'If-Match must be one double-quoted content tag');
  }
  const inner = value.slice(1, -1);
  if (inner.includes('"') || inner.includes(',')) {
    throw contentError(400, 'If-Match must contain exactly one content tag');
  }
  const parts = inner.split(':');
  if (parts.length !== 3 || parts[0] !== 'content' || !parts[1] || !isContentRevision(parts[2])) {
    throw contentError(400, 'If-Match must be a "content:<Share ID>:<Revision>" tag');
  }
  return { shareId: parts[1], revision: parts[2] };
}

/**
 * Validates the parsed tag against the Share being edited. A concrete tag for
 * another Share is an invalid precondition (wrong family), not a conflict.
 */
function requireContentBaselineFor(shareId, raw) {
  const baseline = parseContentEtag(raw);
  if (baseline.shareId !== shareId) {
    throw contentError(400, 'If-Match must reference the edited Share');
  }
  return baseline;
}

function assertContentRevision(expected, current) {
  if (expected === undefined || expected === null) {
    throw contentError(428, '请刷新 Share 后重新保存内容；未保存的输入已保留。');
  }
  if (!isContentRevision(expected)) {
    throw contentError(400, 'content revision must be a positive decimal string');
  }
  if (expected !== String(current)) {
    throw contentError(412, 'Share 内容已在此页面之外被修改，请查看差异后处理；未保存的输入已保留。');
  }
}

module.exports = {
  MAX_CONTENT_REVISION,
  contentSnapshotHash,
  isContentRevision,
  contentError,
  contentEtag,
  accessEtag,
  ifNoneMatchMatches,
  parseContentEtag,
  requireContentBaselineFor,
  assertContentRevision
};
