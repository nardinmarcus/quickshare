const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'issue30-synthetic-session-secret';
process.env.SHARE_API_KEY = 'issue30-share-key';
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const app = require('../app');
const pageRepository = app.locals.pageRepository;
let server;
let origin;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function create(body = { htmlContent: '<h1>ISSUE30 BASE</h1>', codeType: 'html', title: 'Base title', description: 'Base description' }) {
  const res = await request('/api/pages/create', { method: 'POST', body });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text).urlId;
}
async function detailData(id) {
  const html = await (await request(`/admin/pages/${id}`)).text();
  const match = html.match(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'detail embeds page data');
  return JSON.parse(match[1]);
}
// Strong HTTP entity-tag: the protocol uses the double-quoted form only.
const etag = (id, revision) => `"content:${id}:${revision}"`;

test('created Shares start at content revision 1 displayed on the dashboard', async () => {
  const id = await create();
  const data = await detailData(id);
  assert.equal(data.currentRevision, '1');
  const html = await (await request(`/admin/pages/${id}`)).text();
  assert.match(html, /id="content-revision-display"/);
});

test('content saves require a concrete strong If-Match and advance the revision exactly', async () => {
  const id = await create();
  const missing = await request(`/admin/pages/${id}`, { method: 'PUT', body: { htmlContent: '<h1>UNSAVED</h1>' } });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).code, 'CONTENT_PRECONDITION_REQUIRED');
  assert.equal((await detailData(id)).currentRevision, '1', 'missing precondition saves nothing');
  assert.equal((await pageRepository.getById(id)).html_content, '<h1>ISSUE30 BASE</h1>');

  const ok = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>ISSUE30 SECOND</h1>' }
  });
  const okBody = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  const saved = okBody.page;
  assert.equal(saved.currentRevision, '2');
  assert.equal((await pageRepository.getById(id)).html_content, '<h1>ISSUE30 SECOND</h1>');
  assert.equal((await detailData(id)).currentRevision, '2');
});

test('weak, wildcard, list, bare-token, single-quoted and wrong-family values are rejected', async () => {
  const id = await create();
  const cases = [
    ['W/' + etag(id, '1'), 'weak tag'],
    ['w/' + etag(id, '1'), 'lowercase weak tag'],
    ['*', 'wildcard'],
    ['"*"', 'quoted wildcard'],
    [etag(id, '1') + ', ' + etag(id, '2'), 'tag list'],
    [`content:${id}:1`, 'bare token without quotes'],
    [`content:${id}:1`, 'uppercase bare token'],
    [`'${etag(id, '1')}'`, 'single-quoted alias'],
    [etag('other-share-xyz', '1'), 'wrong share family'],
    [etag(id, '0'), 'zero revision'],
    [etag(id, '01'), 'noncanonical revision'],
    [etag(id, '9223372036854775808'), 'revision beyond BIGINT'],
    [etag(id, 'abc'), 'non-numeric revision'],
    ['"access:' + id + ':1"', 'wrong tag family'],
    [etag(id, '1') + ' trailing', 'trailing garbage']
  ];
  for (const [value, label] of cases) {
    const res = await request(`/admin/pages/${id}`, {
      method: 'PUT', headers: { 'If-Match': value }, body: { htmlContent: '<h1>REJECTED</h1>' }
    });
    assert.equal(res.status, 400, `${label} must be 400, got ${res.status}`);
    assert.equal((await res.json()).code, 'INVALID_CONTENT_REVISION', label);
  }
  const page = await pageRepository.getById(id);
  assert.equal(page.html_content, '<h1>ISSUE30 BASE</h1>');
  assert.equal(page.current_revision, '1');
});

test('stale baselines return 412 with the remote content and keep the failed draft unsaved', async () => {
  const id = await create();
  const first = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') },
    body: { htmlContent: '<h1>ISSUE30 REMOTE</h1>', title: 'Remote title' }
  });
  assert.equal(first.status, 200);

  const stale = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') },
    body: { htmlContent: '<h1>ISSUE30 CANDIDATE</h1>', title: 'Candidate title' }
  });
  assert.equal(stale.status, 412);
  const payload = await stale.json();
  assert.equal(payload.code, 'CONTENT_REVISION_CONFLICT');
  assert.equal(payload.current.currentRevision, '2');
  assert.equal(payload.current.htmlContent, '<h1>ISSUE30 REMOTE</h1>');
  assert.equal(payload.current.title, 'Remote title');
  assert.equal(payload.current.codeType, 'html');
  // The failed draft must not leak into the stored Share.
  const page = await pageRepository.getById(id);
  assert.equal(page.html_content, '<h1>ISSUE30 REMOTE</h1>');
  assert.equal(page.title, 'Remote title');
  assert.equal(page.current_revision, '2');
});

