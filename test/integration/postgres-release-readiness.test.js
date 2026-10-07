// #43 pinned server/client lifecycle over real HTTP and synthetic PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { contentSnapshotHash } = require('../../utils/contentRevision');
const { validateCanonicalPostgresSuiteUrl, validateClientCandidate } = require('../../scripts/release-readiness-check');

// This guard runs at direct test-entry load, before constructing any repository pool or running DDL.
const url = validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);
const CLIENT_ROOT = process.env.QUICKSHARE_TEST_CLIENT_ROOT;
if (CLIENT_ROOT) validateClientCandidate(CLIENT_ROOT);
else if (process.env.QUICKSHARE_REQUIRE_CLIENT_TESTS === '1') {
  throw new Error('QUICKSHARE_TEST_CLIENT_ROOT must name the pinned, read-only client checkout');
}
const SHARE_SCRIPT = CLIENT_ROOT ? path.join(CLIENT_ROOT, 'skills/namoo-quickshare/scripts/share.sh') : null;
if (CLIENT_ROOT && !fs.existsSync(SHARE_SCRIPT)) throw new Error('Pinned QuickShare client entry point is missing');
const clientOnlyOptions = CLIENT_ROOT ? {} : { skip: 'set QUICKSHARE_TEST_CLIENT_ROOT to opt into pinned-client lifecycle and scale tests' };

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.SESSION_SECRET = 'issue43-synthetic-session-secret-with-more-than-32-bytes';
process.env.ADMIN_DASHBOARD_PASSWORD = 'issue43-synthetic-dashboard-password';
process.env.SHARE_BASE_URL = 'https://share.issue43.invalid';

const { PostgresPageRepository } = require('../../models/postgres-pages');
const { runMigrations } = require('../../models/postgres-migrations');
const repository = new PostgresPageRepository(url.href, {
  POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '8',
  POSTGRES_STATEMENT_TIMEOUT_MS: '10000', POSTGRES_QUERY_TIMEOUT_MS: '11000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '20000'
});
const selector = require('../../models/pageRepository');
const originalFactory = selector.createPageRepository;
selector.createPageRepository = () => repository;
const app = require('../../app');
selector.createPageRepository = originalFactory;

const jsonHeaders = { 'Content-Type': 'application/json' };
const contentEtag = (id, revision) => `"content:${id}:${revision}"`;
let server;
let origin;
let scratch;
let cliHome;
let stateHome;
let dashboard;

async function request(route, { method = 'GET', body, headers = {}, redirect } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : jsonHeaders), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(redirect ? { redirect } : {})
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* HTML response */ }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

async function dashboardLogin() {
  const login = await fetch(`${origin}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: process.env.ADMIN_DASHBOARD_PASSWORD })
  });
  assert.equal(login.status, 302, 'dashboard password login must establish a real session');
  const setCookie = login.headers.getSetCookie()[0];
  assert.ok(setCookie, 'dashboard session cookie is required');
  const cookie = setCookie.split(';', 1)[0];
  const page = await fetch(`${origin}/admin/apis`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const match = (await page.text()).match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match, 'dashboard HTML must expose the session-bound CSRF token');
  return { Cookie: cookie, 'X-CSRF-Token': match[1] };
}

async function createKey(name) {
  const response = await request('/admin/apis/keys', {
    method: 'POST', body: { name }, headers: dashboard
  });
  assert.equal(response.status, 201, response.text);
  return response.body.apiKey;
}

async function grant(key, shareId, permission) {
  const permissions = typeof permission === 'string' ? { [permission]: true } : permission;
  const response = await request(`/admin/apis/keys/${key.id}/grants`, {
    method: 'POST', body: { shareId, ...permissions }, headers: dashboard
  });
  assert.equal(response.status, 201, response.text);
  return response.body;
}

function runClient(secret, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [SHARE_SCRIPT, ...args], {
      detached: true,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: cliHome,
        XDG_STATE_HOME: stateHome,
        TMPDIR: cliHome,
        QUICKSHARE_URL: origin,
        QUICKSHARE_API_KEY: secret,
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 60000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, signal: timedOut ? 'SIGKILL (timeout)' : signal, stdout, stderr });
    });
  });
}

function cliJson(result, label, expectedCode = 0) {
  assert.equal(result.signal, null, `${label}: client process was terminated`);
  assert.equal(result.status, expectedCode, `${label}: ${result.stderr}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { assert.fail(`${label}: expected JSON stdout (${error.message})`); }
}

async function getClosedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function findFile(root, basename) {
  const found = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name === basename) found.push(fullPath);
    }
  };
  visit(root);
  return found;
}

