const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isvalidRequestId,
  INVALID_REQUEST_ID_MESSAGE,
  operationRequestDigest,
  resolveApiCredentialNamespace,
  resolveBrowserPublishNamespace,
  namespaceKind,
  encodeOperationReceipt,
  decodeOperationReceipt
} = require('../utils/publishingOperation');
const { encryptSecret, decryptSecret } = require('../utils/security');

test('request ids accept 16-128 ASCII letters, digits, hyphens and underscores', () => {
  assert.equal(isvalidRequestId('a'.repeat(16)), true);
  assert.equal(isvalidRequestId('Z9_-'.repeat(5)), true);
  assert.equal(isvalidRequestId('k'.repeat(128)), true);
  assert.equal(isvalidRequestId('0123456789abcdef'), true);
});

test('request ids reject short, long, empty and non-conforming values', () => {
  assert.equal(isvalidRequestId(undefined), false);
  assert.equal(isvalidRequestId(null), false);
  assert.equal(isvalidRequestId(''), false);
  assert.equal(isvalidRequestId('a'.repeat(15)), false);
  assert.equal(isvalidRequestId('a'.repeat(129)), false);
  assert.equal(isvalidRequestId('has space-0123456'), false);
  assert.equal(isvalidRequestId('valid-but-then-✨'), false);
  assert.equal(isvalidRequestId('0123456789abcde\n'), false);
  assert.equal(isvalidRequestId(1234567890123456), false);
});

test(INVALID_REQUEST_ID_MESSAGE + ' is a stable user-facing string', () => {
  assert.equal(typeof INVALID_REQUEST_ID_MESSAGE, 'string');
  assert.ok(INVALID_REQUEST_ID_MESSAGE.length > 0);
});

test('operation digest is deterministic for identical normalized inputs', () => {
  const base = {
    action: 'create',
    targetId: null,
    fields: {
      htmlContent: '<h1>Hello</h1>',
      codeType: 'html',
      title: 'Hello',
      description: null,
      expiresAt: null,
      isProtected: false,
      password: null,
      markdownTheme: null
    },
    presence: {
      htmlContent: true,
      codeType: true,
      title: true,
      description: false,
      expiresAt: false,
      isProtected: false,
      password: false,
      markdownTheme: false
    }
  };
  assert.equal(operationRequestDigest(base), operationRequestDigest({ ...base, fields: { ...base.fields } }));
});

// #24 L211: the HMAC covers field PRESENCE as well as normalized values.
// Absent and explicit-null normalize to the same value but are different
// literal requests and must produce different digests.
test('operation digest distinguishes field presence from explicit null', () => {
  const fields = {
    htmlContent: '<h1>Hi</h1>', codeType: 'html', title: null, description: null,
    expiresAt: null, isProtected: false, password: null, markdownTheme: null
  };
  const presenceAbsent = {
    htmlContent: true, codeType: false, title: false, description: false,
    expiresAt: false, isProtected: false, password: false, markdownTheme: false
  };
  const presenceExplicitNull = { ...presenceAbsent, description: true, title: true, codeType: true };

  assert.notEqual(
    operationRequestDigest({ action: 'create', targetId: null, fields, presence: presenceAbsent }),
    operationRequestDigest({ action: 'create', targetId: null, fields, presence: presenceExplicitNull }),
    'absent-vs-explicit-null business fields must not collapse in the digest'
  );
});

test('operation digest changes when any meaningful input changes', () => {
  const base = {
    action: 'create',
    targetId: null,
    fields: {
      htmlContent: '<h1>Hello</h1>',
      codeType: 'html',
      title: 'Hello',
      description: null,
      expiresAt: 12345,
      isProtected: false,
      password: null,
      markdownTheme: null
    }
  };
  const variants = [
    { fields: { ...base.fields, htmlContent: '<h1>Changed</h1>' } },
    { fields: { ...base.fields, title: 'Different' } },
    { fields: { ...base.fields, title: null } },
    { fields: { ...base.fields, description: 'now present' } },
    { fields: { ...base.fields, expiresAt: 12346 } },
    { fields: { ...base.fields, expiresAt: null } },
    { fields: { ...base.fields, isProtected: true } },
    { fields: { ...base.fields, password: 'secret1' } },
    { fields: { ...base.fields, codeType: 'markdown' } },
    { fields: { ...base.fields, markdownTheme: 'github' } },
    { action: 'clone' },
    { targetId: 'share123' }
  ];

  for (const variant of variants) {
    assert.notEqual(
      operationRequestDigest(base),
      operationRequestDigest({ ...base, ...variant }),
      `digest must differ for variant ${JSON.stringify(variant)}`
    );
  }
});

