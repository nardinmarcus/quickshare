'use strict';

// Line-diff Web Worker for the admin conflict view (ticket T06, issue
// #30; parent spec #24 §9).
//
// The comparison runs the vendored, byte-identical official jsdiff
// distribution (diff@9.0.0, BSD-3-Clause; see /js/vendor/) — no CDN, no
// hand-written diff algorithm. Work happens off the main thread under a
// fixed budget: the jsdiff algorithm itself gets 1000ms (`timeout`
// option), and the main thread additionally terminates the Worker at a
// 2000ms outer deadline.
//
// An over-budget comparison is reported as a failure, NEVER as an empty
// or partial diff: jsdiff aborts an over-time computation by throwing (or
// returning no result), and this Worker only reports success after
// verifying that the returned parts reconstruct both inputs byte for
// byte. The UI can therefore trust that "no differences" always means
// the two texts are identical, and "差异过大，未完成比较" always means
// the comparison genuinely did not finish.

importScripts('/js/vendor/diff.js');

var DIFF_ALGORITHM_BUDGET_MS = 1000;

function reconstructs(parts, before, after) {
  var fromParts = '';
  var toParts = '';

  for (var index = 0; index < parts.length; index += 1) {
    var part = parts[index];

    if (!part.added) {
      fromParts += part.value;
    }
    if (!part.removed) {
      toParts += part.value;
    }
  }

  return fromParts === before && toParts === after;
}

self.onmessage = function (event) {
  var data = event.data || {};
  var runId = data.runId;
  var before = typeof data.before === 'string' ? data.before : '';
  var after = typeof data.after === 'string' ? data.after : '';

  var parts;

  try {
    parts = self.Diff.diffLines(before, after, {
      timeout: DIFF_ALGORITHM_BUDGET_MS
    });
  } catch (error) {
    // jsdiff aborts an over-budget diff by throwing; any other error also
    // means no trustworthy comparison exists.
    self.postMessage({ runId: runId, ok: false, reason: 'budget' });
    return;
  }

  if (!Array.isArray(parts) || !reconstructs(parts, before, after)) {
    self.postMessage({ runId: runId, ok: false, reason: 'budget' });
    return;
  }

  self.postMessage({
    runId: runId,
    ok: true,
    parts: parts.map(function (part) {
      return {
        value: part.value,
        added: part.added === true,
        removed: part.removed === true
      };
    })
  });
};
