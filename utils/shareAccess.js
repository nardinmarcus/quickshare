// Access revision helpers for Share access credentials (ticket T01, issue #25).
//
// Every Share carries a monotonically increasing `access_revision`. It starts
// at 1 and is advanced atomically whenever the access policy changes (password
// set/change/cancel, expiry change, or an explicit admin revocation). Signed
// access cookies bind the Share ID together with the revision that was current
// when the password was verified, so advancing the revision immediately
// revokes every previously issued cookie.
//
// Revisions are decimal strings in JSON and cookie payloads so they never
// lose precision as they grow (the database column is BIGINT).

const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

function toAccessRevisionString(value) {
  if (value === undefined || value === null || value === '') {
    return '1';
  }

  if (typeof value === 'bigint') {
    return value > 0n ? value.toString() : '1';
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '1';
  }

  if (typeof value === 'string' && DECIMAL_INTEGER_PATTERN.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed > 0n ? parsed.toString() : '1';
  }

  return '1';
}

function nextAccessRevision(value) {
  return (BigInt(toAccessRevisionString(value)) + 1n).toString();
}

// Parses a client-submitted expectedAccessRevision precondition.
// Returns { provided: false } when the field is absent, { provided: true,
// valid: false } when it is present but not a decimal string/number, and
// { provided: true, valid: true, value } with the canonical decimal string
// otherwise. Callers must not substitute the latest revision when the field
// is missing; that is what the 428 response is for.
function parseExpectedAccessRevision(value) {
  if (value === undefined || value === null) {
    return { provided: false, valid: false, value: null };
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return { provided: true, valid: true, value: String(value) };
  }

  if (typeof value === 'string' && DECIMAL_INTEGER_PATTERN.test(value)) {
    const parsed = BigInt(value);
    if (parsed > 0n) {
      return { provided: true, valid: true, value: parsed.toString() };
    }
  }

  return { provided: true, valid: false, value: null };
}

function accessRevisionMatches(actual, expected) {
  return toAccessRevisionString(actual) === toAccessRevisionString(expected);
}

// The strong ETag of a Share's access-state representation (parent spec
// #24 §4): "access:<Share ID>:<Access Revision>". It is a DIFFERENT tag
// family from the content ETag ("content:<id>:<revision>") — the two
// are never interchangeable, and a state response carries only the
// fields this tag covers (published / isProtected / expiresAt /
// accessRevision), never title, description or body.
function formatAccessEtag(shareId, accessRevision) {
  return `"access:${shareId}:${toAccessRevisionString(accessRevision)}"`;
}

const ACCESS_ETAG_PATTERN = /^"access:([^"]+):(0|[1-9][0-9]*)"$/;

// Strictly parse an If-Match header value as an access-state
// precondition for one Share (T15, issue #39; parent spec #24 §4/§7).
// The publish-state writes compare the STATE representation, so this
// is the access-family counterpart of parseContentIfMatch — and the
// two families are never interchangeable: a content tag presented here
// is invalid, exactly like a wildcard, a list, a weak tag, a bare
// token, a tag for another Share or a malformed revision. Returns one
// of:
//   { status: 'missing' }                        — header absent/blank (428)
//   { status: 'invalid' }                        — present but not one
//     concrete strong double-quoted access tag for this Share (412)
//   { status: 'ok', revision }                   — the parsed access
//     revision; the caller compares it against the current access
//     revision (a mismatch is the stale case, also 412).
function parseAccessIfMatch(headerValue, shareId) {
  if (headerValue === undefined || headerValue === null
    || (typeof headerValue === 'string' && headerValue.trim() === '')) {
    return { status: 'missing', revision: null };
  }

  if (typeof headerValue !== 'string') {
    return { status: 'invalid', revision: null };
  }

  const match = ACCESS_ETAG_PATTERN.exec(headerValue);

  if (!match || match[1] !== shareId) {
    return { status: 'invalid', revision: null };
  }

  const revision = BigInt(match[2]);

  if (revision <= 0n) {
    return { status: 'invalid', revision: null };
  }

  return { status: 'ok', revision: revision.toString() };
}

module.exports = {
  accessRevisionMatches,
  formatAccessEtag,
  nextAccessRevision,
  parseAccessIfMatch,
  parseExpectedAccessRevision,
  toAccessRevisionString
};