test('operation digest distinguishes custom password values but omits auto-generation', () => {
  const base = {
    action: 'create',
    targetId: null,
    fields: {
      htmlContent: '<h1>Hi</h1>', codeType: 'html', title: null, description: null,
      expiresAt: null, isProtected: true, password: null, markdownTheme: null
    }
  };
  const auto = operationRequestDigest(base);
  const customA = operationRequestDigest({ ...base, fields: { ...base.fields, password: 'abcd1234' } });
  const customB = operationRequestDigest({ ...base, fields: { ...base.fields, password: 'wxyz9876' } });

  assert.notEqual(auto, customA, 'auto-generated intent differs from a custom password intent');
  assert.notEqual(customA, customB, 'different custom passwords are different inputs');
});

test('operation digest is an HMAC, not a plaintext-derived hash of the body', () => {
  const digest = operationRequestDigest({
    action: 'create',
    targetId: null,
    fields: {
      htmlContent: 'SECRETBODY', codeType: 'html', title: null, description: null,
      expiresAt: null, isProtected: false, password: null, markdownTheme: null
    }
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes('SECRETBODY'));
  // Two app secrets must yield different digests: the digest is keyed.
  process.env.SESSION_SECRET = 'issue32-digest-key-A-0123456789abcdef';
  delete require.cache[require.resolve('../utils/publishingOperation')];
  const keyedA = require('../utils/publishingOperation').operationRequestDigest({
    action: 'create', targetId: null,
    fields: { htmlContent: 'x', codeType: 'html', title: null, description: null, expiresAt: null, isProtected: false, password: null, markdownTheme: null }
  });
  process.env.SESSION_SECRET = 'issue32-digest-key-B-0123456789abcdef';
  delete require.cache[require.resolve('../utils/publishingOperation')];
  const keyedB = require('../utils/publishingOperation').operationRequestDigest({
    action: 'create', targetId: null,
    fields: { htmlContent: 'x', codeType: 'html', title: null, description: null, expiresAt: null, isProtected: false, password: null, markdownTheme: null }
  });
  assert.notEqual(keyedA, keyedB, 'digests are keyed by the application secret');
  process.env.SESSION_SECRET = 'issue32-unit-secret-0123456789abcdef';
  delete require.cache[require.resolve('../utils/publishingOperation')];
});

test('managed keys namespace by stable logical id across secret rotation', () => {
  const identity = { credentialKind: 'managed', id: 'key123', name: 'n', credentialVersion: '1' };
  const rotated = { credentialKind: 'managed', id: 'key123', name: 'n', credentialVersion: '2' };
  assert.equal(resolveApiCredentialNamespace(identity), resolveApiCredentialNamespace(rotated));
  assert.equal(resolveApiCredentialNamespace(identity), 'managed-key:key123');
  assert.notEqual(
    resolveApiCredentialNamespace({ credentialKind: 'managed', id: 'other', name: 'n', credentialVersion: '1' }),
    resolveApiCredentialNamespace(identity)
  );
});

test('legacy keys namespace by an irreversible fingerprint of the secret', () => {
  const nsA = resolveApiCredentialNamespace({ credentialKind: 'legacy', legacySecret: 'legacy-secret-one' });
  const nsAagain = resolveApiCredentialNamespace({ credentialKind: 'legacy', legacySecret: 'legacy-secret-one' });
  const nsB = resolveApiCredentialNamespace({ credentialKind: 'legacy', legacySecret: 'legacy-secret-two' });

  assert.equal(nsA, nsAagain, 'same legacy secret keeps the same namespace');
  assert.notEqual(nsA, nsB, 'a rotated legacy secret lands in a fresh namespace');
  assert.match(nsA, /^legacy-key:[0-9a-f]{64}$/);
  assert.ok(!nsA.includes('legacy-secret-one'), 'fingerprint must be irreversible');
});

test('browser publish sessions namespace by session id', () => {
  assert.equal(resolveBrowserPublishNamespace('sess-abc123'), 'publish-session:sess-abc123');
  assert.notEqual(resolveBrowserPublishNamespace('sess-abc123'), resolveBrowserPublishNamespace('sess-other4'));
});

test('namespace kinds are exposed for owner review without leaking identities', () => {
  assert.equal(namespaceKind('managed-key:k1'), 'managed-key');
  assert.equal(namespaceKind('legacy-key:' + 'a'.repeat(64)), 'legacy-key');
  assert.equal(namespaceKind('publish-session:s1'), 'publish-session');
  assert.equal(namespaceKind('dashboard-session:fp'), 'dashboard-session');
});

test('operation receipts encrypt sensitive payload and decode losslessly', () => {
  const receipt = {
    password: '123456',
    isProtected: true,
    codeType: 'html',
    title: 'T',
    description: null,
    expiresAt: null,
    markdownTheme: null
  };
  const encoded = encodeOperationReceipt(receipt);

  assert.ok(encoded, 'a receipt must be produced');
  assert.ok(encoded.startsWith('secret-v1$'), 'receipts use the existing secret encryption');
  assert.ok(!encoded.includes('123456'), 'the raw password never appears in the stored receipt');
  assert.deepEqual(decodeOperationReceipt(encoded), receipt);
});

test('decoding absent or corrupt receipts returns null without throwing', () => {
  assert.equal(decodeOperationReceipt(null), null);
  assert.equal(decodeOperationReceipt('garbage'), null);
  assert.equal(decodeOperationReceipt(encryptSecret('plain') + 'tampered'), null);
});

test('dashboard update static validation rejects coercion objects and policy fields before normalization', () => {
  const { validateDashboardUpdateInput } = require('../models/publishingOperations');
  assert.equal(typeof validateDashboardUpdateInput, 'function');
  for (const field of ['title', 'description', 'htmlContent', 'markdownTheme', 'codeType', 'expiresAt', 'isProtected', 'password', 'expectedAccessRevision', 'revokeAccess']) {
    for (const value of [{ toString: null }, [], {}]) {
      const result = validateDashboardUpdateInput({ [field]: value });
      assert.ok(result.error, `${field} must reject non-scalar input without coercion`);
    }
  }
  for (const body of [null, [], 'body', 42]) assert.ok(validateDashboardUpdateInput(body).error);
  for (const body of [
    { title: null, description: '', htmlContent: '  body\r\n  ', markdownTheme: null, codeType: 'html' },
    { isProtected: false, expiresAt: null, expectedAccessRevision: '1' },
    { expiresAt: '1799999999000', password: 'valid-pass', expectedAccessRevision: '9007199254740993' }
  ]) {
    const original = JSON.stringify(body);
    assert.equal(validateDashboardUpdateInput(body).error, null);
    assert.equal(JSON.stringify(body), original, 'static validation must not rewrite the submitted payload');
  }
  for (const fields of [{ revokeAccess: false }, { password: null }, { expectedAccessRevision: '1' }, { published: false }]) {
    assert.equal(validateDashboardUpdateInput({ title: 'saved', ...fields }, { idempotent: true }).code, 'UNSUPPORTED_REQUEST_ID_SCOPE');
  }
});

// ---- #33 dashboard content-update / restore digests ----

const CONTENT_UPDATE_BASE = {
  action: 'content-update',
  targetId: 'share33a',
  fields: {
    expectedRevision: '3',
    htmlContent: '<h1>V-next</h1>',
    title: 'T',
    description: null,
    markdownTheme: null
  },
  presence: { htmlContent: true, title: true, description: false, markdownTheme: false }
};

const RESTORE_BASE = {
  action: 'restore',
  targetId: 'share33a',
  fields: { expectedRevision: '3', sourceRevision: '2' }
};

test('content-update digest is deterministic and covers the expected revision', () => {
  assert.equal(operationRequestDigest(CONTENT_UPDATE_BASE), operationRequestDigest({ ...CONTENT_UPDATE_BASE }));

  // #24 §8: the digest covers the EXPECTED REVISION. The same payload against
  // a different baseline is a different literal request, never a replay.
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest({ ...CONTENT_UPDATE_BASE, fields: { ...CONTENT_UPDATE_BASE.fields, expectedRevision: '4' } }),
    'same payload with a moved expected revision must not collide'
  );
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest({ ...CONTENT_UPDATE_BASE, fields: { ...CONTENT_UPDATE_BASE.fields, htmlContent: '<h1>Other</h1>' } })
  );
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest({ ...CONTENT_UPDATE_BASE, targetId: 'share33b' }),
    'the target share is part of the digest'
  );
});

