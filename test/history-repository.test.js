// #31 owner history: bounded, metadata-only, descending revision pagination in
// the repository adapters. The list MUST NOT aggregate bodies and MUST order
// by the exact BIGINT revision value (never via Number or string order).
const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPageRepository } = require('../models/memory-pages');
const { generateId } = require('../utils/security');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue31-repo-synthetic-secret';
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];

// Keys of a metadata-only list item, in sorted order for deep comparisons.
// #34 adds the nullable purge marker purged_at to the same metadata-only shape.
const LIST_ITEM_KEYS = ['created_at', 'purged_at', 'restored_from', 'revision', 'share_id', 'source'];

async function seedRevisions(repository, count) {
  const { id } = await repository.create({
    id: generateId(),
    createdAt: Date.now(),
    htmlContent: '<h1>ISSUE31 BASE</h1>',
    codeType: 'html',
    title: 'History base',
    description: null
  });
  let current = '<h1>ISSUE31 BASE</h1>';
  for (let index = 2; index <= count; index += 1) {
    current = `<h1>ISSUE31 V${index}</h1>`;
    await repository.updatePage(id, {
      htmlContent: current,
      expectedContentRevision: String(index - 1),
      actorSource: 'dashboard-edit',
      actorIdentity: 'owner-dashboard'
    });
  }
  return id;
}

test('listContentRevisionPage returns descending metadata-only pages with exact total', async () => {
  const repository = new MemoryPageRepository();
  const id = await seedRevisions(repository, 25);

  const firstPage = await repository.listContentRevisionPage(id, { limit: 20, offset: 0 });
  assert.equal(firstPage.total, '25', 'total is the exact decimal revision count');
  assert.equal(firstPage.items.length, 20);
  assert.deepEqual(firstPage.items.map(item => item.revision),
    Array.from({ length: 20 }, (_, index) => String(25 - index)), 'descending exact revision order');
  for (const item of firstPage.items) {
    assert.deepEqual(Object.keys(item).sort(), LIST_ITEM_KEYS, 'list items carry metadata only');
    assert.ok(!('html_content' in item), 'list items never include the body');
  }
  assert.equal(firstPage.items[0].source, 'dashboard-edit');
  assert.equal(firstPage.items[0].restored_from, null, 'no restore origin exists in this milestone');

  const secondPage = await repository.listContentRevisionPage(id, { limit: 20, offset: 20 });
  assert.equal(secondPage.total, '25');
  assert.deepEqual(secondPage.items.map(item => item.revision), ['5', '4', '3', '2', '1']);

  const beyond = await repository.listContentRevisionPage(id, { limit: 20, offset: 100 });
  assert.equal(beyond.items.length, 0);
  assert.equal(beyond.total, '25');
});

test('listContentRevisionPage clamps limit into 1..100 and falls back to the 20 default', async () => {
  const repository = new MemoryPageRepository();
  const id = await seedRevisions(repository, 3);

  const oversized = await repository.listContentRevisionPage(id, { limit: 500, offset: 0 });
  assert.ok(oversized.items.length <= 100, 'limit never exceeds 100');
  const zero = await repository.listContentRevisionPage(id, { limit: 0, offset: 0 });
  assert.equal(zero.items.length, 3, 'invalid limit falls back to a bounded default');
  const negative = await repository.listContentRevisionPage(id, { limit: -5, offset: -10 });
  assert.equal(negative.items.length, 3);
  assert.equal(negative.items[0].revision, '3', 'negative offset cannot scroll below the first page');
});

test('listContentRevisionPage orders revisions above 2^53 by exact BIGINT value', async () => {
  const repository = new MemoryPageRepository();
  const { id } = await repository.create({
    id: generateId(),
    createdAt: Date.now(),
    htmlContent: '<h1>BIG</h1>', codeType: 'html'
  });
  // Adversarial pair: string descending order would rank '9007199254740993'
  // above '4611686018427387904'; the exact numeric order is the reverse.
  const revisions = repository.revisions.get(id);
  revisions.set('9007199254740993', {
    share_id: id, revision: '9007199254740993', html_content: '<h1>ABOVE 2^53</h1>', code_type: 'html',
    title: null, description: null, markdown_theme: null, created_at: 1, snapshot_hash: 'x', source: 'web', actor: null, restored_from: null
  });
  revisions.set('4611686018427387904', {
    share_id: id, revision: '4611686018427387904', html_content: '<h1>WAY ABOVE 2^53</h1>', code_type: 'html',
    title: null, description: null, markdown_theme: null, created_at: 2, snapshot_hash: 'x', source: 'web', actor: null, restored_from: null
  });

  const page = await repository.listContentRevisionPage(id, { limit: 100, offset: 0 });
  assert.deepEqual(page.items.map(item => item.revision),
    ['4611686018427387904', '9007199254740993', '1'], 'descending order uses exact big-integer comparison');
  assert.equal(page.total, '3');
});

test('getContentRevision returns one exact bounded snapshot or null', async () => {
  const repository = new MemoryPageRepository();
  const id = await seedRevisions(repository, 3);

  const snapshot = await repository.getContentRevision(id, '2');
  assert.equal(snapshot.revision, '2');
  assert.equal(snapshot.html_content, '<h1>ISSUE31 V2</h1>', 'body isolation: exactly the requested revision');
  assert.equal(snapshot.code_type, 'html');
  assert.equal(snapshot.source, 'dashboard-edit');
  assert.ok(snapshot.snapshot_hash);
  assert.ok(!('view_count' in snapshot) && !('expires_at' in snapshot) && !('is_protected' in snapshot),
    'policy fields never enter content history');

  assert.equal(await repository.getContentRevision(id, '999'), null, 'missing revision is null, not an error');
  assert.equal(await repository.getContentRevision('no-such-share', '1'), null);
  for (const invalid of ['0', '-1', 'abc', '01', '9223372036854775808', '']) {
    await assert.rejects(
      () => repository.getContentRevision(id, invalid),
      error => error.code === 'INVALID_CONTENT_REVISION',
      `invalid revision "${invalid}" is rejected before any read`
    );
  }
});

test('the legacy full-body ascending listContentRevisions stays untouched for existing callers', async () => {
  const repository = new MemoryPageRepository();
  const id = await seedRevisions(repository, 4);
  const all = await repository.listContentRevisions(id);
  assert.deepEqual(all.map(item => item.revision), ['1', '2', '3', '4']);
  assert.ok('html_content' in all[0], 'legacy caller keeps full snapshots');
});
