'use strict';

// Publishing transaction interface for Postgres (T04, issue #28).
//
// Every publishing write runs through withPublishingWrite, which keeps the
// maintenance check and the write itself in ONE transaction on ONE client:
//
//   BEGIN
//   SELECT pg_advisory_xact_lock_shared(hashtext(gate key))   -- shared gate
//   SELECT publishing_writes_paused FROM site_settings        -- refuse if set
//   ... the write itself ...
//   COMMIT
//
// Switching pause on (setPublishingWritesPaused) takes the same advisory
// lock in EXCLUSIVE mode inside its own transaction. The exclusive request
// waits until every in-flight shared holder has committed or rolled back,
// so when the toggle returns success the drain is real: no earlier
// publishing transaction can still commit, and any writer that acquires the
// shared lock afterwards reads paused = true and is refused. The gate lock
// is always the first lock a publishing transaction takes (the parent
// spec's fixed lock order: maintenance gate before any row locks).
//
// Lock waits that are cut short by statement timeout / lock timeout /
// deadlock surface as PublishingUnavailableError (a retryable 503), never
// as a half-applied write: the transaction is rolled back first.

const {
  MAINTENANCE_GATE_LOCK_KEY,
  PUBLISHING_PAUSED_AUDIT_ACTION,
  PublishingPausedError,
  PublishingUnavailableError
} = require('../utils/publishing');

// 57014 query_canceled (statement/lock timeout), 55P03 lock_not_available,
// 40P01 deadlock_detected.
const GATE_CONTENTION_CODES = new Set(['57014', '55P03', '40P01']);

function mapPublishingError(error) {
  if (error && GATE_CONTENTION_CODES.has(error.code)) {
    const wrapped = new PublishingUnavailableError(
      'Publishing gate is busy; the write was not applied and can be retried'
    );
    wrapped.cause = error;
    return wrapped;
  }

  return error;
}

async function readPublishingWritesPaused(client) {
  const result = await client.query(
    'SELECT publishing_writes_paused FROM public.site_settings WHERE id = 1 LIMIT 1'
  );
  const value = result.rows[0]?.publishing_writes_paused;

  if (typeof value !== 'boolean') {
    throw new Error('Publishing maintenance setting is unavailable');
  }

  return value;
}

// Takes the shared gate lock on an already-open transaction and refuses the
// write when publishing is paused. Callers must run this before any other
// statement of the write transaction.
async function acquirePublishingWriteGate(client) {
  await client.query(
    'SELECT pg_advisory_xact_lock_shared(hashtext($1))',
    [MAINTENANCE_GATE_LOCK_KEY]
  );

  if (await readPublishingWritesPaused(client)) {
    throw new PublishingPausedError();
  }
}

async function withPublishingWrite(pool, fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    try {
      await acquirePublishingWriteGate(client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Also the path taken when COMMIT itself fails (e.g. a deferred
      // constraint): Postgres has already aborted the transaction, so the
      // rollback is a formality and the advisory gate lock is released with
      // the transaction either way.
      await client.query('ROLLBACK').catch(() => {});
      throw mapPublishingError(error);
    }
  } finally {
    client.release();
  }
}

async function getPublishingWritesPaused(pool) {
  const client = await pool.connect();

  try {
    return await readPublishingWritesPaused(client);
  } finally {
    client.release();
  }
}

// Controlled operator toggle. The exclusive gate wait IS the drain, so it
// must not be cut short by the pool's statement timeout: statement_timeout
// is disabled for this transaction only. The state change and its audit
// record commit atomically with the drained lock.
async function setPublishingWritesPaused(pool, { paused, ip } = {}) {
  if (typeof paused !== 'boolean') {
    throw new TypeError('paused must be a boolean');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    try {
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [MAINTENANCE_GATE_LOCK_KEY]
      );

      const currentResult = await client.query(
        'SELECT publishing_writes_paused FROM public.site_settings WHERE id = 1 FOR UPDATE'
      );
      const previousValue = currentResult.rows[0]?.publishing_writes_paused;

      if (typeof previousValue !== 'boolean') {
        throw new Error('Publishing maintenance setting is unavailable');
      }

      if (previousValue === paused) {
        await client.query('COMMIT');
        return { paused, changed: false };
      }

      const updatedAt = Date.now();
      await client.query(
        'UPDATE public.site_settings SET publishing_writes_paused = $1, updated_at = $2 WHERE id = 1',
        [paused, updatedAt]
      );
      await client.query(
        'INSERT INTO public.audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
        [
          PUBLISHING_PAUSED_AUDIT_ACTION,
          null,
          JSON.stringify({ from: previousValue, to: paused }),
          ip || null,
          updatedAt
        ]
      );
      await client.query('COMMIT');

      return { paused, changed: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

module.exports = {
  acquirePublishingWriteGate,
  getPublishingWritesPaused,
  mapPublishingError,
  readPublishingWritesPaused,
  setPublishingWritesPaused,
  withPublishingWrite
};
