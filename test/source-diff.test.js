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
