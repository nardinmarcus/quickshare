const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPageRepository } = require('../models/memory-pages');
const { baselineWindowError, parseArgs, runBackfill } = require('../scripts/backfill-page-revisions');

function legacyRepository() {
  const repository = new MemoryPageRepository();
  // Simulate pre-007 rows: materialized content without any snapshot.
  repository.pages.set('legacy-a', {
    id: 'legacy-a', html_content: '<h1>Legacy A</h1>', created_at: 100, password_hash: null,
    encrypted_password: null, is_protected: 0, code_type: 'html', title: 'Legacy A',
    description: 'desc-a', expires_at: null, markdown_theme: null, is_favorite: false,
    access_revision: '1', current_revision: '1', published: true, view_count: 3
  });
  repository.pages.set('legacy-b', {
    id: 'legacy-b', html_content: '<p>body b</p>', created_at: 200, password_hash: null,
    encrypted_password: null, is_protected: 0, code_type: 'markdown', title: null,
    description: null, expires_at: null, markdown_theme: 'github', is_favorite: true,
    access_revision: '2', current_revision: '1', published: true, view_count: 0
  });
  return repository;
}

test('parseArgs defaults to a read-only dry run', () => {
  assert.deepEqual(parseArgs([]), { write: false, limit: 200 });
  assert.deepEqual(parseArgs(['--write', '--limit', '5']), { write: true, limit: 5 });
  assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('dry run reports missing baselines without writing anything', async () => {
  const repository = legacyRepository();
  const result = await runBackfill(repository, { write: false, limit: 10 });
  assert.equal(result.backfilled, 2);
  assert.equal((await repository.listContentRevisions('legacy-a')).length, 0, 'dry run must not write snapshots');
  assert.match(result.output.join('\n'), /dry-run legacy-a: would backfill Revision 1/);
  assert.match(result.output.join('\n'), /would backfill 2 of 2 scanned Shares/);
});

test('write refuses to run without a live paused maintenance window', async () => {
  const repository = legacyRepository();
  await assert.rejects(runBackfill(repository, { write: true, limit: 10 }), error => {
    assert.equal(error.code, 'BASELINE_WINDOW_REQUIRED');
    assert.match(error.message, /write-maintenance window/);
    return true;
  });
  assert.equal((await repository.listContentRevisions('legacy-a')).length, 0);
});

test('write inside a paused window backfills Revision 1 exactly once', async () => {
  const repository = legacyRepository();
  await repository.setPublishingWritesPaused(true);
  const beforeMs = Date.now();
  const first = await runBackfill(repository, { write: true, limit: 10 });
  assert.equal(first.backfilled, 2);
  assert.equal((await repository.listContentRevisions('legacy-a')).length, 1);

  const baseline = (await repository.listContentRevisions('legacy-a')).find(rev => rev.revision === '1');
  assert.equal(baseline.html_content, '<h1>Legacy A</h1>');
  assert.equal(baseline.title, 'Legacy A');
  assert.equal(baseline.description, 'desc-a');
  // The baseline stamps the ACTUAL capture moment, not the Share's creation
  // time; pages.created_at keeps its original value untouched.
  assert.ok(Number(baseline.created_at) >= beforeMs, `baseline created_at must be the backfill moment, got ${baseline.created_at}`);
  assert.equal((await repository.getById('legacy-a')).created_at, 100, 'pages.created_at keeps its original value');
  // Row-level provenance for the dedicated baseline write path.
  assert.equal(baseline.source, 'baseline-backfill');
  assert.equal(baseline.actor, 'maintenance:baseline-backfill');
  assert.equal(baseline.restored_from, null);
  const baselineB = (await repository.listContentRevisions('legacy-b')).find(rev => rev.revision === '1');
  assert.equal(baselineB.code_type, 'markdown');
  assert.equal(baselineB.markdown_theme, 'github');
  const pageA = await repository.getById('legacy-a');
  assert.equal(pageA.current_revision, '1', 'backfill never advances the current pointer');
  assert.equal(pageA.html_content, '<h1>Legacy A</h1>', 'backfill never rewrites the body');
  assert.equal(pageA.view_count, 3, 'backfill never touches policy or counters');
  const audits = await repository.listAuditLogs({ limit: 10 });
  assert.ok(audits.some(log => log.action === 'page.revision.backfill' && log.pageId === 'legacy-a'));

  const second = await runBackfill(repository, { write: true, limit: 10 });
  assert.equal(second.scanned, 0, 'repeat run finds nothing to do');
  assert.match(second.output.join('\n'), /no Shares are missing Revision 1/);
  assert.equal((await repository.listContentRevisions('legacy-b')).length, 1, 'repeat run never duplicates');
});

test('write never guesses history for Shares with a moved revision pointer', async () => {
  const repository = legacyRepository();
  repository.pages.get('legacy-a').current_revision = '7';
  await repository.setPublishingWritesPaused(true);
  await assert.rejects(runBackfill(repository, { write: true, limit: 10 }), error => {
    assert.equal(error.code, 'BASELINE_INCONSISTENT');
    assert.match(error.message, /legacy-a/);
    assert.match(error.message, /current_revision=7/);
    return true;
  });
  assert.equal((await repository.listContentRevisions('legacy-a')).length, 0);
  assert.equal((await repository.listContentRevisions('legacy-b')).length, 0, 'all-or-nothing: no partial baseline commit');
});

test('window error is explicit about the operator obligations', () => {
  const error = baselineWindowError();
  assert.equal(error.code, 'BASELINE_WINDOW_REQUIRED');
  assert.match(error.message, /pause first/);
  assert.match(error.message, /old writers are drained/);
});