test.before(async () => {
  await repository.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await runMigrations(repository.pool, { logger: { info() {} } });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'issue43-client-http-'));
  cliHome = path.join(scratch, 'home');
  stateHome = path.join(cliHome, 'state');
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  dashboard = await dashboardLogin();
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await repository.pool.end();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test('pinned QuickShare client completes one PostgreSQL Share lifecycle and enforces boundaries', clientOnlyOptions, async () => {
  const editor = await createKey('issue43 synthetic lifecycle editor');
  const source = path.join(cliHome, 'lifecycle.html');
  const originalContent = '<h1>issue43 lifecycle revision one</h1>\n';
  fs.writeFileSync(source, originalContent, { mode: 0o600 });

  const curl = execFileSync('which', ['curl'], { encoding: 'utf8' }).trim();
  const dropDir = path.join(scratch, 'drop-create-response');
  fs.mkdirSync(dropDir, { mode: 0o700 });
  const dropCount = path.join(dropDir, 'count');
  const wrapper = path.join(dropDir, 'curl');
  fs.writeFileSync(wrapper, `#!/bin/bash\nmethod=''; route=''; next=false\nfor arg do\n  if [[ $next == true ]]; then method=$arg; next=false\n  elif [[ $arg == --request ]]; then next=true\n  elif [[ $arg == */api/v1/share ]]; then route=$arg\n  fi\ndone\nif [[ "$method" == POST && -n "$route" ]]; then\n  "$REAL_CURL" "$@"; rc=$?\n  if [[ $rc == 0 ]]; then printf x >> "$DROP_COUNT_FILE"; exit 18; fi\n  exit "$rc"\nfi\nexec "$REAL_CURL" "$@"\n`, { mode: 0o700 });
  const interrupted = await runClient(editor.secret, ['--action', 'create', source, '--type', 'html', '--json'], {
    PATH: `${dropDir}:${process.env.PATH}`, REAL_CURL: curl, DROP_COUNT_FILE: dropCount
  });
  assert.equal(interrupted.signal, null, 'lost-response create must finish rather than time out');
  assert.notEqual(interrupted.status, 0, 'lost create response must remain explicitly pending');
  assert.equal(interrupted.stdout, '', 'uncertain create must not print an unconfirmed Share URL');
  const requestId = interrupted.stderr.match(/request ID: ([A-Za-z0-9_-]{16,128})/)?.[1];
  assert.ok(requestId, 'uncertain create reports its resumable request ID');
  const pending = findFile(stateHome, `${requestId}.json`);
  assert.equal(pending.length, 1, 'client durably stores the exact pending create');
  const pendingRecord = JSON.parse(fs.readFileSync(pending[0], 'utf8'));
  assert.equal(pendingRecord.action, 'create');
  assert.equal(pendingRecord.request.htmlContent, originalContent);
  const operation = await repository.pool.query(
    'SELECT action, result_share_id, result_revision, deleted_at FROM publish_operations WHERE request_id = $1', [requestId]
  );
  assert.equal(operation.rowCount, 1, 'HTTP retries committed exactly one idempotent operation');
  assert.equal(operation.rows[0].action, 'create');
  assert.equal(operation.rows[0].deleted_at, null);
  const postCountBeforeResume = fs.readFileSync(dropCount, 'utf8').length;
  const resumed = await runClient(editor.secret, ['--action', 'resume', '--request-id', requestId, '--json']);
  const first = cliJson(resumed, 'status-first create resume');
  assert.equal(first.requestId, requestId);
  assert.equal(first.replayed, true);
  assert.equal(fs.readFileSync(dropCount, 'utf8').length, postCountBeforeResume, 'resume resolves the receipt without another create POST');
  assert.equal(fs.existsSync(pending[0]), false, 'confirmed result clears pending intent');
  const firstShareId = first.urlId;
  assert.equal(firstShareId, operation.rows[0].result_share_id);
  assert.equal(operation.rows[0].result_revision, '1');

  const secondCreate = cliJson(await runClient(editor.secret, ['--action', 'create', source, '--type', 'html', '--json']), 'same-source re-share');
  assert.notEqual(secondCreate.urlId, firstShareId, 're-sharing identical source always creates a distinct Share');

  const editGrant = await grant(editor, firstShareId, 'canUpdate');
  assert.equal(editGrant.grant.canUpdate, true);
  assert.ok(editGrant.scopes.includes('share:update'));
  const preview = await runClient(editor.secret, ['--action', 'link', source, '--id', firstShareId, '--json']);
  assert.equal(preview.signal, null);
  assert.equal(preview.status, 2, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).confirmationRequired, true);
  const linked = cliJson(await runClient(editor.secret, ['--action', 'link', source, '--id', firstShareId, '--confirm', '--json']), 'reviewed source link');
  assert.equal(linked.linked, true);

  const agentContent = '<h1>issue43 lifecycle agent revision two</h1>\n';
  fs.writeFileSync(source, agentContent);
  const agentUpdate = cliJson(await runClient(editor.secret, ['--action', 'update', source, '--id', firstShareId, '--json']), 'Agent update');
  assert.equal(agentUpdate.revision, '2');
  assert.equal(agentUpdate.url, `${process.env.SHARE_BASE_URL}/view/${firstShareId}`);
  let current = await request(`/api/v1/shares/${firstShareId}/content`, { headers: { 'X-API-Key': editor.secret } });
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('etag'), contentEtag(firstShareId, '2'));
  assert.equal(current.body.htmlContent, agentContent);

  const staleDashboard = await request(`/admin/pages/${firstShareId}`, {
    method: 'PUT',
    headers: { ...dashboard, 'If-Match': contentEtag(firstShareId, '1') },
    body: { htmlContent: '<h1>stale dashboard draft</h1>\n', title: current.body.title,
      description: current.body.description, markdownTheme: current.body.markdownTheme }
  });
  assert.equal(staleDashboard.status, 412);
  assert.equal(staleDashboard.body.code, 'CONTENT_REVISION_CONFLICT');

  const adminContent = '<h1>issue43 lifecycle dashboard winner revision three</h1>\n';
  const adminUpdate = await request(`/admin/pages/${firstShareId}`, {
    method: 'PUT',
    headers: { ...dashboard, 'If-Match': current.headers.get('etag') },
    body: { htmlContent: adminContent, title: 'Issue 43 dashboard winner',
      description: current.body.description, markdownTheme: current.body.markdownTheme }
  });
  assert.equal(adminUpdate.status, 200, adminUpdate.text);
  current = await request(`/api/v1/shares/${firstShareId}/content`, { headers: { 'X-API-Key': editor.secret } });
  assert.equal(current.headers.get('etag'), contentEtag(firstShareId, '3'));
  assert.equal(current.body.htmlContent, adminContent);
  fs.writeFileSync(source, '<h1>issue43 stale agent candidate</h1>\n');
  const clientConflict = await runClient(editor.secret, ['--action', 'update', source, '--id', firstShareId]);
  assert.equal(clientConflict.signal, null, 'client conflict probe must finish rather than time out');
  assert.notEqual(clientConflict.status, 0);
  assert.match(clientConflict.stderr.toLowerCase(), /candidate|conflict/);
  current = await request(`/api/v1/shares/${firstShareId}/content`, { headers: { 'X-API-Key': editor.secret } });
  assert.equal(current.body.htmlContent, adminContent, 'stale Agent candidate cannot overwrite the dashboard winner');

  const restore = cliJson(await runClient(editor.secret, ['--action', 'restore', '--id', firstShareId, '--revision', '1', '--json']), 'client restore');
  assert.equal(restore.sourceRevision, '1');
  assert.equal(restore.revision, '4');
  assert.equal(restore.snapshot.htmlContent, originalContent);
  current = await request(`/api/v1/shares/${firstShareId}/content`, { headers: { 'X-API-Key': editor.secret } });
  assert.equal(current.headers.get('etag'), contentEtag(firstShareId, '4'));
  assert.equal(current.body.htmlContent, originalContent);

  const purge = await request(`/admin/pages/${firstShareId}/revisions/2/purge`, {
    method: 'POST', headers: dashboard, body: { confirm: `${firstShareId}:2` }
  });
  assert.equal(purge.status, 200, purge.text);
  assert.equal(purge.body.purged.revision, '2');
  const purgedSnapshot = await runClient(editor.secret, ['--action', 'history', '--id', firstShareId, '--revision', '2', '--json']);
  assert.equal(purgedSnapshot.signal, null, 'purged-history probe must finish rather than time out');
  assert.notEqual(purgedSnapshot.status, 0);
  assert.equal(JSON.parse(purgedSnapshot.stdout).code, 'REVISION_PURGED');
  assert.equal(JSON.parse(purgedSnapshot.stdout).contentAvailable, false);
  const history = cliJson(await runClient(editor.secret, ['--action', 'history', '--id', firstShareId, '--json']), 'post-purge history');
  assert.equal(history.revisions.find(row => row.revision === '2').purged, true);

  const ungrantedRead = await request(`/api/v1/shares/${secondCreate.urlId}/content`, {
    headers: { 'X-API-Key': editor.secret }
  });
  assert.equal(ungrantedRead.status, 404, 'create capability does not grant cross-Share read access');
  const editorList = await request('/api/v1/shares', { headers: { 'X-API-Key': editor.secret } });
  assert.equal(editorList.status, 200);
  assert.deepEqual(editorList.body.shares.map(row => row.id), [firstShareId]);

  const publisher = await createKey('issue43 synthetic publish-only key');
  const publishGrant = await grant(publisher, firstShareId, 'canPublish');
  assert.equal(publishGrant.grant.canPublish, true);
  assert.ok(publishGrant.scopes.includes('share:publish'));
  assert.equal(publishGrant.scopes.includes('share:read'), false);
  for (const route of ['/api/v1/shares', `/api/v1/shares/${firstShareId}/content`, `/api/v1/shares/${firstShareId}/revisions`]) {
    const denied = await request(route, { headers: { 'X-API-Key': publisher.secret } });
    assert.equal(denied.status, 403, `publish-only Key crossed read boundary: ${route}`);
  }
  const initialState = await request(`/api/v1/shares/${firstShareId}/state`, { headers: { 'X-API-Key': publisher.secret } });
  assert.equal(initialState.status, 200);
  assert.equal(initialState.headers.get('etag'), `"access:${firstShareId}:1"`);
  assert.equal(initialState.body.published, true);
  const unpublish = cliJson(await runClient(publisher.secret, ['--action', 'unpublish', '--id', firstShareId, '--json']), 'client unpublish');
  assert.equal(unpublish.published, false);
  assert.equal(unpublish.accessRevision, '2');
  assert.equal(unpublish.etag, `"access:${firstShareId}:2"`);
  const republish = cliJson(await runClient(publisher.secret, ['--action', 'republish', '--id', firstShareId, '--json']), 'client republish');
  assert.equal(republish.published, true);
  assert.equal(republish.accessRevision, '3');
  assert.equal(republish.etag, `"access:${firstShareId}:3"`);
  assert.equal(republish.url, `${process.env.SHARE_BASE_URL}/view/${firstShareId}`);
  const finalState = await request(`/api/v1/shares/${firstShareId}/state`, { headers: { 'X-API-Key': publisher.secret } });
  assert.equal(finalState.headers.get('etag'), `"access:${firstShareId}:3"`);
  assert.equal(finalState.body.published, true);

  const revoked = await request(`/admin/apis/keys/${publisher.id}`, { method: 'DELETE', headers: dashboard });
  assert.equal(revoked.status, 200, revoked.text);
  const revokedAttempt = await request(`/api/v1/shares/${firstShareId}/state`, { headers: { 'X-API-Key': publisher.secret } });
  assert.equal(revokedAttempt.status, 401, 'revoked Key cannot replay publication-state access');
  const storedKey = await repository.pool.query('SELECT id FROM api_keys WHERE id = $1', [publisher.id]);
  assert.equal(storedKey.rowCount, 0);

  const receipts = [resumed.stdout, secondCreate, agentUpdate, restore, unpublish, republish].map(output =>
    typeof output === 'string' ? output : JSON.stringify(output)
  );
  for (const output of receipts) {
    assert.equal(output.includes(editor.secret), false, 'managed credentials never appear in client receipts');
    assert.equal(output.includes(publisher.secret), false, 'publish credentials never appear in client receipts');
  }
});

