// Source diff client for the owner dashboard (#30) and Share history (#31).
//
// Wraps the local vendored jsdiff worker. Contract:
// - Only the CURRENT comparison target's result is ever rendered; switching
//   comparison objects invalidates in-flight worker results by id.
// - Outer termination deadline: 2000ms. On expiry the worker is terminated
//   and the UI reports "差异过大，未完成比较" — an unfinished comparison is
//   never displayed as "no differences".
// - Diff output is plain text (textContent only) with whitespace and line
//   breaks preserved.
// - #31: rendering is bounded and chunked so very large diffs never block the
//   page; rows beyond the hard cap are honestly truncated (never silently
//   dropped), and meta comparisons can label both sides with the selected
//   revision numbers instead of the conflict wording.
(function () {
  const OUTER_DEADLINE_MS = 2000;
  const MAX_RENDERED_ROWS = 2000;
  const DEFAULT_CHUNK_ROWS = 250;

  let worker = null;
  let workerGeneration = 0;
  let currentId = 0;
  let pending = null;
  const renderTokens = new WeakMap();

  function ensureWorker() {
    if (worker === null) {
      worker = new Worker('/js/source-diff-worker.js');
      const generation = ++workerGeneration;
      worker.onmessage = function (event) {
        if (!pending || event.data.id !== pending.id || pending.generation !== generation) return; // stale result: discard
        const resolve = pending.resolve;
        clearTimeout(pending.timer);
        pending = null;
        resolve(event.data);
      };
      worker.onerror = function () {
        // Error ownership: only the pending comparison owned by THIS worker
        // generation may be rejected. A late error from an already-terminated
        // or replaced worker must never reject a newer worker's pending
        // comparison. The broken worker is discarded; the next comparison
        // gets a fresh one.
        if (!pending || pending.generation !== generation) return;
        const reject = pending.reject;
        clearTimeout(pending.timer);
        pending = null;
        worker = null;
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
    const workerInstance = ensureWorker();
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
      pending = { id: id, generation: workerGeneration, resolve: resolve, reject: reject, timer: timer };
      workerInstance.postMessage({ id: id, oldText: oldText, newText: newText });
    });
  }

  function defaultScheduler() {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      return function (callback) { return window.requestAnimationFrame(callback); };
    }
    if (typeof setTimeout === 'function') {
      return function (callback) { return setTimeout(callback, 0); };
    }
    return null;
  }

  /**
   * Cancels any in-flight chunked render into the container. The next
   * renderParts call issues a fresh token automatically; call this when the
   * container is cleared or hidden without a follow-up render.
   */
  function cancelRender(container) {
    if (!container) return;
    renderTokens.set(container, (renderTokens.get(container) || 0) + 1);
  }

  /**
   * Renders jsdiff line parts as plain-text rows with whitespace and line
   * breaks preserved. Rendering is chunked: the first `chunkSize` rows are
   * appended synchronously and the rest follow through the scheduler, so a
   * huge diff never blocks the page. At most MAX_RENDERED_ROWS rows are
   * displayed; beyond that an explicit truncation notice is appended — the
   * owner is told the display is bounded, never shown a fake "no difference".
   * Returns { totalRows, truncated } synchronously.
   */
  function renderParts(container, parts, options) {
    const opts = options || {};
    const chunkSize = Math.max(Math.trunc(Number(opts.chunkSize)) || DEFAULT_CHUNK_ROWS, 1);
    const noticeText = typeof opts.truncationNotice === 'string'
      ? opts.truncationNotice
      : '差异行数过多，仅显示前 ' + MAX_RENDERED_ROWS + ' 行；完整内容请用「原稿」分别查看。';
    cancelRender(container);
    const token = renderTokens.get(container) || 0;

    const rows = [];
    let totalLines = 0;
    let truncated = false;
    (parts || []).forEach(function (part) {
      const lines = String(part.value).split('\n');
      // diffLines keeps the trailing newline inside the last line token; an
      // empty final element after split is not a rendered line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      totalLines += lines.length;
      for (let index = 0; index < lines.length; index += 1) {
        if (rows.length >= MAX_RENDERED_ROWS) {
          truncated = true;
          break;
        }
        rows.push({ added: part.added === true, removed: part.removed === true, text: lines[index] });
      }
    });

    container.textContent = '';
    let index = 0;

    function appendNotice() {
      const notice = document.createElement('div');
      notice.className = 'diff-truncated';
      notice.textContent = noticeText;
      container.appendChild(notice);
    }

    function appendChunk() {
      const end = Math.min(index + chunkSize, rows.length);
      for (; index < end; index += 1) {
        const row = rows[index];
        const line = document.createElement('div');
        line.className = 'diff-line ' + (row.added ? 'diff-added' : row.removed ? 'diff-removed' : 'diff-context');
        const marker = document.createElement('span');
        marker.className = 'diff-marker';
        marker.textContent = row.added ? '+' : row.removed ? '-' : ' ';
        const text = document.createElement('span');
        text.className = 'diff-line-text';
        text.textContent = row.text.length > 0 ? row.text : ' ';
        line.appendChild(marker);
        line.appendChild(text);
        container.appendChild(line);
      }
      if (index >= rows.length && truncated) appendNotice();
      return index >= rows.length;
    }

    function finish() {
      if (typeof opts.onDone === 'function') opts.onDone({ totalRows: totalLines, truncated: truncated });
    }

    if (appendChunk()) {
      finish();
      return { totalRows: totalLines, truncated: truncated };
    }

    const schedule = opts.schedule || defaultScheduler();
    if (!schedule) {
      while (!appendChunk());
      finish();
      return { totalRows: totalLines, truncated: truncated };
    }

    schedule(function continueChunks() {
      if ((renderTokens.get(container) || 0) !== token) return; // superseded render
      if (appendChunk()) {
        finish();
        return;
      }
      schedule(continueChunks);
    });
    return { totalRows: totalLines, truncated: truncated };
  }

  function formatValue(value) {
    return value === null || value === undefined || value === '' ? '（空）' : value;
  }

  /**
   * Renders meta-field (title/description/theme) differences as explicit
   * labelled rows. Default labels keep the #30 conflict wording
   * ("当前远端" vs "我的修改"); history comparisons (#31) pass
   * { previousLabel, currentLabel } so both sides identify the selected
   * revisions instead of mislabelling them as a pending draft.
   */
  function renderMetaChanges(container, fields, options) {
    const labels = options || {};
    const previousLabel = labels.previousLabel || '当前远端';
    const currentLabel = labels.currentLabel || '我的修改';
    container.textContent = '';
    let any = false;
    (fields || []).forEach(function (field) {
      if (field.remoteValue === field.localValue) return;
      any = true;
      const row = document.createElement('div');
      row.className = 'conflict-meta-row';

      const name = document.createElement('span');
      name.className = 'conflict-meta-name';
      name.textContent = field.label;

      const remote = document.createElement('span');
      remote.className = 'conflict-meta-remote';
      remote.textContent = previousLabel + '：' + formatValue(field.remoteValue);

      const local = document.createElement('span');
      local.className = 'conflict-meta-local';
      local.textContent = currentLabel + '：' + formatValue(field.localValue);

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
    cancelRender: cancelRender,
    OUTER_DEADLINE_MS: OUTER_DEADLINE_MS,
    MAX_RENDERED_ROWS: MAX_RENDERED_ROWS
  };
})();