test('identical snapshots do not create a new revision', async () => {
  const id = await create({ htmlContent: '<h1>IDENTICAL</h1>', codeType: 'html', title: 'Same', description: 'Same desc' });
  const before = await pageRepository.getById(id);
  const res = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') },
    body: { htmlContent: '<h1>IDENTICAL</h1>', title: 'Same', description: 'Same desc' }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).page.currentRevision, '1', 'same snapshot must not advance');
  const after = await pageRepository.getById(id);
  assert.equal(after.current_revision, before.current_revision);
});

test('metadata-only and policy-only saves stay on their own baselines', async () => {
  const id = await create();
  // Content-only save does not need an access baseline and does not move it.
  const content = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>C2</h1>' }
  });
  assert.equal(content.status, 200);
  assert.equal((await content.json()).page.accessRevision, '1');
  // Policy-only save does not need a content If-Match and does not move it.
  const policy = await request(`/admin/pages/${id}`, {
    method: 'PUT', body: { expiresAt: Date.now() + 3600000, expectedAccessRevision: '1' }
  });
  assert.equal(policy.status, 200);
  const page = (await policy.json()).page;
  assert.equal(page.currentRevision, '2', 'policy change must not create a content revision');
  assert.equal(page.accessRevision, '2');
});

test('combined content+policy saves commit only when BOTH baselines pass', async () => {
  const id = await create();
  const staleAccess = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') },
    body: { htmlContent: '<h1>COMBO</h1>', expiresAt: Date.now() + 3600000, expectedAccessRevision: '999' }
  });
  assert.equal(staleAccess.status, 412);
  assert.equal((await staleAccess.json()).code, 'ACCESS_REVISION_CONFLICT');
  let page = await pageRepository.getById(id);
  assert.equal(page.html_content, '<h1>ISSUE30 BASE</h1>', 'failed combo must not save content');
  assert.equal(page.current_revision, '1', 'failed combo must not create a snapshot');
  assert.equal(page.access_revision, '1', 'failed combo must not move access');

  const staleContent = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '7') },
    body: { htmlContent: '<h1>COMBO</h1>', expiresAt: Date.now() + 3600000, expectedAccessRevision: '1' }
  });
  assert.equal(staleContent.status, 412);
  assert.equal((await staleContent.json()).code, 'CONTENT_REVISION_CONFLICT');
  page = await pageRepository.getById(id);
  assert.equal(page.expires_at, null, 'failed combo must not save policy');

  const both = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') },
    body: { htmlContent: '<h1>COMBO OK</h1>', expiresAt: Date.now() + 3600000, expectedAccessRevision: '1' }
  });
  assert.equal(both.status, 200);
  page = (await both.json()).page;
  assert.equal(page.currentRevision, '2');
  assert.equal(page.accessRevision, '2');
});

test('title, description and theme edits each snapshot; protection, expiry, favorite and views never enter history', async () => {
  const id = await create({ htmlContent: '<h1>META</h1>', codeType: 'markdown', title: 'T1', description: 'D1' });
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { title: 'T2' }
  }).then(r => assert.equal(r.status, 200));
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '2') }, body: { description: 'D2' }
  }).then(r => assert.equal(r.status, 200));
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '3') }, body: { markdownTheme: 'github' }
  }).then(r => assert.equal(r.status, 200));
  const afterContent = await pageRepository.getById(id);
  assert.equal(afterContent.current_revision, '4');

  // Non-content writes must not advance the content revision.
  await request(`/admin/pages/${id}/favorite`, { method: 'PUT', body: { isFavorite: true } }).then(r => assert.equal(r.status, 200));
  await request(`/admin/pages/${id}`, { method: 'PUT', body: { isProtected: true, password: 'Pass30', expectedAccessRevision: '1' } }).then(r => assert.equal(r.status, 200));
  await request(`/view/${id}/view-event`, { method: 'POST' });
  const page = await pageRepository.getById(id);
  assert.equal(page.current_revision, '4', 'access/favorite/view writes never create content revisions');

  const revisions = await pageRepository.listContentRevisions(id);
  assert.equal(revisions.length, 4);
  const first = revisions.find(rev => rev.revision === '1');
  assert.equal(first.title, 'T1');
  assert.equal(first.description, 'D1');
  assert.equal(first.markdown_theme, 'bytedance', 'created Markdown Shares store the default theme');
  assert.equal(first.code_type, 'markdown');
  assert.equal(first.html_content, '<h1>META</h1>');
  assert.ok(!('view_count' in first) && !('expires_at' in first) && !('is_protected' in first) && !('is_favorite' in first),
    'protection, expiry, favorite and view counts never enter content history');
  const last = revisions.find(rev => rev.revision === '4');
  assert.equal(last.title, 'T2');
  assert.equal(last.description, 'D2');
  assert.equal(last.markdown_theme, 'github');
});

