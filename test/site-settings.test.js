const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPageRepository } = require('../models/memory-pages');

test('new repositories require the homepage password by default', async () => {
  const repository = new MemoryPageRepository();

  assert.equal(await repository.getHomepagePasswordRequired(), true);
});

test('changing homepage access persists the new state and records the transition', async () => {
  const repository = new MemoryPageRepository();

  const result = await repository.setHomepagePasswordRequired({
    passwordRequired: false,
    ip: '203.0.113.9'
  });

  assert.deepEqual(result, {
    passwordRequired: false,
    changed: true
  });
  assert.equal(await repository.getHomepagePasswordRequired(), false);

  const logs = await repository.listAuditLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'settings.homepage_password_required.update');
  assert.deepEqual(JSON.parse(logs[0].details), { from: true, to: false });
  assert.equal(logs[0].ip, '203.0.113.9');
});

test('submitting the current homepage access state is idempotent', async () => {
  const repository = new MemoryPageRepository();

  const result = await repository.setHomepagePasswordRequired({
    passwordRequired: true,
    ip: '203.0.113.10'
  });

  assert.deepEqual(result, {
    passwordRequired: true,
    changed: false
  });
  assert.deepEqual(await repository.listAuditLogs(), []);
});

test('an audit failure leaves the homepage access state unchanged', async () => {
  class AuditFailureRepository extends MemoryPageRepository {
    async createAuditLog() {
      throw new Error('audit unavailable');
    }
  }

  const repository = new AuditFailureRepository();

  await assert.rejects(
    repository.setHomepagePasswordRequired({
      passwordRequired: false,
      ip: '203.0.113.11'
    }),
    /audit unavailable/
  );
  assert.equal(await repository.getHomepagePasswordRequired(), true);
});

test('homepage access updates reject non-boolean values', async () => {
  const repository = new MemoryPageRepository();

  await assert.rejects(
    repository.setHomepagePasswordRequired({
      passwordRequired: 'false',
      ip: '203.0.113.12'
    }),
    /must be a boolean/
  );
  assert.equal(await repository.getHomepagePasswordRequired(), true);
  assert.deepEqual(await repository.listAuditLogs(), []);
});

test('an invalid stored homepage access value fails closed', async () => {
  const repository = new MemoryPageRepository();
  repository.homepagePasswordRequired = null;

  await assert.rejects(
    repository.getHomepagePasswordRequired(),
    /setting is unavailable/
  );
  await assert.rejects(
    repository.setHomepagePasswordRequired({
      passwordRequired: false,
      ip: '203.0.113.13'
    }),
    /setting is unavailable/
  );
});
