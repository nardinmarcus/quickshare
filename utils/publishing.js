'use strict';

// Publishing write maintenance primitives (T04, issue #28).
//
// The maintenance gate is a readers/writer protocol around every publishing
// write:
// - a publishing write holds the gate in SHARED mode for the whole write
//   transaction and refuses to write when `publishing_writes_paused` is set;
// - switching pause on takes the gate in EXCLUSIVE mode, which waits until
//   every in-flight publishing write has finished (drained). Once the pause
//   toggle has returned success, no earlier publishing transaction can still
//   commit new content, and every later write is refused until resume.
//
// Postgres implements the gate with a transaction-scoped advisory lock (see
// models/publishing.js); the memory Adapter implements the same observable
// protocol with MemoryPublishingGate below.

const PUBLISHING_PAUSED_CODE = 'publishing_writes_paused';
const PUBLISHING_UNAVAILABLE_CODE = 'publishing_unavailable';
const MAINTENANCE_GATE_LOCK_KEY = 'quickshare:publishing-writes-paused';
const PUBLISHING_PAUSED_AUDIT_ACTION = 'settings.publishing_writes_paused.update';

class PublishingPausedError extends Error {
  constructor(message = 'Publishing writes are paused for maintenance') {
    super(message);
    this.name = 'PublishingPausedError';
    this.code = PUBLISHING_PAUSED_CODE;
    this.status = 503;
    this.maintenance = true;
    this.retryable = true;
  }
}

// A write that could not pass the gate because the gate itself was busy
// (lock wait timeout / deadlock against the drain). Distinct from "paused":
// the write may succeed on retry with the same input.
class PublishingUnavailableError extends Error {
  constructor(message = 'Publishing is temporarily unavailable') {
    super(message);
    this.name = 'PublishingUnavailableError';
    this.code = PUBLISHING_UNAVAILABLE_CODE;
    this.status = 503;
    this.maintenance = true;
    this.retryable = true;
  }
}

function isPublishingPausedError(error) {
  return Boolean(error) && (
    error instanceof PublishingPausedError || error.code === PUBLISHING_PAUSED_CODE
  );
}

function isPublishingUnavailableError(error) {
  return Boolean(error) && (
    error instanceof PublishingUnavailableError || error.code === PUBLISHING_UNAVAILABLE_CODE
  );
}

// Either gate rejection: the HTTP layer answers both with the explicit
// maintenance 503.
function isPublishingGateError(error) {
  return isPublishingPausedError(error) || isPublishingUnavailableError(error);
}

// Readers/writer gate with the exact drain semantics of the Postgres
// advisory-lock protocol:
// - runWrite joins as a shared holder immediately while the gate is open;
// - once a pause is requested, new writers queue instead of joining, so the
//   drain can finish; when the pause lands they are rejected with
//   PublishingPausedError, mirroring a Postgres writer that acquires the
//   shared lock only after the toggle committed and then reads paused=true;
// - setPaused(true) resolves only after every in-flight writer finished;
// - setPaused(false) reopens the gate immediately.
// Toggles are serialized through a promise chain.
class MemoryPublishingGate {
  constructor() {
    this.paused = false;
    this.activeWriters = 0;
    this.pauseRequested = false;
    this.writeWaiters = [];
    this.drainWaiters = [];
    this.toggleChain = Promise.resolve();
  }

  isPaused() {
    return this.paused;
  }

  async runWrite(fn) {
    await this.acquireShared();

    try {
      return await fn();
    } finally {
      this.releaseShared();
    }
  }

  acquireShared() {
    if (this.paused) {
      return Promise.reject(new PublishingPausedError());
    }

    if (!this.pauseRequested) {
      this.activeWriters += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.writeWaiters.push({ resolve, reject });
    });
  }

  releaseShared() {
    this.activeWriters -= 1;

    if (this.pauseRequested && this.activeWriters === 0) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      waiters.forEach(resolve => resolve());
    }
  }

  settleWriteWaiters() {
    const waiters = this.writeWaiters;
    this.writeWaiters = [];

    if (this.paused) {
      waiters.forEach(waiter => waiter.reject(new PublishingPausedError()));
    } else {
      waiters.forEach((waiter) => {
        this.activeWriters += 1;
        waiter.resolve();
      });
    }
  }

  // onTransition(previous, next) runs while the gate is held exclusively,
  // before the new state becomes visible; if it throws, the toggle is
  // aborted and the previous state is kept (the Postgres path rolls the
  // whole toggle transaction back in the same situation).
  setPaused(value, onTransition) {
    if (typeof value !== 'boolean') {
      return Promise.reject(new TypeError('paused must be a boolean'));
    }

    const task = this.toggleChain.then(() => this.toggleNow(value, onTransition));
    this.toggleChain = task.catch(() => {});
    return task;
  }

  async toggleNow(value, onTransition) {
    if (this.paused === value) {
      return { paused: this.paused, changed: false };
    }

    if (value === false) {
      if (onTransition) {
        await onTransition(this.paused, value);
      }

      this.paused = false;
      this.settleWriteWaiters();
      return { paused: false, changed: true };
    }

    this.pauseRequested = true;

    try {
      while (this.activeWriters > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => this.drainWaiters.push(resolve));
      }

      if (onTransition) {
        await onTransition(this.paused, value);
      }

      this.paused = true;
    } finally {
      this.pauseRequested = false;
      this.settleWriteWaiters();
    }

    return { paused: true, changed: true };
  }
}

module.exports = {
  MAINTENANCE_GATE_LOCK_KEY,
  PUBLISHING_PAUSED_AUDIT_ACTION,
  PUBLISHING_PAUSED_CODE,
  PUBLISHING_UNAVAILABLE_CODE,
  MemoryPublishingGate,
  PublishingPausedError,
  PublishingUnavailableError,
  isPublishingGateError,
  isPublishingPausedError,
  isPublishingUnavailableError
};
