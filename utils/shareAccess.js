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

module.exports = {
  accessRevisionMatches,
  nextAccessRevision,
  parseExpectedAccessRevision,
  toAccessRevisionString
};
