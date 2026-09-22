const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue32-oprepo-secret-0123456789abcdef';

const { createPageRepository } = require('../models/pageRepository');

const repository = createPageRepository();

const OP = (overrides = {}) => ({
  actor_namespace: 'publish-session:testsession01',
  request_id: 'req-0123456789abcd',
  action: 'create',
  request_digest: 'd'.repeat(64),
  target_id: null,
  result_share_id: 'share000001',
  result_revision: '1',
  result_access_revision: '1',
  receipt_encrypted: null,
  deleted_at: null,
  ...overrides
});

test('operation records commit with the publishing transaction and are found again', async () => {
  await repository.withPublishingTransaction(async (transaction) => {
    await transaction.create({
      id: 'share000001', htmlContent: '<p>op</p>', createdAt: 1,
      passwordHash: null, encryptedPassword: null, isProtected: false,
      codeType: 'html', title: null, description: null, expiresAt: null, markdownTheme: null
    });
    await transaction.createPublishingOperation(OP());
  });

  const found = await repository.findPublishingOperation('publish-session:testsession01', 'req-0123456789abcd');
  assert.ok(found, 'the committed operation record must be readable');
  assert.equal(found.action, 'create');
  assert.equal(found.result_share_id, 'share000001');
  assert.equal(found.deleted_at, null);
});

test('a failure after the operation write rolls back share, revision and operation together', async () => {
  await assert.rejects(
    repository.withPublishingTransaction(async (transaction) => {
      await transaction.create({
        id: 'share000002', htmlContent: '<p>half</p>', createdAt: 2,
        passwordHash: null, encryptedPassword: null, isProtected: false,
        codeType: 'html', title: null, description: null, expiresAt: null, markdownTheme: null
      });
      await transaction.createPublishingOperation(OP({ request_id: 'req-rollback00001', result_share_id: 'share000002' }));
      throw new Error('injected failure after operation write');
    }),
    /injected failure/
  );

  assert.equal(await repository.getById('share000002'), null, 'no half-committed share may survive');
  const op = await repository.findPublishingOperation('publish-session:testsession01', 'req-rollback00001');
  assert.equal(op, null, 'no half-committed operation record may survive');
});

test('the unique constraint is the final guard against duplicate operation records', async () => {
  await repository.withPublishingTransaction(async (transaction) => {
    await transaction.createPublishingOperation(OP({ request_id: 'req-uniqueguard01' }));
    await assert.rejects(
      () => transaction.createPublishingOperation(OP({ request_id: 'req-uniqueguard01' })),
      (error) => String(error.code).includes('23505') || /exist|duplicate|unique/i.test(error.message)
    );
  });
});

test('deleting a share clears its receipts in the same transaction and keeps a tombstone', async () => {
  await repository.withPublishingTransaction(async (transaction) => {
    await transaction.create({
      id: 'share000003', htmlContent: '<p>doomed</p>', createdAt: 3,
      passwordHash: null, encryptedPassword: null, isProtected: false,
      codeType: 'html', title: null, description: null, expiresAt: null, markdownTheme: null
    });
    await transaction.createPublishingOperation(OP({
      request_id: 'req-tombstone0001',
      result_share_id: 'share000003',
      receipt_encrypted: 'secret-v1$a$b$c'
    }));
  });

  await repository.withPublishingTransaction(async (transaction) => {
    await transaction.deletePage('share000003');
    await transaction.clearPublishingOperationsForShares(['share000003']);
  });

  const tombstone = await repository.findPublishingOperation('publish-session:testsession01', 'req-tombstone0001');
  assert.ok(tombstone, 'the dedupe tombstone must survive the delete');
  assert.equal(tombstone.receipt_encrypted, null, 'sensitive receipt payload must be cleared');
  assert.ok(tombstone.deleted_at !== null && tombstone.deleted_at !== undefined, 'the tombstone records deletion time');
  assert.equal(tombstone.result_share_id, 'share000003', 'non-content identifiers stay for owner review');
});

test('clearing operations for shares is idempotent and skips untouched rows', async () => {
  await repository.withPublishingTransaction(async (transaction) => {
    await transaction.clearPublishingOperationsForShares(['share000003']);
    await transaction.clearPublishingOperationsForShares([]);
  });
  const tombstone = await repository.findPublishingOperation('publish-session:testsession01', 'req-tombstone0001');
  assert.ok(tombstone.deleted_at, 'a second clear keeps the tombstone state');
});

test('operation lookup by share covers batch deletion paths', async () => {
  await repository.withPublishingTransaction(async (transaction) => {
    for (const id of ['share000010', 'share000011']) {
      await transaction.create({
        id, htmlContent: `<p>${id}</p>`, createdAt: 4,
        passwordHash: null, encryptedPassword: null, isProtected: false,
        codeType: 'html', title: null, description: null, expiresAt: null, markdownTheme: null
      });
    }
    await transaction.createPublishingOperation(OP({ request_id: 'req-batch0000001', result_share_id: 'share000010' }));
    await transaction.createPublishingOperation(OP({ request_id: 'req-batch0000002', result_share_id: 'share000011' }));
    await transaction.deletePages(['share000011', 'share000010']);
    await transaction.clearPublishingOperationsForShares(['share000011', 'share000010']);
  });

  for (const requestId of ['req-batch0000001', 'req-batch0000002']) {
    const tombstone = await repository.findPublishingOperation('publish-session:testsession01', requestId);
    assert.ok(tombstone, `${requestId} keeps a tombstone`);
    assert.ok(tombstone.deleted_at, `${requestId} is marked deleted`);
    assert.equal(tombstone.receipt_encrypted, null);
  }
});
