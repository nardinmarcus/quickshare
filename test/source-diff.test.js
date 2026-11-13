const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The shared SourceDiff consumer (public/js/source-diff.js) owns the
// diff Worker lifecycle for both admin comparison surfaces (T07, issue
// #31). These tests execute the real module in a vm sandbox with a
// controllable fake Worker and fake timers, pinning the asynchronous
// contract the September review of #31 demanded:
//   - a current-run Worker failure rejects, so the consumer can reach a
//     truthful unfinished state instead of a permanent loading label;
//   - superseding a run resolves it as 'superseded', terminates its
//     Worker, and a late error/message from that terminated Worker can
//     neither paint nor reject the newer run;
//   - chunked rendering stops when the caller's currency guard drops,
//     so hiding/resetting/switching discards the old render.

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'source-diff.js');

function createHarness() {
  const workers = [];
  const timers = new Map();
  let timerSeq = 0;

  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.terminated = false;
      this.sent = [];
      workers.push(this);
    }

    postMessage(message) {
      this.sent.push(message);
    }

    terminate() {
      this.terminated = true;
    }

    respond(data) {
      if (this.onmessage) this.onmessage({ data });
    }

    fail(error) {
      if (this.onerror) this.onerror(error || new Error('worker boom'));
    }
  }

  function fakeSetTimeout(fn, ms) {
    timerSeq += 1;
    timers.set(timerSeq, { fn, ms });
    return timerSeq;
  }

  function fakeClearTimeout(id) {
    timers.delete(id);
  }

  function fireTimers(maxMs) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.ms <= maxMs)
      .sort((a, b) => a[0] - b[0]);

    for (const [id, timer] of due) {
      if (timers.delete(id)) timer.fn();
    }
  }

  function fakeElement() {
    return {
      children: [],
      className: '',
      textContent: '',
      isFragment: false,
      appendChild(node) {
        if (node && node.isFragment) {
          this.children.push(...node.children);
        } else {
          this.children.push(node);
        }
      }
    };
  }

  const sandbox = {
    console,
    Promise,
    Error,
    Worker: FakeWorker,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    document: {
      createElement: () => fakeElement(),
      createDocumentFragment: () => {
        const fragment = fakeElement();
        fragment.isFragment = true;
        return fragment;
      }
    }
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), context, { filename: 'source-diff.js' });

  return { SourceDiff: sandbox.window.SourceDiff, workers, timers, fireTimers, sandbox };
}

test('compare resolves ok with the worker parts', async () => {
  const { SourceDiff, workers } = createHarness();

  const promise = SourceDiff.compare('a\n', 'b\n');
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.equal(worker.url, '/js/diff-worker.js');
  const runId = worker.sent[0].runId;

  worker.respond({ runId, ok: true, parts: [{ value: 'a\n', removed: true }, { value: 'b\n', added: true }] });

  const result = await promise;
  assert.equal(result.status, 'ok');
  assert.equal(result.parts.length, 2);
  assert.equal(worker.terminated, true);
});

test('worker budget failure resolves as too-large, never as an empty diff', async () => {
  const { SourceDiff, workers } = createHarness();

  const promise = SourceDiff.compare('x', 'y');
  const worker = workers[0];
  worker.respond({ runId: worker.sent[0].runId, ok: false, reason: 'budget' });

  const result = await promise;
  assert.equal(result.status, 'too-large');
  assert.equal(result.parts, undefined);
});

test('the outer deadline resolves as too-large and terminates the worker', async () => {
  const { SourceDiff, workers, fireTimers } = createHarness();

  const promise = SourceDiff.compare('x', 'y');
  fireTimers(2000);

  const result = await promise;
  assert.equal(result.status, 'too-large');
  assert.equal(workers[0].terminated, true);
});

test('a Worker failure on the current run rejects so the consumer can finish truthfully', async () => {
  const { SourceDiff, workers } = createHarness();

  const promise = SourceDiff.compare('x', 'y');
  workers[0].fail(new Error('worker exploded'));

  await assert.rejects(promise, /worker exploded|diff worker failed/);
});

test('superseding resolves the old run and a late error from its terminated Worker cannot reject the new run', async () => {
  const { SourceDiff, workers } = createHarness();

  const first = SourceDiff.compare('one', 'two');
  const firstWorker = workers[0];

  const second = SourceDiff.compare('three', 'four');
  const secondWorker = workers[1];

  assert.equal(firstWorker.terminated, true);
  assert.equal((await first).status, 'superseded');

  // Late error and late message from the terminated Worker: both bound
  // to the settled first run, so the pending second run is untouched.
  firstWorker.fail(new Error('late failure'));
  firstWorker.respond({ runId: firstWorker.sent[0].runId, ok: true, parts: [] });

  let secondSettled = false;
  second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false);

  secondWorker.respond({
    runId: secondWorker.sent[0].runId,
    ok: true,
    parts: [{ value: 'three', removed: true }, { value: 'four', added: true }]
  });

  const result = await second;
  assert.equal(result.status, 'ok');
  assert.equal(secondSettled, true);
});

test('cancel resolves the pending run as superseded and terminates its Worker', async () => {
  const { SourceDiff, workers } = createHarness();

  const promise = SourceDiff.compare('x', 'y');
  SourceDiff.cancel();

  assert.equal((await promise).status, 'superseded');
  assert.equal(workers[0].terminated, true);
});

test('a Worker constructor failure rejects the comparison', async () => {
  const { SourceDiff, sandbox } = createHarness();

  sandbox.Worker = class {
    constructor() {
      throw new Error('workers unavailable');
    }
  };

  await assert.rejects(SourceDiff.compare('x', 'y'), /workers unavailable/);
});

test('renderParts reports change state and paints the first chunk synchronously', () => {
  const { SourceDiff } = createHarness();

  const container = {
    children: [],
    textContent: 'stale',
    appendChild(node) {
      this.children.push(...node.children);
    }
  };

  const changed = SourceDiff.renderParts(container, [
    { value: 'same\n', added: false, removed: false },
    { value: 'new\n', added: true, removed: false }
  ], () => true);

  assert.equal(changed, true);
  assert.equal(container.textContent, '');
  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].className, 'diff-line diff-line-added');
  assert.equal(container.children[1].textContent, '+ new');

  const unchanged = SourceDiff.renderParts(container, [
    { value: 'same\n', added: false, removed: false }
  ], () => true);
  assert.equal(unchanged, false);
});

test('renderParts stops chunking when the target is hidden, reset or switched mid-render', () => {
  const { SourceDiff, fireTimers } = createHarness();

  const container = {
    children: [],
    textContent: '',
    appendChild(node) {
      this.children.push(...node.children);
    }
  };

  const manyLines = Array.from({ length: 900 }, (_, index) => `line-${index}`).join('\n') + '\n';
  let current = true;

  SourceDiff.renderParts(container, [{ value: manyLines, added: false, removed: false }], () => current);
  assert.equal(container.children.length, 400);

  // The consumer hides/switches the target: the captured chunk loop
  // must stop instead of painting the remaining 500 lines.
  current = false;
  fireTimers(0);
  fireTimers(0);
  assert.equal(container.children.length, 400);

  // A fresh render for the new target completes fully.
  const secondContainer = {
    children: [],
    textContent: '',
    appendChild(node) {
      this.children.push(...node.children);
    }
  };
  SourceDiff.renderParts(secondContainer, [{ value: manyLines, added: false, removed: false }], () => true);
  fireTimers(0);
  fireTimers(0);
  fireTimers(0);
  assert.equal(secondContainer.children.length, 900);
});