test('revision rows carry provenance: snapshot hash, real source path, trusted actor, null restore origin', async () => {
  const { contentSnapshotHash } = require('../utils/contentRevision');
  const id = await create();
  // Creation path (browser/web here): source web, no trusted individual actor.
  let revisions = await pageRepository.listContentRevisions(id);
  assert.equal(revisions[0].source, 'web');
  assert.equal(revisions[0].actor, null);
  assert.equal(revisions[0].restored_from, null);
  assert.equal(revisions[0].snapshot_hash, contentSnapshotHash({
    htmlContent: '<h1>ISSUE30 BASE</h1>', codeType: 'html', title: 'Base title', description: 'Base description', markdownTheme: null
  }));

  // Dashboard edit: owner dashboard provenance.
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>OWNER EDIT</h1>' }
  }).then(r => assert.equal(r.status, 200));
  revisions = await pageRepository.listContentRevisions(id);
  assert.equal(revisions[1].source, 'dashboard-edit');
  assert.equal(revisions[1].actor, 'owner-dashboard');
  assert.equal(revisions[1].restored_from, null);
  assert.equal(revisions[1].snapshot_hash, contentSnapshotHash({
    htmlContent: '<h1>OWNER EDIT</h1>', codeType: 'html', title: 'Base title', description: 'Base description', markdownTheme: null
  }));
});

test('Share API creation records the managed key identity and the api source path', async () => {
  const res = await fetch(`${origin}/api/v1/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SHARE_API_KEY },
    body: JSON.stringify({ htmlContent: '<h1>API PROVENANCE</h1>' })
  });
  assert.equal(res.status, 200);
  const { urlId } = await res.json();
  const revisions = await pageRepository.listContentRevisions(urlId);
  assert.equal(revisions[0].source, 'api');
  // Legacy environment keys are recorded as such (no secret material).
  assert.equal(revisions[0].actor, 'legacy-api-key');
  assert.doesNotMatch(revisions[0].actor, /issue30-share-key/);
});

test('save-mine with a fresh baseline submits the full candidate over CRLF bodies', async () => {
  const rawA = 'candidate A CRLF\r\nkept line';
  const id = await create({ htmlContent: rawA, codeType: 'html', title: 'Candidate title' });
  // Remote replaces the body and moves to revision 2.
  const remote = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: 'remote B\nbody' }
  });
  assert.equal(remote.status, 200);
  // The dashboard's save-mine submits the WHOLE reviewed candidate: user
  // metadata plus the original candidate body bytes, against the fresh
  // remote baseline — no silent merge, no normalized stub.
  const mine = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '2') },
    body: { title: 'Candidate title saved', htmlContent: rawA }
  });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).page.currentRevision, '3');
  const page = await pageRepository.getById(id);
  assert.equal(page.html_content, rawA, 'the committed candidate keeps its exact CRLF bytes');
  assert.equal(page.title, 'Candidate title saved');
  const revisions = await pageRepository.listContentRevisions(id);
  assert.equal((revisions.find(rev => rev.revision === '3')).html_content, rawA);
});

test('CRLF and mixed line-ending bodies stay byte-identical across no-op and metadata-only saves', async () => {
  const rawBody = 'CRLF line one\r\nCR-only line two\rline three\nLF last\r\n';
  const id = await create({ htmlContent: rawBody, codeType: 'html', title: 'CRLF base' });
  let page = await pageRepository.getById(id);
  assert.equal(page.html_content, rawBody, 'creation preserves CRLF/CR bytes exactly');
  const baseline = (await pageRepository.listContentRevisions(id))[0];
  assert.equal(baseline.html_content, rawBody, 'baseline snapshot keeps the original bytes');

  // Metadata-only save: new revision (title changed), body bytes untouched.
  const res = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { title: 'CRLF renamed' }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).page.currentRevision, '2');
  page = await pageRepository.getById(id);
  assert.equal(page.html_content, rawBody, 'metadata-only save must not rewrite line endings');
  const second = (await pageRepository.listContentRevisions(id)).find(rev => rev.revision === '2');
  assert.equal(second.html_content, rawBody);

  // Identical no-op save (same title again): no new revision, bytes intact.
  const noop = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '2') }, body: { title: 'CRLF renamed' }
  });
  assert.equal(noop.status, 200);
  assert.equal((await noop.json()).page.currentRevision, '2', 'same-snapshot save never bumps');
  assert.equal((await pageRepository.listContentRevisions(id)).length, 2);
  assert.equal((await pageRepository.getById(id)).html_content, rawBody);
});

test('codeType is fixed after creation and content edits reject a different type', async () => {
  const id = await create();
  const res = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>still html</h1>', codeType: 'markdown' }
  });
  assert.equal(res.status, 400);
  assert.equal((await pageRepository.getById(id)).code_type, 'html');
});

test('all four content types snapshot their fixed type and original characters', async () => {
  const samples = {
    html: ['<h1>T30  &amp;  </h1>\n<!-- keep -->', 'html'],
    markdown: ['#  Heading\n\n| a | b |\n| --- | --- |\n|  keep  spacing |  x |', 'markdown'],
    svg: ['<svg xmlns="http://www.w3.org/2000/svg"><text>  spaced  </text></svg>', 'svg'],
    mermaid: ['graph TD\n  A[  keep  ] --> B', 'mermaid']
  };
  for (const [name, [body, type]] of Object.entries(samples)) {
    const id = await create({ htmlContent: body, codeType: type });
    const res = await request(`/admin/pages/${id}`, {
      method: 'PUT', headers: { 'If-Match': etag(id, '1') },
      body: { htmlContent: `${body}\n<!-- edited -->`, title: `${name} title` }
    });
    assert.equal(res.status, 200, name);
    assert.equal((await res.json()).page.currentRevision, '2', name);
    const revisions = await pageRepository.listContentRevisions(id);
    assert.equal(revisions[0].code_type, type, name);
    assert.equal(revisions[0].html_content, body, `${name} baseline keeps original characters`);
    assert.equal(revisions[1].html_content, `${body}\n<!-- edited -->`, name);
  }
});

test('clones initialize their own baseline without touching the source history', async () => {
  const id = await create();
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>V2</h1>' }
  }).then(r => assert.equal(r.status, 200));
  const cloneRes = await fetch(`${origin}/admin/pages/${id}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: '' });
  assert.equal(cloneRes.status, 200);
  const cloneId = decodeURIComponent(new URL(cloneRes.url).pathname.split('/').pop());
  assert.notEqual(cloneId, id);
  const cloneData = await detailData(cloneId);
  assert.equal(cloneData.currentRevision, '1');
  assert.equal(cloneData.htmlContent, '<h1>V2</h1>');
  const source = await pageRepository.getById(id);
  assert.equal(source.current_revision, '2');
  assert.equal((await pageRepository.listContentRevisions(id)).length, 2);
  assert.equal((await pageRepository.listContentRevisions(cloneId)).length, 1);
});

