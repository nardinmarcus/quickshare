const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runBaselineBackfill } = require('../../scripts/revision-baseline-lib');
const { computeSnapshotHash } = require('../../utils/contentRevision');
const { hashSecret } = require('../../utils/security');

// Content Revisions against real Postgres (T06, issue #30). The core
// guarantees — one winner in a same-revision race, all-or-nothing commits
// across projection + snapshot + audit, and a baseline backfill that only
// runs inside a drained write-maintenance window — rest on transaction
// row locks and the publishing gate, so they are proven here with two
// independent repositories (separate pools, separate connections), never
// with two queries multiplexed over one client.
//
// This file uses its own `quickshare_revisions_test` database, created
// and dropped by the file itself.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.slice(1);
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

const REVISIONS_DB = 'quickshare_revisions_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const revisionsUrl = serverBaseUrl(REVISIONS_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

let adminPool;
let repoA;
let repoB;

async function resetState() {
  await repoA.pool.query('DELETE FROM public.pages');
  await repoA.pool.query('DELETE FROM public.audit_logs');
  await repoA.pool.query('DELETE FROM public.api_keys');
  await repoA.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

function pageFixture(id, overrides = {}) {
  return {
    id,
    htmlContent: `<h1>${id} body</h1>`,
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: `${id} title`,
    description: null,
    expiresAt: null,
    markdownTheme: null,
    ...overrides
  };
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${REVISIONS_DB}`);
  await adminPool.query(`CREATE DATABASE ${REVISIONS_DB}`);

  repoA = new PostgresPageRepository(revisionsUrl, env);
  repoB = new PostgresPageRepository(revisionsUrl, env);
  await runMigrations(repoA.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repoA.pool.end();
  await repoB.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${REVISIONS_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('migration 007 expands pages and creates share_revisions; re-running migrations is a no-op', async () => {
  const columns = await repoA.pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pages'
      AND column_name IN ('current_revision', 'published')
    ORDER BY column_name
  `);
  assert.equal(columns.rows.length, 2);
  const byName = Object.fromEntries(columns.rows.map(row => [row.column_name, row]));
  assert.equal(byName.current_revision.data_type, 'bigint');
  assert.equal(byName.current_revision.is_nullable, 'YES');
  assert.equal(byName.published.data_type, 'boolean');

  const table = await repoA.pool.query("SELECT to_regclass('public.share_revisions') AS t");
  assert.ok(table.rows[0].t);

  const again = await runMigrations(repoA.pool, { logger: { info() {} } });
  assert.deepEqual(again.applied, []);
  assert.ok(again.skipped.includes('007'));
});

test('create writes the Revision 1 baseline in the same transaction', async () => {
  await repoA.create(pageFixture('pg-create'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });

  const page = await repoA.getById('pg-create');
  assert.equal(page.current_revision, '1');
  assert.equal(page.published, true);

  const snapshot = await repoA.getContentSnapshot('pg-create', '1');
  assert.ok(snapshot);
  assert.equal(snapshot.html_content, '<h1>pg-create body</h1>');
  assert.equal(snapshot.title, 'pg-create title');
  assert.equal(snapshot.source, 'web-create');
  assert.equal(snapshot.actor_type, 'owner');
  assert.equal(
    snapshot.snapshot_hash,
    computeSnapshotHash('pg-create', '1', {
      htmlContent: '<h1>pg-create body</h1>',
      codeType: 'html',
      title: 'pg-create title',
      description: null,
      markdownTheme: null
    })
  );
});

test('two connections racing on the same expected revision: exactly one wins', async () => {
  await repoA.create(pageFixture('pg-race'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });

  const [resultA, resultB] = await Promise.all([
    repoA.updatePageWithPreconditions('pg-race', { title: 'Winner A' }, {
      expectedContentRevision: '1',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: '127.0.0.1'
    }),
    repoB.updatePageWithPreconditions('pg-race', { title: 'Winner B' }, {
      expectedContentRevision: '1',
      contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
      ip: '127.0.0.1'
    })
  ]);

  const outcomes = [resultA, resultB].map(result => result.status).sort();
  assert.deepEqual(outcomes, ['content_conflict', 'updated']);

  const page = await repoA.getById('pg-race');
  assert.equal(page.current_revision, '2');
  assert.ok(['Winner A', 'Winner B'].includes(page.title));

  const snapshots = await repoA.listContentSnapshots('pg-race');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].revision, '2');
  assert.equal(snapshots[1].title, page.title);

  // Exactly one content-update audit entry was committed (the winner's).
  const audits = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE page_id = 'pg-race' AND action = 'page.content.update'"
  );
  assert.equal(audits.rows[0].count, 1);
});

