'use strict';

// Content Revision helpers for Share content versioning (ticket T06,
// issue #30; parent spec #24 §3/§4).
//
// Every Share carries a monotonically increasing `current_revision`. It
// starts at 1 (the baseline snapshot written at creation, or backfilled
// for pre-existing Shares inside a write-maintenance window) and advances
// only when the content snapshot — body, fixed codeType, title,
// description, Markdown Theme Preset — actually changes. Access policy
// (password, expiry, published state), favorites and view counts are NOT
// content and never advance this revision; they live under the separate
// access_revision protocol (T01, utils/shareAccess.js).
//
// Revisions are decimal strings in JSON so they never lose precision as
// they grow (the database columns are BIGINT). Content writes are guarded
// by a strong HTTP entity-tag precondition: the content GET returns
// ETag: "content:<Share ID>:<Revision>" and a save must present exactly
// that tag in If-Match. Wildcards, lists, weak tags, bare or single-quoted
// tokens, tags from the access family and tags for another Share never
// satisfy the precondition. A missing precondition is 428; any other
// failure to match the current tag is 412.

const crypto = require('crypto');

const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const CONTENT_ETAG_PATTERN = /^"content:([^":]+):(0|[1-9][0-9]*)"$/;

// Canonical decimal-string form of a stored content revision. Returns
// null when the Share has no baseline yet (current_revision IS NULL in
// the window between the expansion migration and the baseline backfill);
// callers must not silently substitute a revision in that state.
function toContentRevisionString(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'bigint') {
    return value > 0n ? value.toString() : null;
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }

  if (typeof value === 'string' && DECIMAL_INTEGER_PATTERN.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed > 0n ? parsed.toString() : null;
  }

  return null;
}

function nextContentRevision(value) {
  const current = toContentRevisionString(value);
  return current === null ? '1' : (BigInt(current) + 1n).toString();
}

function contentRevisionMatches(actual, expected) {
  const left = toContentRevisionString(actual);
  const right = toContentRevisionString(expected);
  return left !== null && right !== null && left === right;
}

// The strong content entity-tag for one Share revision, in the exact wire
// format the parent spec fixes: "content:<Share ID>:<Revision>", double
// quotes included. Returns null when there is no baseline revision.
function formatContentEtag(shareId, revision) {
  const revisionString = toContentRevisionString(revision);

  if (typeof shareId !== 'string' || shareId.length === 0 || revisionString === null) {
    return null;
  }

  return `"content:${shareId}:${revisionString}"`;
}

// Strictly parse an If-Match header value as a content precondition for
// one Share. Returns one of:
//   { status: 'missing' }                        — header absent/blank (428)
//   { status: 'invalid' }                        — present but not one
//     concrete strong double-quoted content tag for this Share (412):
//     wildcards, lists, weak tags, bare tokens, single-quoted tokens,
//     access-family tags, tags for another Share, malformed revisions.
//   { status: 'ok', revision }                   — the parsed revision;
//     the caller compares it against the current revision (a mismatch is
//     the stale case, also 412, but distinguishable for diagnostics).
function parseContentIfMatch(headerValue, shareId) {
  if (headerValue === undefined || headerValue === null
    || (typeof headerValue === 'string' && headerValue.trim() === '')) {
    return { status: 'missing', revision: null };
  }

  if (typeof headerValue !== 'string') {
    return { status: 'invalid', revision: null };
  }

  const match = CONTENT_ETAG_PATTERN.exec(headerValue);

  if (!match || match[1] !== shareId) {
    return { status: 'invalid', revision: null };
  }

  const revision = BigInt(match[2]);

  if (revision <= 0n) {
    return { status: 'invalid', revision: null };
  }

  return { status: 'ok', revision: revision.toString() };
}

// The content snapshot fields, in canonical order. Protection, expiry,
// published state, favorites and view counts are deliberately excluded:
// they are not content history (parent spec §3/§4).
function snapshotPayloadOf(fields) {
  return {
    htmlContent: fields.htmlContent ?? fields.html_content ?? null,
    codeType: fields.codeType ?? fields.code_type ?? 'html',
    title: fields.title ?? null,
    description: fields.description ?? null,
    markdownTheme: fields.markdownTheme ?? fields.markdown_theme ?? null
  };
}

// A snapshot whose payload the owner permanently purged (T10, issue
// #34) is a tombstone: the row keeps its metadata (Share, revision,
// capture time, provenance, purge time) but its payload fields — body,
// title, description, theme and the payload-derived snapshot hash —
// are NULL. purged_at is the authoritative marker; a NULL body on its
// own is treated the same way, because an intact snapshot always
// carries its exact bytes.
function isSnapshotPurged(snapshot) {
  return Boolean(snapshot)
    && (snapshot.purged_at !== null && snapshot.purged_at !== undefined
      || snapshot.html_content === null || snapshot.html_content === undefined);
}

// Byte-exact snapshot comparison. No newline or whitespace normalization
// is ever applied: a body stored with CRLF endings differs from the same
// text with LF endings, and an unchanged candidate compares equal only
// when its bytes are the stored bytes.
function contentSnapshotsEqual(left, right) {
  const a = snapshotPayloadOf(left);
  const b = snapshotPayloadOf(right);
  return a.htmlContent === b.htmlContent
    && a.codeType === b.codeType
    && a.title === b.title
    && a.description === b.description
    && a.markdownTheme === b.markdownTheme;
}

// Integrity hash of one snapshot, binding the Share, the revision number
// and the exact payload. Backup verification recomputes this value from
// the restored rows and compares it against the stored hash, so a restore
// that corrupts either the payload or the hash is detected.
function computeSnapshotHash(shareId, revision, fields) {
  const payload = snapshotPayloadOf(fields);
  const canonical = JSON.stringify([
    String(shareId),
    toContentRevisionString(revision),
    payload.codeType,
    payload.htmlContent,
    payload.title,
    payload.description,
    payload.markdownTheme
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  computeSnapshotHash,
  contentRevisionMatches,
  contentSnapshotsEqual,
  formatContentEtag,
  isSnapshotPurged,
  nextContentRevision,
  parseContentIfMatch,
  snapshotPayloadOf,
  toContentRevisionString
};
