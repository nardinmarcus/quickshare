const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function loadWorker() {
  const context = {
    importScripts: function (src) {
      assert.equal(src, '/vendor/diff/diff.min.js');
      // Load the official readable dist into this context, exactly as the
      // browser worker would load the vendored minified build.
      const official = fs.readFileSync(path.join(__dirname, '..', 'public/vendor/diff/diff.js'), 'utf8');
      vm.runInContext(official, context);
    },
    postMessage: null,
    console
  };
  context.self = context;
  vm.createContext(context);
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/source-diff-worker.js'), 'utf8');
  vm.runInContext(workerSource, context);
  return context;
}

function runWorker(context, payload) {
  return new Promise(resolve => {
    context.postMessage = message => resolve(message);
    context.onmessage({ data: payload });
  });
}

test('worker computes official line diffs preserving whitespace and newlines', async () => {
  const context = loadWorker();
  const oldText = 'line one\nline  two\n   indented   \nshared\n';
  const newText = 'line one\nline  two\n\tindented with tab\t\nshared\nadded tail';
  const message = await runWorker(context, { id: 7, oldText, newText });
  assert.equal(message.id, 7);
  assert.equal(message.status, 'ok');
  assert.ok(Array.isArray(message.parts) && message.parts.length > 0);
  const removed = message.parts.filter(part => part.removed).map(part => part.value).join('');
  const added = message.parts.filter(part => part.added).map(part => part.value).join('');
  assert.ok(removed.includes('   indented   '), 'removed side keeps original spacing');
  assert.ok(added.includes('\tindented with tab\t'), 'added side keeps new spacing');
  assert.ok(added.includes('added tail'));
  assert.ok(message.parts.every(part => part.count > 0 && (part.added || part.removed || part.count)));
});

test('worker reports identical inputs as a real comparison, never as unfinished', async () => {
  const context = loadWorker();
  const message = await runWorker(context, { id: 1, oldText: 'same\nlines\n', newText: 'same\nlines\n' });
  assert.equal(message.status, 'ok');
  assert.equal(message.parts.filter(part => part.added || part.removed).length, 0);
});

test('worker keeps CRLF and trailing-newline differences visible', async () => {
  const context = loadWorker();
  const message = await runWorker(context, { id: 2, oldText: 'a\r\nb', newText: 'a\nb\n' });
  assert.equal(message.status, 'ok');
  const removed = message.parts.filter(part => part.removed).map(part => JSON.stringify(part.value)).join('');
  const added = message.parts.filter(part => part.added).map(part => JSON.stringify(part.value)).join('');
  assert.ok(removed.includes('\\r\\n'), 'CRLF removal is part of the diff');
  assert.ok(added.includes('b\\n'), 'trailing newline change is part of the diff');
});

test('worker reports oversized comparisons as timeout, not as an empty diff', async () => {
  const context = loadWorker();
  // Two fully different large inputs: the Myers search cannot finish within
  // the 1000ms worker budget, so the worker must answer {status:'timeout'}.
  const build = seed => Array.from({ length: 120000 }, (_, index) => `L${index}-${(index * 31 + seed) % 9973}`).join('\n') + '\n';
  const message = await runWorker(context, { id: 3, oldText: build(1), newText: build(2) });
  assert.equal(message.status, 'timeout');
  assert.equal(message.parts, undefined);
}, { timeout: 30000 });

test('worker echoes errors without leaking internals', async () => {
  const context = loadWorker();
  // Force the official diff to throw so the catch path is exercised.
  context.Diff = { diffLines: () => { throw new Error('synthetic internal failure'); } };
  const message = await runWorker(context, { id: 4, oldText: 'a', newText: 'b' });
  assert.equal(message.id, 4);
  assert.equal(message.status, 'error');
  assert.ok(typeof message.message === 'string' && message.message.length < 200);
  assert.doesNotMatch(message.message, /synthetic internal failure/, 'internal errors are not leaked');
});

// ---- #31 rework R2-failure-path: worker error events are owned by the
// worker generation that received the comparison. A late error from an
// already-terminated old worker must never reject a NEW worker's pending
// comparison, and a timed-out comparison must not be resurrected by its old
// worker's late events. ----

test('worker error ownership is bound to the worker generation', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync('public/js/source-diff.js', 'utf8');
  const workers = [];
  class WorkerStub {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const timers = [];
  const context = {
    document: { createElement: () => ({ textContent: '', children: [], appendChild() {} }) },
    Worker: WorkerStub,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {}
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const SourceDiff = context.SourceDiff;

  // Comparison 1: worker #1 (generation 1); answered OK.
  const first = SourceDiff.compare('a', 'b');
  assert.equal(workers.length, 1);
  workers[0].onmessage({ data: { id: 1, status: 'ok', parts: [] } });
  const firstResult = await first;
  assert.equal(firstResult.status, 'ok');

  // Comparison 2: reuses worker #1; the outer deadline fires → worker
  // terminated and the comparison reports timeout.
  const second = SourceDiff.compare('c', 'd');
  assert.equal(workers.length, 1, 'a healthy worker is reused');
  const deadlineTimer = timers.pop();
  assert.equal(deadlineTimer.ms, 2000);
  deadlineTimer.callback();
  const secondResult = await second;
  assert.equal(secondResult.status, 'timeout');
  assert.equal(workers[0].terminated, true, 'the deadline terminates the old worker');

  // Comparison 3: a NEW worker (generation 2) is created.
  const third = SourceDiff.compare('e', 'f');
  assert.equal(workers.length, 2, 'a terminated worker is replaced by a fresh one');

  // LATE error from the OLD (terminated) worker #1: this must NOT reject
  // comparison 3, which is owned by worker #2.
  workers[0].onerror(new Error('stale worker failure'));

  workers[1].onmessage({ data: { id: 3, status: 'ok', parts: [] } });
  const thirdResult = await third;
  assert.equal(thirdResult.status, 'ok', 'the new worker\'s pending comparison survives a late old-worker error');
});