test('current Share reads and restore are measured with tenfold page and revision history', clientOnlyOptions, async () => {
  const baselineRows = 100;
  const scaledRows = baselineRows * 10;
  const shareId = 'issue43-history-0001';
  const createdAt = Date.now() - 10000;
  const makeRevisions = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => {
    const revision = first + index;
    const htmlContent = `<h1>Issue 43 scale revision ${revision}</h1>\n`;
    const title = `Issue 43 scale revision ${revision}`;
    const snapshot = { htmlContent, codeType: 'html', title, description: null, markdownTheme: null };
    return {
      revision,
      html_content: htmlContent,
      code_type: 'html',
      title,
      description: null,
      markdown_theme: null,
      created_at: createdAt + revision,
      snapshot_hash: contentSnapshotHash(snapshot)
    };
  });
  const insertRevisions = async revisions => repository.pool.query(
    `INSERT INTO share_revisions (
       share_id, revision, html_content, code_type, title, description, markdown_theme,
       created_at, snapshot_hash, source, actor, restored_from
     )
     SELECT $1, fixture.revision, fixture.html_content, fixture.code_type, fixture.title,
       fixture.description, fixture.markdown_theme, fixture.created_at, fixture.snapshot_hash,
       'dashboard-edit', 'issue43-scale-fixture', NULL
     FROM jsonb_to_recordset($2::jsonb) AS fixture (
       revision bigint, html_content text, code_type text, title text, description text,
       markdown_theme text, created_at bigint, snapshot_hash text
     )`,
    [shareId, JSON.stringify(revisions)]
  );
  const baselineHistory = makeRevisions(1, baselineRows);
  const latest = baselineHistory.at(-1);
  await repository.pool.query(
    `INSERT INTO pages (
       id, html_content, created_at, code_type, title, description, markdown_theme,
       is_protected, view_count, is_favorite, current_revision
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, FALSE, $8::bigint)`,
    [shareId, latest.html_content, createdAt, latest.code_type, latest.title,
      latest.description, latest.markdown_theme, String(baselineRows)]
  );
  await insertRevisions(baselineHistory);

  const editor = await createKey('issue43 synthetic scale reader and updater');
  await grant(editor, shareId, { canRead: true, canUpdate: true });
  const measure = async run => {
    const durations = [];
    let result;
    for (let sample = 0; sample < 15; sample += 1) {
      const started = process.hrtime.bigint();
      result = await run();
      durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    durations.sort((left, right) => left - right);
    return {
      samples: durations.length,
      p50Ms: Number(durations[Math.floor(durations.length * 0.5)].toFixed(2)),
      p95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(2)),
      result
    };
  };
  const measureCurrentRead = async expectedRevision => {
    const queries = [];
    const originalQuery = repository.pool.query;
    repository.pool.query = function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
      queries.push(text);
      return originalQuery.apply(this, args);
    };
    try {
      const timings = await measure(async () => {
        const response = await request(`/api/v1/shares/${shareId}/content`, {
          headers: { 'X-API-Key': editor.secret }
        });
        assert.equal(response.status, 200, response.text);
        assert.equal(response.headers.get('etag'), contentEtag(shareId, String(expectedRevision)));
        assert.deepEqual(Object.keys(response.body).sort(), [
          'success', 'id', 'revision', 'htmlContent', 'codeType', 'title', 'description', 'markdownTheme'
        ].sort(), 'the current read returns one bounded projection, not historical snapshots');
        return response.body.htmlContent.length;
      });
      assert.ok(queries.some(query => /\bFROM\s+pages\b/i.test(query)), 'current read must query the Share projection');
      assert.equal(queries.some(query => /\bshare_revisions\b/i.test(query)), false,
        'current read must not scan historical revisions');
      return { ...timings, queriesObserved: queries.length, historyTableQueries: 0 };
    } finally {
      repository.pool.query = originalQuery;
    }
  };
  const measureRestore = async label => {
    const started = process.hrtime.bigint();
    const result = cliJson(await runClient(editor.secret, [
      '--action', 'restore', '--id', shareId, '--revision', '1', '--json'
    ]), label);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.sourceRevision, '1');
    return { elapsedMs: Number(elapsedMs.toFixed(2)), resultingRevision: result.revision };
  };
  const measurePageList = async expectedTotal => {
    const durations = [];
    const expectedPageSize = 50;
    const expectedTotalPages = Math.ceil(expectedTotal / expectedPageSize);
    for (let sample = 0; sample < 15; sample += 1) {
      const started = process.hrtime.bigint();
      const response = await fetch(`${origin}/admin/pages`, { headers: { Cookie: dashboard.Cookie } });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal((html.match(/<tr\b[^>]*data-page-id=/g) || []).length, expectedPageSize,
        'the admin response stays capped at one page of Share rows');
      assert.ok(html.includes(`共 ${expectedTotal} 个分享`), 'the total count reflects the complete corpus');
      assert.ok(html.includes(`第 1 / ${expectedTotalPages} 页`), 'pagination metadata reflects the complete corpus');
      durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    durations.sort((left, right) => left - right);
    return {
      samples: durations.length,
      returnedRows: expectedPageSize,
      totalRows: expectedTotal,
      totalPages: expectedTotalPages,
      p50Ms: Number(durations[Math.floor(durations.length * 0.5)].toFixed(2)),
      p95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(2))
    };
  };

  const existingRows = Number((await repository.pool.query('SELECT COUNT(*)::int AS count FROM pages')).rows[0].count);
  const seedPages = async (first, last) => repository.pool.query(
    `INSERT INTO pages (id, html_content, created_at, code_type, title, description, is_protected, view_count, is_favorite)
     SELECT 'issue43scale' || lpad(series::text, 8, '0'), '<p>synthetic scale fixture</p>', $3::bigint - series::bigint,
       'html', 'Issue 43 scale fixture ' || series, NULL, 0, 0, FALSE
     FROM generate_series($1::int, $2::int) AS series`,
    [first, last, Date.now()]
  );
  if (existingRows < baselineRows) await seedPages(1, baselineRows - existingRows);

  const baseline = {
    pageRows: Number((await repository.pool.query('SELECT COUNT(*)::int AS count FROM pages')).rows[0].count),
    revisionRows: Number((await repository.pool.query('SELECT COUNT(*)::int AS count FROM share_revisions WHERE share_id = $1', [shareId])).rows[0].count),
    adminList: await measurePageList(baselineRows),
    currentRead: await measureCurrentRead(baselineRows),
    restore: await measureRestore('100-revision restore')
  };

  await seedPages(baselineRows + 1, scaledRows);
  await insertRevisions(makeRevisions(baselineRows + 2, scaledRows));
  const newest = makeRevisions(scaledRows, scaledRows)[0];
  await repository.pool.query(
    `UPDATE pages SET html_content = $2, title = $3, created_at = $4, current_revision = $5::bigint WHERE id = $1`,
    [shareId, newest.html_content, newest.title, newest.created_at, String(scaledRows)]
  );
  const actualRows = Number((await repository.pool.query('SELECT COUNT(*)::int AS count FROM pages')).rows[0].count);
  const actualRevisions = Number((await repository.pool.query('SELECT COUNT(*)::int AS count FROM share_revisions WHERE share_id = $1', [shareId])).rows[0].count);
  assert.equal(actualRows, scaledRows, 'the Share corpus must be exactly ten times the baseline');
  assert.equal(actualRevisions, scaledRows, 'historical Share revisions must be exactly ten times the baseline');
  const tenfold = {
    pageRows: actualRows,
    revisionRows: actualRevisions,
    adminList: await measurePageList(scaledRows),
    currentRead: await measureCurrentRead(scaledRows),
    restore: await measureRestore('1000-revision restore')
  };
  console.log(`ISSUE43_PERF_10X ${JSON.stringify({ baseline, tenfold })}`);
});

