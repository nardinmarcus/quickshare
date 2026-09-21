// Source diff client for the owner dashboard (#30).
//
// Wraps the local vendored jsdiff worker. Contract:
// - Only the CURRENT comparison target's result is ever rendered; switching
//   comparison objects invalidates in-flight worker results by id.
// - Outer termination deadline: 2000ms. On expiry the worker is terminated
//   and the UI reports "差异过大，未完成比较" — an unfinished comparison is
//   never displayed as "no differences".
// - Diff output is plain text (textContent only) with whitespace and line
//   breaks preserved.
(function () {
  const OUTER_DEADLINE_MS = 2000;

  let worker = null;
  let currentId = 0;
  let pending = null;

  function ensureWorker() {
    if (worker === null) {
      worker = new Worker('/js/source-diff-worker.js');
      worker.onmessage = function (event) {
        if (!pending || event.data.id !== pending.id) return; // stale result: discard
        const resolve = pending.resolve;
        clearTimeout(pending.timer);
        pending = null;
        resolve(event.data);
      };
      worker.onerror = function () {
        if (!pending) return;
        const reject = pending.reject;
        clearTimeout(pending.timer);
        pending = null;
        reject(new Error('worker-error'));
      };
    }
    return worker;
  }

  /**
   * Compares two pure-text sources. Resolves:
   *   { status: 'ok', parts: [...] }              finished comparison
   *   { status: 'timeout' }                       algorithm budget exhausted
   * Rejects only on worker failure; the caller renders unfinished states as
   * "未完成比较", never as an empty diff.
   */
  function compare(oldText, newText) {
    const id = ++currentId;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id: pending.id, status: 'timeout', superseded: true });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        // Outer deadline: terminate the algorithm, report unfinished.
        if (worker) {
          worker.terminate();
          worker = null;
        }
        resolve({ id: id, status: 'timeout' });
      }, OUTER_DEADLINE_MS);
      pending = { id: id, resolve: resolve, reject: reject, timer: timer };
      ensureWorker().postMessage({ id: id, oldText: oldText, newText: newText });
    });
  }

  /**
   * Renders jsdiff line parts into a container as plain text chunks.
   * Whitespace and line breaks are preserved verbatim.
   */
  function renderParts(container, parts) {
    container.textContent = '';
    parts.forEach(function (part) {
      const block = document.createElement('div');
      block.className = 'diff-part ' + (part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-context');
      const lines = part.value.split('\n');
      // diffLines keeps the trailing newline inside the last line token; an
      // empty final element after split is not a rendered line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      lines.forEach(function (line) {
        const row = document.createElement('div');
        row.className = 'diff-line';
        const marker = document.createElement('span');
        marker.className = 'diff-marker';
        marker.textContent = part.added ? '+' : part.removed ? '-' : ' ';
        const text = document.createElement('span');
        text.className = 'diff-line-text';
        text.textContent = line.length > 0 ? line : ' ';
        row.appendChild(marker);
        row.appendChild(text);
        block.appendChild(row);
      });
      container.appendChild(block);
    });
  }

  function formatValue(value) {
    return value === null || value === undefined || value === '' ? '（空）' : value;
  }

  /**
   * Renders meta-field (title/description/theme) differences as explicit
   * remote-vs-candidate rows; both directions are labelled so the owner can
   * tell what the remote changed from what the draft changes.
   */
  function renderMetaChanges(container, fields) {
    container.textContent = '';
    let any = false;
    fields.forEach(function (field) {
      if (field.remoteValue === field.localValue) return;
      any = true;
      const row = document.createElement('div');
      row.className = 'conflict-meta-row';

      const name = document.createElement('span');
      name.className = 'conflict-meta-name';
      name.textContent = field.label;

      const remote = document.createElement('span');
      remote.className = 'conflict-meta-remote';
      remote.textContent = '当前远端：' + formatValue(field.remoteValue);

      const local = document.createElement('span');
      local.className = 'conflict-meta-local';
      local.textContent = '我的修改：' + formatValue(field.localValue);

      row.appendChild(name);
      row.appendChild(remote);
      row.appendChild(local);
      container.appendChild(row);
    });
    container.hidden = !any;
  }

  window.SourceDiff = {
    compare: compare,
    renderParts: renderParts,
    renderMetaChanges: renderMetaChanges,
    OUTER_DEADLINE_MS: OUTER_DEADLINE_MS
  };
})();
