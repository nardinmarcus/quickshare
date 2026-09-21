// Source diff worker (#30). Runs the OFFICIAL vendored jsdiff build — the
// algorithm lives in /vendor/diff/diff.min.js (diff@9.0.0, BSD-3-Clause),
// never in this file, and never behind a CDN.
//
// Contract: algorithm budget 1000ms inside the worker; the page enforces a
// 2000ms outer termination deadline. An unfinished comparison is reported as
// { status: 'timeout' } — never as an empty (no-difference) result.
importScripts('/vendor/diff/diff.min.js');

const DIFF_TIMEOUT_MS = 1000;

self.onmessage = function (event) {
  const payload = event.data || {};
  const id = payload.id;

  try {
    // diffLines keeps every line together with its original line break and
    // whitespace: pure text comparison, no HTML interpretation.
    const parts = Diff.diffLines(String(payload.oldText || ''), String(payload.newText || ''), {
      timeout: DIFF_TIMEOUT_MS
    });

    if (!parts) {
      // jsdiff returns undefined when the timeout/maxEditLength budget is hit.
      self.postMessage({ id: id, status: 'timeout' });
      return;
    }

    self.postMessage({
      id: id,
      status: 'ok',
      parts: parts.map(function (part) {
        return { value: part.value, added: part.added === true, removed: part.removed === true, count: part.count };
      })
    });
  } catch (error) {
    self.postMessage({ id: id, status: 'error', message: '差异比较失败，请稍后重试' });
  }
};