test('revisions travel as precise decimal strings even beyond Number.MAX_SAFE_INTEGER', async () => {
  const id = 'issue30-big-rev';
  await pageRepository.create({ id, htmlContent: '<h1>BIG</h1>', createdAt: 1 });
  // Simulate a long-lived Share with a precisely tracked revision counter
  // (adapter-native state; the PostgreSQL exact-BIGINT path is covered by the
  // integration suite).
  const page = await pageRepository.getById(id);
  page.current_revision = '9007199254740993';
  pageRepository.revisions.set(id, new Map([
    ['9007199254740993', {
      share_id: id, revision: '9007199254740993', html_content: '<h1>BIG</h1>',
      code_type: 'html', title: null, description: null, markdown_theme: null, created_at: 1
    }]
  ]));
  const res = await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '9007199254740993') },
    body: { htmlContent: '<h1>BIG 2</h1>' }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).page.currentRevision, '9007199254740994', 'must not pass through Number');
  const revisions = await pageRepository.listContentRevisions(id);
  assert.deepEqual(revisions.map(rev => rev.revision).sort(), ['9007199254740993', '9007199254740994']);
});

test('Share API creation keeps its legacy 200 contract and writes the baseline', async () => {
  const res = await fetch(`${origin}/api/v1/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SHARE_API_KEY },
    body: JSON.stringify({ htmlContent: '<h1>API BASE</h1>' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.urlId);
  assert.equal(body.htmlContent, undefined, 'legacy create response keeps its historical field set');
  const data = await detailData(body.urlId);
  assert.equal(data.currentRevision, '1');
});

test('content saves record the committed revision in the same-transaction audit', async () => {
  const id = await create();
  await request(`/admin/pages/${id}`, {
    method: 'PUT', headers: { 'If-Match': etag(id, '1') }, body: { htmlContent: '<h1>AUDITED</h1>' }
  }).then(r => assert.equal(r.status, 200));
  const audits = await pageRepository.listAuditLogs({ limit: 10 });
  const entry = audits.find(log => log.action === 'page.update' && log.pageId === id);
  assert.ok(entry, 'content save is audited');
  const details = JSON.parse(entry.details);
  assert.equal(details.revision, '2');
  assert.ok(details.fields.includes('htmlContent'));
});
