(function attachPublishIntent(global) {
  'use strict';

  // Publish-intent helpers for idempotent homepage creates (T08).
  //
  // The browser keeps at most one pending create intent in localStorage:
  // { requestId, draftKey, sessionTag }. While an intent is pending, a
  // resubmission of the SAME draft under the SAME publish session reuses
  // the requestId, and the server replays the originally committed
  // result instead of minting a second Share. These helpers are pure so
  // the state machine is unit-testable without a DOM.

  // FNV-1a 32-bit over a canonical view of the payload — a cheap
  // client-side fingerprint of "the same draft". It is not a security
  // digest: the server recomputes its own HMAC over the request and
  // answers 409 if a reused identifier ever meets different input. Only
  // the 8-hex-digit fingerprint is stored, never the payload itself.
  function draftKeyFor(payload) {
    const canonical = JSON.stringify([
      payload.htmlContent || '',
      payload.codeType || '',
      payload.title === undefined || payload.title === null ? '' : String(payload.title),
      payload.description === undefined || payload.description === null ? '' : String(payload.description),
      payload.expiresAt === undefined || payload.expiresAt === null ? '' : String(payload.expiresAt),
      payload.isProtected ? '1' : '0',
      payload.password === undefined || payload.password === null ? '' : String(payload.password),
      payload.markdownTheme || ''
    ]);
    let hash = 0x811c9dc5;

    for (let i = 0; i < canonical.length; i += 1) {
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }

    return `draft-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  // UUID v4 request identifiers, as the server contract requires.
  function generateRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);

    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Four-state resolution of a stored pending create against the current
  // draft and publish session:
  //   none   — no pending record; start a fresh intent.
  //   retry  — same draft AND same session tag: resubmit the SAME
  //            requestId; the server replays the committed result (and
  //            the client must not pre-empt it with local validations
  //            that only apply to fresh creates, e.g. expiry futurity).
  //   rotate — same session, changed draft: clicking publish on an edited
  //            draft IS the explicit new-intent signal; abandon the old
  //            pending and mint a fresh requestId.
  //   orphan — different session tag: the pending belongs to another
  //            publish session and must never be claimed from here; the
  //            UI asks for an explicit choice before anything is sent.
  function resolvePublishIntent(pending, draftKey, sessionTag) {
    if (!pending || typeof pending.requestId !== 'string' || !pending.requestId) {
      return { state: 'none' };
    }

    if (pending.sessionTag !== sessionTag) {
      return { state: 'orphan', pending };
    }

    if (pending.draftKey !== draftKey) {
      return { state: 'rotate', pending };
    }

    return { state: 'retry', pending };
  }

  const api = { draftKeyFor, generateRequestId, resolvePublishIntent };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.PublishIntent = api;
})(typeof window !== 'undefined' ? window : globalThis);