test('content-update digest distinguishes field presence and from the create action', () => {
  const explicitNull = {
    ...CONTENT_UPDATE_BASE,
    presence: { htmlContent: true, title: true, description: true, markdownTheme: false }
  };
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest(explicitNull),
    'absent vs explicit-null metadata fields are different literal requests'
  );
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest({ ...CONTENT_UPDATE_BASE, action: 'create' }),
    'content-update never collides with create digests'
  );
  assert.notEqual(
    operationRequestDigest(CONTENT_UPDATE_BASE),
    operationRequestDigest({ ...CONTENT_UPDATE_BASE, action: 'restore' }),
    'actions never share digest space'
  );
});

test('restore digest covers the target, expected revision and exact source revision', () => {
  assert.equal(operationRequestDigest(RESTORE_BASE), operationRequestDigest({ ...RESTORE_BASE }));
  assert.notEqual(
    operationRequestDigest(RESTORE_BASE),
    operationRequestDigest({ ...RESTORE_BASE, fields: { ...RESTORE_BASE.fields, sourceRevision: '1' } }),
    'a different source revision is a different restore request'
  );
  assert.notEqual(
    operationRequestDigest(RESTORE_BASE),
    operationRequestDigest({ ...RESTORE_BASE, fields: { ...RESTORE_BASE.fields, expectedRevision: '9' } }),
    'the expected current revision is part of the restore digest'
  );
  assert.notEqual(
    operationRequestDigest(RESTORE_BASE),
    operationRequestDigest({ ...RESTORE_BASE, targetId: 'share33b' })
  );
});