test('runtime PostgreSQL network failure returns unavailable and keeps the Postgres repository', async () => {
  const port = await getClosedLoopbackPort();
  const unavailableRepository = new PostgresPageRepository(
    `postgresql://issue43:synthetic@127.0.0.1:${port}/issue43_unavailable_test`,
    {
      POSTGRES_SSL: 'false', POSTGRES_POOL_MAX: '1',
      POSTGRES_CONNECTION_TIMEOUT_MS: '1000', POSTGRES_QUERY_TIMEOUT_MS: '1500'
    }
  );
  let connectionErrorCode;
  const originalPoolQuery = unavailableRepository.pool.query.bind(unavailableRepository.pool);
  unavailableRepository.pool.query = (...args) => originalPoolQuery(...args).catch(error => {
    connectionErrorCode = error.code;
    throw error;
  });
  const selector = require('../../models/pageRepository');
  const appPath = require.resolve('../../app');
  const previousAppModule = require.cache[appPath];
  const originalFactory = selector.createPageRepository;
  let unavailableApp;
  selector.createPageRepository = () => unavailableRepository;
  delete require.cache[appPath];
  try {
    unavailableApp = require('../../app');
  } finally {
    selector.createPageRepository = originalFactory;
    if (previousAppModule) require.cache[appPath] = previousAppModule;
    else delete require.cache[appPath];
  }

  assert.ok(unavailableApp.locals.pageRepository instanceof PostgresPageRepository);
  assert.equal(unavailableApp.locals.pageRepository, unavailableRepository,
    'the app keeps its configured Postgres repository instead of silently selecting memory');
  const outageServer = unavailableApp.listen(0, '127.0.0.1');
  await new Promise(resolve => outageServer.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${outageServer.address().port}/api/v1/shares/issue43-outage-share/content`, {
      headers: { 'X-API-Key': `qs.issue43offline0001.${'x'.repeat(32)}` }
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'API_READ_UNAVAILABLE');
    assert.equal(body.retryable, true);
    assert.equal(connectionErrorCode, 'ECONNREFUSED', 'the HTTP 503 must be caused by the intended closed-loopback TCP port');
    assert.equal(JSON.stringify(body).includes('synthetic'), false);
    console.log('ISSUE43_DB_OUTAGE_HTTP', JSON.stringify({ status: response.status, code: body.code, retryable: body.retryable }));
  } finally {
    await new Promise(resolve => outageServer.close(resolve));
    await unavailableRepository.pool.end();
  }
});
