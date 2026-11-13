const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The conflict-diff Worker (public/js/diff-worker.js) runs the vendored
// jsdiff build (public/js/vendor/diff.js, diff@9.0.0) off the main thread
// under a hard budget. These tests execute the real Worker script in a
// vm sandbox with a minimal Worker-global shim, so the exact production
// code path — including its import of the vendored distribution and its
// byte-exact reconstruction guard — is what gets verified.

const VENDOR_PATH = path.join(__dirname, '..', 'public', 'js', 'vendor', 'diff.js');
const WORKER_PATH = path.join(__dirname, '..', 'public', 'js', 'diff-worker.js');

function createWorker() {
  const messages = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (message) => { messages.push(message); };
  sandbox.importScripts = (url) => {
    assert.equal(url, '/js/vendor/diff.js');
    const code = fs.readFileSync(VENDOR_PATH, 'utf8');
    vm.runInContext(code, context, { filename: 'diff.js' });
  };

  const context = vm.createContext(sandbox);
  const workerCode = fs.readFileSync(WORKER_PATH, 'utf8');
  vm.runInContext(workerCode, context, { filename: 'diff-worker.js' });

  return {
    messages,
    run(runId, before, after) {
      const start = messages.length;
      sandbox.onmessage({ data: { runId, before, after } });
      const produced = messages.slice(start);
      assert.equal(produced.length, 1, 'worker must answer exactly once per run');
      return produced[0];
    }
  };
}

test('vendored jsdiff is the pinned diff@9.0.0 distribution', () => {
  const crypto = require('node:crypto');
  const bytes = fs.readFileSync(VENDOR_PATH);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  // Byte-identical to the diff@9.0.0 npm tarball's dist/diff.js.
  assert.equal(sha256, '5773c7efb34715bb9a9b6a9ebf5b0ff00f85f9efa6d9fd69fc65e181364f7b2e');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'vendor', 'diff.min.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'vendor', 'LICENSE')));
});

test('worker diffs small inputs and preserves CRLF line bytes', () => {
  const worker = createWorker();

  const before = 'alpha\r\nbeta\r\ngamma\r\n';
  const after = 'alpha\r\nbeta changed\r\ngamma\r\n';
  const result = worker.run(7, before, after);

  assert.equal(result.runId, 7);
  assert.equal(result.ok, true);
  const rendered = result.parts.map(part => `${part.added ? '+' : part.removed ? '-' : ' '}${JSON.stringify(part.value)}`);
  assert.ok(rendered.some(line => line.startsWith('-') && line.includes('beta\\r\\n')), rendered.join(','));
  assert.ok(rendered.some(line => line.startsWith('+') && line.includes('beta changed\\r\\n')), rendered.join(','));

  // The parts must reconstruct both inputs byte for byte.
  let fromParts = '';
  let toParts = '';
  for (const part of result.parts) {
    if (!part.added) fromParts += part.value;
    if (!part.removed) toParts += part.value;
  }
  assert.equal(fromParts, before);
  assert.equal(toParts, after);
});

test('worker reports identical inputs as an all-context diff', () => {
  const worker = createWorker();
  const result = worker.run(1, 'same\ntext\n', 'same\ntext\n');
  assert.equal(result.ok, true);
  assert.ok(result.parts.every(part => !part.added && !part.removed));
});

test('an over-budget diff is reported as budget failure, never as "no changes"', () => {
  const worker = createWorker();

  // Two large, fully unrelated line sets: the Myers computation cannot
  // finish inside the 1000ms algorithm budget.
  const beforeLines = [];
  const afterLines = [];
  for (let index = 0; index < 4000; index += 1) {
    beforeLines.push(`before-line-${index}-${Math.random().toString(36).slice(2)}`);
    afterLines.push(`after-line-${index}-${Math.random().toString(36).slice(2)}`);
  }

  const result = worker.run(99, beforeLines.join('\n'), afterLines.join('\n'));
  assert.equal(result.runId, 99);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'budget');
  assert.equal(result.parts, undefined);
});