test('a failing snapshot insert rolls back projection, pointer, and audit together', async () => {
  await repoA.create(pageFixture('pg-atomic'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });

  await repoA.pool.query(`
    CREATE OR REPLACE FUNCTION public.fail_revision_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected snapshot failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await repoA.pool.query(`
    CREATE TRIGGER fail_revision_insert_trigger
    BEFORE INSERT ON public.share_revisions
    FOR EACH ROW EXECUTE FUNCTION public.fail_revision_insert()
  `);

  try {
    await assert.rejects(
      repoB.updatePageWithPreconditions('pg-atomic', { title: 'Must not stick' }, {
        expectedContentRevision: '1',
        contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
        ip: '127.0.0.1'
      }),
      /injected snapshot failure/
    );
  } finally {
    await repoA.pool.query('DROP TRIGGER IF EXISTS fail_revision_insert_trigger ON public.share_revisions');
    await repoA.pool.query('DROP FUNCTION IF EXISTS public.fail_revision_insert()');
  }

  const page = await repoA.getById('pg-atomic');
  assert.equal(page.title, 'pg-atomic title');
  assert.equal(page.current_revision, '1');
  assert.equal((await repoA.listContentSnapshots('pg-atomic')).length, 1);

  const audits = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.audit_logs WHERE page_id = 'pg-atomic' AND action = 'page.content.update'"
  );
  assert.equal(audits.rows[0].count, 0);
});

test('combined save: either precondition failing rejects the whole update', async () => {
  await repoA.create(pageFixture('pg-combined'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });
  const passwordHash = await hashSecret('Combo9!');

  // Valid content expectation, stale access expectation.
  const staleAccess = await repoA.updatePageWithPreconditions('pg-combined', {
    title: 'Combined v2',
    isProtected: true,
    passwordHash,
    encryptedPassword: 'encrypted-placeholder'
  }, {
    expectedContentRevision: '1',
    expectedAccessRevision: '99',
    advanceAccessRevision: true,
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });
  assert.equal(staleAccess.status, 'conflict');

  let page = await repoA.getById('pg-combined');
  assert.equal(page.title, 'pg-combined title');
  assert.equal(page.is_protected, 0);
  assert.equal(page.current_revision, '1');
  assert.equal(page.access_revision, '1');
  assert.equal((await repoA.listContentSnapshots('pg-combined')).length, 1);

  // Stale content expectation, valid access expectation.
  const staleContent = await repoA.updatePageWithPreconditions('pg-combined', {
    title: 'Combined v2',
    isProtected: true,
    passwordHash,
    encryptedPassword: 'encrypted-placeholder'
  }, {
    expectedContentRevision: '42',
    expectedAccessRevision: '1',
    advanceAccessRevision: true,
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });
  assert.equal(staleContent.status, 'content_conflict');
  assert.equal(staleContent.current.htmlContent, '<h1>pg-combined body</h1>');

  page = await repoA.getById('pg-combined');
  assert.equal(page.title, 'pg-combined title');
  assert.equal(page.is_protected, 0);
  assert.equal(page.current_revision, '1');
  assert.equal(page.access_revision, '1');

  // Both valid: both families commit together.
  const both = await repoA.updatePageWithPreconditions('pg-combined', {
    title: 'Combined v2',
    isProtected: true,
    passwordHash,
    encryptedPassword: 'encrypted-placeholder'
  }, {
    expectedContentRevision: '1',
    expectedAccessRevision: '1',
    advanceAccessRevision: true,
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });
  assert.equal(both.status, 'updated');
  assert.equal(both.contentChanged, true);

  page = await repoA.getById('pg-combined');
  assert.equal(page.title, 'Combined v2');
  assert.equal(page.is_protected, 1);
  assert.equal(page.current_revision, '2');
  assert.equal(page.access_revision, '2');
});

test('an unchanged save does not bump the revision or write a snapshot', async () => {
  await repoA.create(pageFixture('pg-unchanged'), {
    revisionMeta: { source: 'web-create', actorType: 'owner', actorId: null }
  });

  const result = await repoA.updatePageWithPreconditions('pg-unchanged', {
    title: 'pg-unchanged title',
    htmlContent: '<h1>pg-unchanged body</h1>'
  }, {
    expectedContentRevision: '1',
    contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
    ip: '127.0.0.1'
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.contentChanged, false);
  assert.equal(result.contentRevision, '1');
  assert.equal((await repoA.listContentSnapshots('pg-unchanged')).length, 1);
});

test('64-bit current_revision values round-trip exactly as decimal strings', async () => {
  const big = '9007199254740993';
  const fields = {
    htmlContent: '<p>big revision body</p>',
    codeType: 'html',
    title: 'Big revision',
    description: null,
    markdownTheme: null
  };

  await repoA.pool.query(
    `INSERT INTO public.pages (id, html_content, created_at, code_type, title, current_revision)
     VALUES ('pg-big', $1, $2, 'html', 'Big revision', $3::bigint)`,
    [fields.htmlContent, 1700000000000, big]
  );
  await repoA.pool.query(
    `INSERT INTO public.share_revisions (
       share_id, revision, html_content, code_type, title, description,
       markdown_theme, snapshot_hash, source, actor_type, actor_id,
       restored_from_revision, created_at
     ) VALUES ('pg-big', $1::bigint, $2, 'html', 'Big revision', NULL, NULL, $3, 'baseline', 'operator', NULL, NULL, $4)`,
    [big, fields.htmlContent, computeSnapshotHash('pg-big', big, fields), 1700000001000]
  );

  const page = await repoA.getById('pg-big');
  assert.equal(page.current_revision, big);
  const snapshot = await repoA.getContentSnapshot('pg-big', big);
  assert.equal(snapshot.revision, big);
});

test('baseline backfill refuses an unpaused instance, then baselines legacy rows under pause', async () => {
  const legacyCreatedAt = 1700000000000;

  for (const id of ['pg-legacy-a', 'pg-legacy-b']) {
    await repoA.pool.query(
      `INSERT INTO public.pages (id, html_content, created_at, code_type, title)
       VALUES ($1, $2, $3, 'html', $4)`,
      [id, `<p>${id} legacy body</p>`, legacyCreatedAt, `${id} legacy title`]
    );
  }

  // Not paused: the backfill must refuse and write nothing.
  await assert.rejects(
    runBaselineBackfill(repoA.pool, { now: 1799999999000 }),
    /not paused/i
  );
  const untouched = await repoA.pool.query(
    "SELECT COUNT(*)::int AS count FROM public.pages WHERE id LIKE 'pg-legacy-%' AND current_revision IS NULL"
  );
  assert.equal(untouched.rows[0].count, 2);
  assert.equal((await repoA.listContentSnapshots('pg-legacy-a')).length, 0);

  // Enter the controlled window (pause + drain via the repository toggle).
  await repoA.setPublishingWritesPaused({ paused: true, ip: '127.0.0.1' });

  try {
    const runAt = 1799999999000;
    const result = await runBaselineBackfill(repoA.pool, { now: runAt });
    assert.equal(result.baselined, 2);
    assert.equal(result.capturedAt, runAt);

    for (const id of ['pg-legacy-a', 'pg-legacy-b']) {
      const page = await repoA.getById(id);
      assert.equal(page.current_revision, '1');
      // IDs, bodies and titles are preserved exactly.
      assert.equal(page.html_content, `<p>${id} legacy body</p>`);
      assert.equal(page.title, `${id} legacy title`);

      const snapshot = await repoA.getContentSnapshot(id, '1');
      assert.ok(snapshot);
      assert.equal(snapshot.source, 'baseline');
      // Capture time is the truthful run time, not the Share's created_at.
      assert.equal(Number(snapshot.created_at), runAt);
      assert.notEqual(Number(snapshot.created_at), legacyCreatedAt);
    }

    const second = await runBaselineBackfill(repoA.pool, { now: runAt + 1000 });
    assert.equal(second.baselined, 0);
  } finally {
    await repoA.setPublishingWritesPaused({ paused: false, ip: '127.0.0.1' });
  }
});
