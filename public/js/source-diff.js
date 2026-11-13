(function () {
  // Shared asynchronous line-diff consumer for the admin surfaces
  // (ticket T07, issue #31; mechanism introduced by T06, issue #30;
  // parent spec #24 §9).
  //
  // Both the content-conflict view (admin-detail.js) and the history
  // comparison (admin-history.js) compare two texts through this module
  // so they share identical semantics:
  //
  // - The comparison itself runs in the diff Worker (vendored jsdiff
  //   diff@9.0.0, 1000ms algorithm budget inside the Worker) under a
  //   2000ms outer deadline on this thread.
  // - compare(before, after) resolves with exactly one of:
  //     { status: 'ok', parts }        — a verified, byte-exact diff;
  //     { status: 'too-large' }        — the comparison did not finish
  //       within budget (Worker budget failure or outer deadline). This
  //       is NEVER reported as "no differences";
  //     { status: 'superseded' }       — a newer compare()/cancel()
  //       replaced this run before it settled.
  //   compare() rejects only when the Worker itself fails (construction
  //   or runtime error) for the still-current run; the caller must turn
  //   that rejection into a truthful unfinished state, not a spinner.
  // - Starting a new comparison (or calling cancel()) supersedes the
  //   pending one: its Worker is terminated and its promise resolves as
  //   'superseded'. Late messages or errors from a terminated Worker are
  //   bound to their own settled run record, so they can neither paint
  //   nor reject a newer run.
  // - renderParts() appends diff lines in chunks; every chunk re-checks
  //   the caller's isCurrent() guard, so hiding, resetting or switching
  //   the comparison target stops the old rendering immediately instead
  //   of letting a captured chunk loop keep painting into the new view.

  var WORKER_URL = '/js/diff-worker.js';
  var OUTER_DEADLINE_MS = 2000;
  var CHUNK_SIZE = 400;

  var currentRun = null;
  var nextRunId = 0;

  function settleSuperseded(run) {
    if (!run || run.settled) return;

    run.settled = true;

    if (run.deadline) {
      clearTimeout(run.deadline);
      run.deadline = null;
    }

    if (run.worker) {
      run.worker.terminate();
      run.worker = null;
    }

    if (currentRun === run) {
      currentRun = null;
    }

    run.resolve({ status: 'superseded' });
  }

  function compare(before, after) {
    settleSuperseded(currentRun);

    return new Promise(function (resolve, reject) {
      var run = {
        settled: false,
        worker: null,
        deadline: null,
        resolve: resolve,
        reject: reject
      };
      currentRun = run;
      nextRunId += 1;
      var runId = nextRunId;

      function finishOk(value) {
        if (run.settled) return;

        run.settled = true;

        if (run.deadline) {
          clearTimeout(run.deadline);
          run.deadline = null;
        }

        if (currentRun === run) {
          currentRun = null;
        }

        if (run.worker) {
          run.worker.terminate();
          run.worker = null;
        }

        resolve(value);
      }

      function finishError(error) {
        if (run.settled) return;

        run.settled = true;

        if (run.deadline) {
          clearTimeout(run.deadline);
          run.deadline = null;
        }

        if (currentRun === run) {
          currentRun = null;
        }

        if (run.worker) {
          try {
            run.worker.terminate();
          } catch (ignored) {
            // Terminating an already-dead Worker is not an error path.
          }
          run.worker = null;
        }

        reject(error);
      }

      var worker;

      try {
        worker = new Worker(WORKER_URL);
      } catch (error) {
        run.settled = true;
        if (currentRun === run) {
          currentRun = null;
        }
        reject(error);
        return;
      }

      run.worker = worker;

      run.deadline = setTimeout(function () {
        // Outer deadline: no trustworthy result arrived in time. The
        // comparison is unfinished — never a fake empty diff.
        finishOk({ status: 'too-large' });
      }, OUTER_DEADLINE_MS);

      worker.onmessage = function (event) {
        if (run.settled) return;
        if (!event.data || event.data.runId !== runId) return;

        if (!event.data.ok) {
          finishOk({ status: 'too-large' });
          return;
        }

        finishOk({ status: 'ok', parts: event.data.parts });
      };

      worker.onerror = function () {
        // Only this run's own record can be rejected here; if the run
        // was superseded, `settled` is already true and a late error
        // from the terminated Worker cannot reject a newer comparison.
        finishError(new Error('diff worker failed'));
      };

      worker.postMessage({ runId: runId, before: before, after: after });
    });
  }

  function cancel() {
    settleSuperseded(currentRun);
  }

  function splitLines(parts) {
    var lines = [];

    (parts || []).forEach(function (part) {
      var kind = part.added ? 'added' : part.removed ? 'removed' : 'context';
      var prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      var segments = String(part.value).split('\n');

      segments.forEach(function (segment, index) {
        if (index === segments.length - 1 && segment === '') {
          return;
        }
        lines.push({ text: prefix + segment, kind: kind });
      });
    });

    return lines;
  }

  // Chunked diff rendering. Returns whether the parts contain any
  // added/removed line. The container is cleared synchronously; chunk
  // appends after the first are scheduled and each one re-checks
  // isCurrent() before painting, so a hidden/reset/switched target
  // stops the previous render instead of being painted over.
  function renderParts(container, parts, isCurrent) {
    var lines = splitLines(parts);
    var hasChanges = lines.some(function (line) { return line.kind !== 'context'; });

    container.textContent = '';

    if (typeof isCurrent === 'function' && !isCurrent()) {
      return hasChanges;
    }

    var index = 0;

    (function appendChunk() {
      if (index > 0 && typeof isCurrent === 'function' && !isCurrent()) {
        return;
      }

      var fragment = document.createDocumentFragment();
      var end = Math.min(index + CHUNK_SIZE, lines.length);

      for (; index < end; index += 1) {
        var div = document.createElement('div');
        div.className = 'diff-line diff-line-' + lines[index].kind;
        div.textContent = lines[index].text;
        fragment.appendChild(div);
      }

      container.appendChild(fragment);

      if (index < lines.length) {
        setTimeout(appendChunk, 0);
      }
    })();

    return hasChanges;
  }

  window.SourceDiff = {
    compare: compare,
    cancel: cancel,
    renderParts: renderParts,
    splitLines: splitLines
  };
})();
