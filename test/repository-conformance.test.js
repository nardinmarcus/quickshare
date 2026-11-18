const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPageRepository } = require('../models/memory-pages');
const { PostgresPageRepository } = require('../models/postgres-pages');

// Interface conformance between the two page-repository implementations
// (audit 2026-11-18, problem 7). models/pageRepository.js switches between
// MemoryPageRepository (the test foundation) and PostgresPageRepository
// (production) by duck typing; there is no shared interface definition, so
// a method added, renamed or re-signed on one side only is invisible until
// it breaks in the other environment. This suite enumerates the public
// method surface of both implementations — prototype chain plus instance
// function properties, excluding the constructor and `_`-prefixed names —
// and fails on any difference that is not recorded below.
//
// Arity means `function.length` (parameters before the first default),
// which is the part of a signature a caller can rely on positionally.
//
// KNOWN DIFFERENCES: every entry must stay true. The last test in this
// file asserts that each whitelist entry still describes a real, current
// difference, so a stale entry fails the suite and must be removed rather
// than left to rot. To clear an entry, bring the other implementation to
// parity (or rename the helper with a `_` prefix if it is internal).

const ONLY_IN_POSTGRES = {
  // First parameter is a node-postgres client; only ever called via
  // this.* inside postgres-pages.js. The memory implementation has no
  // client concept and inlines the equivalent update logic.
  applyPageUpdate:
    'Postgres-internal helper keyed on a transaction client; never called through the repository interface.',
  // Second parameter defaults to the pg pool; only ever called via
  // this.* inside postgres-pages.js.
  accessPreconditionMiss:
    'Postgres-internal helper keyed on the pg pool; never called through the repository interface.'
};

const ONLY_IN_MEMORY = {
  // Idempotency-operation bookkeeping. The memory store keeps operation
  // records in Maps and needs these helpers; Postgres performs the same
  // bookkeeping in SQL inside its public methods. None of them has a call
  // site outside memory-pages.js.
  operationKey: 'Memory-internal idempotency bookkeeping (Map key builder).',
  findOperationRecord: 'Memory-internal idempotency bookkeeping (Map lookup).',
  storeOperationRecord: 'Memory-internal idempotency bookkeeping (Map write).',
  resolveExistingOperation: 'Memory-internal idempotency replay resolution.',
  runOperationExclusive: 'Memory-internal per-operation promise chaining.',
  resultShareState: 'Memory-internal helper shaping an operation result.',
  tombstoneOperationsForShares:
    'Memory-internal idempotency tombstoning on permanent delete.',
  // Unlocked cores: the public memory create/updatePage wrap these with
  // operation exclusion; Postgres expresses the same split in SQL.
  createUnlocked: 'Memory-internal core wrapped by the public create path.',
  updatePageUnlocked: 'Memory-internal core wrapped by the public updatePage path.',
  // Content-snapshot internals of the Map-backed store.
  writeContentSnapshot: 'Memory-internal snapshot writer for the Map store.',
  ensureContentBaseline: 'Memory-internal baseline bootstrap for legacy shares.',
  // Credential re-check performed inline by Postgres inside its write
  // transactions (credentialVersion discipline, spec #24 section 6).
  recheckManagedCredential: 'Memory-internal credential-version recheck.',
  // Grant storage internals of the Map-backed store; Postgres keeps
  // grants in SQL rows instead.
  grantRecordKey: 'Memory-internal grant Map key builder.',
  normalizeMemoryGrant: 'Memory-internal grant record normalizer.',
  removeGrantsForShare: 'Memory-internal grant cleanup on permanent delete.'
};

// Shared methods whose declared arity legitimately differs. None today:
// every method present on both implementations declares the same arity.
// Entries take the form { methodName: [memoryLength, postgresLength] }.
const ARITY_EXCEPTIONS = {};

function collectSurface(instance, Klass) {
  const surface = new Map();

  if (instance) {
    for (const name of Object.getOwnPropertyNames(instance)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      if (typeof instance[name] === 'function') {
        surface.set(name, instance[name].length);
      }
    }
  }

  let proto = Klass.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name.startsWith('_') || surface.has(name)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === 'function') {
        surface.set(name, descriptor.value.length);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  return surface;
}

let memorySurface;
let postgresSurface;
let postgresRepository;

before(() => {
  memorySurface = collectSurface(new MemoryPageRepository(), MemoryPageRepository);
  // Construction only builds a pg Pool; it does not connect. The pool is
  // ended in after() so the test process can exit.
  postgresRepository = new PostgresPageRepository(
    'postgres://conformance:conformance@127.0.0.1:5432/conformance_test',
    {}
  );
  postgresSurface = collectSurface(postgresRepository, PostgresPageRepository);
});

after(async () => {
  if (postgresRepository && postgresRepository.pool) {
    await postgresRepository.pool.end();
  }
});

test('memory repository implements every public postgres repository method', () => {
  const missing = [];
  for (const name of postgresSurface.keys()) {
    if (name in ONLY_IN_POSTGRES) continue;
    if (!memorySurface.has(name)) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `MemoryPageRepository is missing methods that PostgresPageRepository exposes: ${missing.join(', ')}. ` +
      'Add them to the memory implementation, or record the difference in ONLY_IN_POSTGRES with a reason.'
  );
});

test('postgres repository implements every public memory repository method', () => {
  const missing = [];
  for (const name of memorySurface.keys()) {
    if (name in ONLY_IN_MEMORY) continue;
    if (!postgresSurface.has(name)) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `PostgresPageRepository is missing methods that MemoryPageRepository exposes: ${missing.join(', ')}. ` +
      'Add them to the postgres implementation, or record the difference in ONLY_IN_MEMORY with a reason.'
  );
});

test('shared repository methods declare the same arity', () => {
  const mismatched = [];
  for (const [name, postgresArity] of postgresSurface) {
    if (!memorySurface.has(name)) continue;
    const memoryArity = memorySurface.get(name);
    if (memoryArity === postgresArity) continue;
    const exception = ARITY_EXCEPTIONS[name];
    if (exception && exception[0] === memoryArity && exception[1] === postgresArity) {
      continue;
    }
    mismatched.push(`${name} (memory: ${memoryArity}, postgres: ${postgresArity})`);
  }

  assert.deepEqual(
    mismatched,
    [],
    `Repository methods with diverging arity: ${mismatched.join('; ')}. ` +
      'Align the signatures, or record the pair in ARITY_EXCEPTIONS with a reason.'
  );
});

test('conformance whitelist entries still describe real differences', () => {
  const stale = [];

  for (const name of Object.keys(ONLY_IN_POSTGRES)) {
    if (!postgresSurface.has(name) || memorySurface.has(name)) {
      stale.push(`ONLY_IN_POSTGRES.${name}`);
    }
  }
  for (const name of Object.keys(ONLY_IN_MEMORY)) {
    if (!memorySurface.has(name) || postgresSurface.has(name)) {
      stale.push(`ONLY_IN_MEMORY.${name}`);
    }
  }
  for (const [name, pair] of Object.entries(ARITY_EXCEPTIONS)) {
    if (memorySurface.get(name) !== pair[0] || postgresSurface.get(name) !== pair[1]) {
      stale.push(`ARITY_EXCEPTIONS.${name}`);
    }
  }

  assert.deepEqual(
    stale,
    [],
    `Whitelist entries that no longer match reality: ${stale.join(', ')}. ` +
      'The implementations have converged (or diverged differently); remove or update the entry.'
  );
});
