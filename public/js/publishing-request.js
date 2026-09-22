/*
 * Browser publish request identity (#24 §8, #32).
 *
 * One explicit publish intent carries exactly one client-generated UUID v4.
 * The pending pair — request id, a reproducible draft key, a NON-SENSITIVE
 * summary for display, and the publish-session tag it was created under —
 * persists in sessionStorage:
 *
 *   - same session tag + same draft key  → retry: the ORIGINAL id is reused,
 *     across retries AND reloads (the draft key derives from the draft
 *     content, not an in-memory counter);
 *   - same session tag + changed draft key → a new explicit publish intent
 *     rotates the id (surfaced to the caller, never silent);
 *   - DIFFERENT session tag (cookie cleared/expired/rotated anywhere, even
 *     when THIS page load did not mint the session) → the pair is ORPHANED:
 *     it is kept read-only for display, never auto-deleted, never claimed,
 *     and the old id can never be submitted under the new namespace. Only
 *     an explicit user discard (discardPending) starts fresh.
 *
 * Clone dashboard intents persist the same way ({requestId, target}) so a
 * lost clone response has a REAL retry path: an unconfirmed intent keeps its
 * id; the server-issued completion cookie (clone_intent_done) is what marks
 * it completed and lets the next click rotate to a new explicit clone.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'quickshare.publish.requestId';
  var CLONE_STORAGE_KEY = 'quickshare.clone.intent';
  var CLONE_DONE_COOKIE = 'clone_intent_done';

  function randomHex(byteCount) {
    var bytes = new Uint8Array(byteCount);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    var hex = '';
    for (var j = 0; j < bytes.length; j += 1) {
      hex += (bytes[j] + 0x100).toString(16).slice(1);
    }
    return hex;
  }

  // RFC 4122 UUID v4: 8-4-4-4-12 with version nibble 4 and the IEEE-802
  // variant bits (10x). crypto.randomUUID is used where available; the
  // fallback must still be a well-formed v4 (#24 L207).
  function generateRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var hex = randomHex(16);
    return hex.slice(0, 8)
      + '-' + hex.slice(8, 12)
      + '-4' + hex.slice(13, 16)
      + '-' + (('0123456789abcdef'.indexOf(hex[16]) & 0x3) | 0x8).toString(16) + hex.slice(17, 20)
      + '-' + hex.slice(20, 32);
  }

  function readStoredPair() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var pair = JSON.parse(raw);
      if (pair && typeof pair.requestId === 'string' && typeof pair.draftKey === 'string') {
        return pair;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  function storePair(pair) {
    try {
      if (pair === null) {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } else {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pair));
      }
    } catch (error) {
      /* Storage may be unavailable; the id still covers this page view. */
    }
  }

  function currentSessionTag() {
    if (window.document && window.document.documentElement
      && window.document.documentElement.dataset) {
      return window.document.documentElement.dataset.publishSessionTag || null;
    }
    return null;
  }

  window.QuickSharePublishingRequest = {
    _pair: readStoredPair(),
    _pendingReplaced: false,

    /**
     * Claims the request id for the current publish intent.
     * Returns one of:
     *   { mode: 'retry', requestId }  — same session, same draft: the
     *     ORIGINAL id of the unknown request is reused;
     *   { mode: 'new', requestId }    — a new explicit intent (no pending,
     *     changed draft, or after an explicit discard); rotation over an
     *     existing pending is reported via consumePendingReplaced();
     *   { mode: 'blocked' }           — the pending belongs to a DIFFERENT
     *     publish session (orphan): it stays read-only until the user
     *     explicitly discards it; the old id is NEVER claimed here and can
     *     never land in the new namespace.
     * summary is an optional NON-SENSITIVE display digest (title/codeType);
     * credentials and custom passwords never enter the pending record.
     */
    claimRequestDraftId: function (draftKey, summary) {
      var tag = currentSessionTag();
      if (this._pair && this._pair.sessionTag !== tag) {
        return { mode: 'blocked' };
      }
      if (this._pair && this._pair.draftKey === draftKey) {
        return { mode: 'retry', requestId: this._pair.requestId };
      }
      var replaced = this._pair !== null;
      this._pair = {
        requestId: generateRequestId(),
        draftKey: draftKey,
        sessionTag: tag,
        summary: summary || null
      };
      storePair(this._pair);
      if (replaced) {
        this._pendingReplaced = true;
      }
      return { mode: 'new', requestId: this._pair.requestId };
    },

    /** True when the last claim replaced a DIFFERENT pending intent. */
    consumePendingReplaced: function () {
      var value = this._pendingReplaced === true;
      this._pendingReplaced = false;
      return value;
    },

    /**
     * Current pending identity for read-only display, or null. orphan=true
     * means it belongs to a replaced publish session (blocked from claim).
     */
    pendingState: function () {
      if (!this._pair) return null;
      return {
        requestId: this._pair.requestId,
        draftKey: this._pair.draftKey,
        summary: this._pair.summary || null,
        orphan: this._pair.sessionTag !== currentSessionTag()
      };
    },

    /** Explicit user decision: abandon the pending intent. */
    discardPending: function () {
      var had = this._pair !== null;
      this._pair = null;
      storePair(null);
      return had;
    },

    /** Called when a publish attempt completed observably. */
    confirmCompleted: function () {
      this._pair = null;
      storePair(null);
    },

    /**
     * The server refused the request because no pre-established publish
     * session exists. This only proves THE REFUSED REQUEST created nothing —
     * it says nothing about any earlier pending attempt. The page never
     * reloads itself; the user decides what to do next.
     */
    handleMissingSession: function () {
      this._missingSessionRefusal = true;
    },

    missingSessionRefusal: function () {
      return this._missingSessionRefusal === true;
    },

    /**
     * Pure presentation helper: the status-line text for the current pending
     * state given the CURRENT draft key (null = unknown, e.g. empty form).
     * The text must follow draft changes: a diverged draft never claims the
     * original-request retry — submitting it is a new explicit publish.
     */
    pendingStatusMessage: function (pending, currentDraftKey) {
      if (!pending) return null;
      var tail = pending.requestId.slice(-6);
      var summaryTitle = pending.summary && pending.summary.title ? `（${pending.summary.title}）` : '';
      if (pending.orphan) {
        return `存在未确认发布${summaryTitle}（请求 …${tail}，属已失效的发布会话）：重新发布需确认放弃原请求；原请求可在管理后台按请求标识核对。`;
      }
      if (currentDraftKey === null || currentDraftKey === undefined) {
        return `存在未确认发布（请求 …${tail}）结果未知：可在管理后台按请求标识核对。`;
      }
      if (pending.draftKey === currentDraftKey) {
        return `上次发布${summaryTitle}（请求 …${tail}）结果未知：再次点击「发布并生成链接」将以原请求重试。`;
      }
      return `当前内容与未确认请求不同：提交将作为新发布（原请求 …${tail} 可在管理后台按请求标识核对）。`;
    },

    // ---- Dashboard clone intents (retry vs completed) ----

    persistCloneIntent: function (requestId, targetId) {
      try {
        window.sessionStorage.setItem(CLONE_STORAGE_KEY, JSON.stringify({
          requestId: requestId,
          targetId: targetId
        }));
      } catch (error) {
        /* Non-fatal: the retry path simply degrades to a new intent. */
      }
    },

    /**
     * Reconciles persisted clone intents with the server completion cookie.
     * Unconfirmed intents are KEPT (the form keeps retrying the same id);
     * only the completion cookie rotates them.
     */
    reconcileCloneIntents: function () {
      var intent = null;
      try {
        intent = JSON.parse(window.sessionStorage.getItem(CLONE_STORAGE_KEY) || 'null');
      } catch (error) {
        intent = null;
      }
      if (!intent) {
        this._lastCloneIntent = { completed: false, requestId: null, targetId: null };
        return this._lastCloneIntent;
      }
      var cookies = String(window.document.cookie || '').split(';');
      var doneId = null;
      for (var i = 0; i < cookies.length; i += 1) {
        var parts = cookies[i].trim().split('=');
        if (parts[0] === CLONE_DONE_COOKIE) {
          doneId = parts.slice(1).join('=');
        }
      }
      var completed = doneId === intent.requestId;
      if (completed) {
        try {
          window.sessionStorage.removeItem(CLONE_STORAGE_KEY);
        } catch (error) {
          /* ignore */
        }
      }
      // Remember the outcome: a completed intent is consumed from storage,
      // but the caller still needs to see (once) that it completed.
      this._lastCloneIntent = {
        completed: completed,
        requestId: intent.requestId,
        targetId: intent.targetId
      };
      return this._lastCloneIntent;
    },

    cloneIntentState: function () {
      if (!this._cloneIntentScanned) {
        this.reconcileCloneIntents();
        this._cloneIntentScanned = true;
      }
      return this._lastCloneIntent || { completed: false, requestId: null, targetId: null };
    }
  };
})();