// ---- #35 publish-state operations: digest input and state-transition replay ----

const {
  normalizePublishStateDigestInput,
  classifyOperationReplay
} = require('../models/publishingOperations');

const UNPUBLISH_DIGEST_BASE = {
  action: 'unpublish',
  targetId: 'share35a',
  fields: normalizePublishStateDigestInput({ expectedAccessRevision: '7' }).fields
};

test('publish-state digest covers the exact expected access revision', () => {
  assert.equal(UNPUBLISH_DIGEST_BASE.fields.expectedAccessRevision, '7');
  assert.equal(
    operationRequestDigest(UNPUBLISH_DIGEST_BASE),
    operationRequestDigest({ ...UNPUBLISH_DIGEST_BASE })
  );
  assert.notEqual(
    operationRequestDigest(UNPUBLISH_DIGEST_BASE),
    operationRequestDigest({ ...UNPUBLISH_DIGEST_BASE, fields: { expectedAccessRevision: '8' } }),
    'a different access baseline is a different publish-state request'
  );
  assert.notEqual(
    operationRequestDigest(UNPUBLISH_DIGEST_BASE),
    operationRequestDigest({ ...UNPUBLISH_DIGEST_BASE, action: 'republish' }),
    'unpublish and republish never share digest space'
  );
  assert.notEqual(
    operationRequestDigest(UNPUBLISH_DIGEST_BASE),
    operationRequestDigest({ ...UNPUBLISH_DIGEST_BASE, targetId: 'share35b' })
  );
});

function replayRepositoryStub(page) {
  return {
    async getById() { return page || null; },
    async getContentRevision() {
      // Simulates a purged/absent snapshot payload: publish-state results are
      // state transitions, not content, so replay must not depend on this.
      return null;
    }
  };
}

function publishStateRecord(overrides = {}) {
  return {
    action: 'unpublish',
    request_digest: operationRequestDigest(UNPUBLISH_DIGEST_BASE),
    deleted_at: null,
    result_share_id: 'share35a',
    result_revision: '3',
    result_access_revision: '8',
    receipt_encrypted: encodeOperationReceipt({ changed: true, published: false }),
    ...overrides
  };
}

test('a publish-state replay confirms from the record and receipt without needing the snapshot', async () => {
  const page = { id: 'share35a', access_revision: '9', is_protected: 0 };
  const outcome = await classifyOperationReplay(replayRepositoryStub(page), {
    record: publishStateRecord(),
    requestDigest: operationRequestDigest(UNPUBLISH_DIGEST_BASE)
  });
  assert.equal(outcome.kind, 'replay');
  assert.equal(outcome.publishState, true);
  assert.equal(outcome.receipt.changed, true);
  assert.equal(outcome.receipt.published, false);
  assert.equal(outcome.accessUnchanged, false, 'the share moved on; the replay still confirms the commit');
});

test('publish-state replays keep the conflict and result-unavailable boundaries', async () => {
  const page = { id: 'share35a', access_revision: '8', is_protected: 0 };
  const conflict = await classifyOperationReplay(replayRepositoryStub(page), {
    record: publishStateRecord(),
    requestDigest: 'different-digest'
  });
  assert.equal(conflict.kind, 'conflict');

  const deleted = await classifyOperationReplay(replayRepositoryStub(page), {
    record: publishStateRecord({ deleted_at: Date.now() }),
    requestDigest: operationRequestDigest(UNPUBLISH_DIGEST_BASE)
  });
  assert.equal(deleted.kind, 'result-unavailable');

  const missingShare = await classifyOperationReplay(replayRepositoryStub(null), {
    record: publishStateRecord(),
    requestDigest: operationRequestDigest(UNPUBLISH_DIGEST_BASE)
  });
  assert.equal(missingShare.kind, 'result-unavailable');

  const unreadableReceipt = await classifyOperationReplay(replayRepositoryStub(page), {
    record: publishStateRecord({ receipt_encrypted: 'not-a-valid-receipt' }),
    requestDigest: operationRequestDigest(UNPUBLISH_DIGEST_BASE)
  });
  assert.equal(unreadableReceipt.kind, 'result-unavailable');
});
