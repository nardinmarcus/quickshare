const test = require('node:test');
const assert = require('node:assert/strict');

// Publish-intent helpers (T08, issue #32): the pure client-side state
// machine behind the homepage's safe-retry behavior, plus the shared
// request-identifier format rules the server enforces.

const {
  draftKeyFor,
  generateRequestId,
  resolvePublishIntent
} = require('../public/js/publish-intent');
const {
  computeRequestHmac,
  namespaceTag,
  parseIdempotencyKey
} = require('../utils/idempotency');

test('generateRequestId produces UUID v4 values the server accepts', () => {
  for (let i = 0; i < 25; i += 1) {
    const id = generateRequestId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const parsed = parseIdempotencyKey(id);
    assert.equal(parsed.provided, true);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.value, id);
  }

  assert.notEqual(generateRequestId(), generateRequestId());
});

test('parseIdempotencyKey enforces the documented format boundaries', () => {
  assert.deepEqual(parseIdempotencyKey(undefined), { provided: false, valid: false, value: null });
  assert.deepEqual(parseIdempotencyKey(''), { provided: false, valid: false, value: null });
  assert.equal(parseIdempotencyKey('a'.repeat(15)).valid, false);
  assert.equal(parseIdempotencyKey('a'.repeat(16)).valid, true);
  assert.equal(parseIdempotencyKey('A0_-'.repeat(32)).valid, true, '128 chars is the upper bound');
  assert.equal(parseIdempotencyKey('a'.repeat(129)).valid, false);
  assert.equal(parseIdempotencyKey('has space........').valid, false);
  assert.equal(parseIdempotencyKey('dot.not-allowed..').valid, false);
  assert.equal(parseIdempotencyKey(' padded-value-1234 ').valid, false, 'no silent trimming: the value itself must match');
});

test('draftKeyFor is stable for the same draft and changes with any field', () => {
  const base = {
    htmlContent: '<p>hello</p>',
    codeType: 'html',
    title: 'Title',
    description: 'Desc',
    expiresAt: 1900000000000,
    isProtected: true,
    password: 'secret-1',
    markdownTheme: ''
  };

  assert.equal(draftKeyFor(base), draftKeyFor({ ...base }));
  assert.notEqual(draftKeyFor(base), draftKeyFor({ ...base, htmlContent: '<p>other</p>' }));
  assert.notEqual(draftKeyFor(base), draftKeyFor({ ...base, title: 'Other' }));
  assert.notEqual(draftKeyFor(base), draftKeyFor({ ...base, password: 'secret-2' }));
  assert.notEqual(draftKeyFor(base), draftKeyFor({ ...base, expiresAt: null }));
  assert.notEqual(draftKeyFor(base), draftKeyFor({ ...base, isProtected: false }));
});

test('resolvePublishIntent covers the four pending states', () => {
  const pending = { requestId: 'req-1', draftKey: 'draft-a', sessionTag: 'tag-a' };

  assert.deepEqual(resolvePublishIntent(null, 'draft-a', 'tag-a'), { state: 'none' });
  assert.deepEqual(resolvePublishIntent({}, 'draft-a', 'tag-a'), { state: 'none' });
  assert.deepEqual(
    resolvePublishIntent(pending, 'draft-a', 'tag-a'),
    { state: 'retry', pending }
  );
  assert.deepEqual(
    resolvePublishIntent(pending, 'draft-b', 'tag-a'),
    { state: 'rotate', pending }
  );
  // A different session is an orphan even when the draft matches: the
  // identifier belongs to another namespace and is never claimed here.
  assert.deepEqual(
    resolvePublishIntent(pending, 'draft-a', 'tag-b'),
    { state: 'orphan', pending }
  );
  assert.deepEqual(
    resolvePublishIntent(pending, 'draft-b', 'tag-b'),
    { state: 'orphan', pending }
  );
});

test('computeRequestHmac binds action, target, presence and values', () => {
  const base = {
    action: 'share.create',
    targetId: null,
    presence: { title: 1 },
    values: { htmlContent: '<p>x</p>', title: 'T' }
  };
  const digest = computeRequestHmac(base);

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(computeRequestHmac(base), digest, 'digest is deterministic');
  assert.notEqual(computeRequestHmac({ ...base, action: 'share.clone' }), digest);
  assert.notEqual(computeRequestHmac({ ...base, targetId: 'share-1' }), digest);
  assert.notEqual(
    computeRequestHmac({ ...base, presence: { title: 0 } }),
    digest,
    'flipping a presence bit must change the digest'
  );
  assert.notEqual(
    computeRequestHmac({ ...base, values: { htmlContent: '<p>x</p>', title: 'U' } }),
    digest
  );
});

test('namespaceTag is a stable short fingerprint, not the namespace itself', () => {
  const tag = namespaceTag('key:managed:abc123');
  assert.match(tag, /^[0-9a-f]{16}$/);
  assert.equal(namespaceTag('key:managed:abc123'), tag);
  assert.notEqual(namespaceTag('key:managed:other'), tag);
  assert.ok(!tag.includes('abc123'));
});
