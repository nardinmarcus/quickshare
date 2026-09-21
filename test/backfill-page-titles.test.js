const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPageRepository } = require('../models/memory-pages');
const { parseArgs, runTitleBackfill } = require('../scripts/backfill-page-titles');

async function seedRepository() {
  const repository = new MemoryPageRepository();
  await repository.create({ id: 'titleless', htmlContent: '<h1>Derived Title 30</h1>', createdAt: 1 });
  repository.pages.get('titleless').title = null;
  await repository.create({ id: 'titled', htmlContent: '<h1>Kept</h1>', title: 'Kept', createdAt: 2 });
  return repository;
}

test('parseArgs keeps the historical flags', () => {
  assert.deepEqual(parseArgs([]), { write: false, limit: 200 });
  assert.deepEqual(parseArgs(['--write', '--limit', '3']), { write: true, limit: 3 });
  assert.throws(() => parseArgs(['--limit', '-1']), /positive integer/);
});

test('dry run stays read-only', async () => {
  const repository = await seedRepository();
  const result = await runTitleBackfill(repository, { write: false, limit: 10 });
  assert.match(result.output.join('\n'), /dry-run titleless: Derived Title 30/);
  assert.match(result.output.join('\n'), /would update 1 of 1 scanned pages/);
  const page = await repository.getById('titleless');
  assert.equal(page.title, null);
  assert.equal(page.current_revision, '1', 'dry run never creates revisions');
});

test('write goes through the content protocol and snapshots the new title', async () => {
  const repository = await seedRepository();
  const result = await runTitleBackfill(repository, { write: true, limit: 10 });
  assert.match(result.output.join('\n'), /update titleless: Derived Title 30/);
  assert.match(result.output.join('\n'), /updated 1 of 1 scanned pages/);

  const page = await repository.getById('titleless');
  assert.equal(page.title, 'Derived Title 30');
  assert.equal(page.current_revision, '2', 'title backfill must never bypass revisions');

  const revisions = await repository.listContentRevisions('titleless');
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].title, null, 'Revision 1 keeps the original state');
  assert.equal(revisions[0].source, 'web', 'the repository fixture default labels its own creation');
  assert.equal(revisions[1].title, 'Derived Title 30');
  assert.equal(revisions[1].html_content, '<h1>Derived Title 30</h1>', 'snapshot carries the unchanged body');
  // The title backfill is its own real write path with a maintenance actor.
  assert.equal(revisions[1].source, 'title-backfill');
  assert.equal(revisions[1].actor, 'maintenance:title-backfill');
  assert.equal(revisions[1].restored_from, null);
});

test('write still refuses while the maintenance window is paused', async () => {
  const repository = await seedRepository();
  await repository.setPublishingWritesPaused(true);
  await assert.rejects(runTitleBackfill(repository, { write: true, limit: 10 }), { code: 'PUBLISHING_MAINTENANCE' });
  assert.equal((await repository.getById('titleless')).title, null);
});

test('pages already carrying their derived title are skipped without new revisions', async () => {
  const repository = await seedRepository();
  await runTitleBackfill(repository, { write: true, limit: 10 });
  const before = await repository.listContentRevisions('titleless');
  const again = await runTitleBackfill(repository, { write: true, limit: 10 });
  assert.equal(again.changed, 0);
  const after = await repository.listContentRevisions('titleless');
  assert.equal(after.length, before.length, 'no-op backfill must not bump revisions');
});
