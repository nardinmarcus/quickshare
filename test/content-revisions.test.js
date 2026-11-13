const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SHARE_API_KEY = 't06-test-key';
process.env.SESSION_SECRET = 't06-test-secret';

const app = require('../app');
const { encryptSecret, hashSecret } = require('../utils/security');
const { computeSnapshotHash } = require('../utils/contentRevision');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

function request(route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request(new URL(route, baseUrl), {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(route, method, value, headers = {}) {
  return request(route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value)
  });
}

const repository = () => app.locals.pageRepository;
const etagFor = (id, revision) => `"content:${id}:${revision}"`;

async function storedPage(id) {
  return repository().getById(id);
}

test('web create writes the Revision 1 baseline and returns revision + ETag', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<h1>Web created</h1>',
    codeType: 'html',
    title: 'Web title',
    description: 'Web description'
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);
  assert.equal(created.body.contentRevision, '1');
  assert.equal(created.body.contentEtag, etagFor(created.body.urlId, '1'));

  const page = await storedPage(created.body.urlId);
  assert.equal(page.current_revision, '1');
  assert.equal(page.published, true);

  const snapshot = await repository().getContentSnapshot(created.body.urlId, '1');
  assert.ok(snapshot);
  assert.equal(snapshot.html_content, '<h1>Web created</h1>');
  assert.equal(snapshot.code_type, 'html');
  assert.equal(snapshot.title, 'Web title');
  assert.equal(snapshot.description, 'Web description');
  assert.equal(snapshot.markdown_theme, null);
  assert.equal(snapshot.source, 'web-create');
  assert.equal(snapshot.actor_type, 'owner');
  assert.equal(snapshot.restored_from_revision, null);
  assert.equal(
    snapshot.snapshot_hash,
    computeSnapshotHash(created.body.urlId, '1', {
      htmlContent: '<h1>Web created</h1>',
      codeType: 'html',
      title: 'Web title',
      description: 'Web description',
      markdownTheme: null
    })
  );
});

test('Share API create writes the baseline with API provenance', async () => {
  const created = await jsonRequest('/api/v1/share', 'POST', {
    htmlContent: '# API created',
    codeType: 'markdown',
    title: 'API title'
  }, { 'X-API-Key': 't06-test-key' });

  assert.equal(created.status, 200);
  assert.equal(created.body.contentRevision, '1');
  assert.equal(created.body.contentEtag, etagFor(created.body.urlId, '1'));

  const snapshot = await repository().getContentSnapshot(created.body.urlId, '1');
  assert.ok(snapshot);
  assert.equal(snapshot.source, 'api-create');
  assert.equal(snapshot.actor_type, 'api_key');
  assert.equal(snapshot.code_type, 'markdown');
});

test('clone writes its own baseline for the copy', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>clone source</p>',
    codeType: 'html',
    title: 'Clone source'
  });
  const sourceId = created.body.urlId;

  const clone = await request(`/admin/pages/${sourceId}/clone`, { method: 'POST' });
  assert.equal(clone.status, 302);
  const newId = decodeURIComponent(clone.headers.location.split('/').pop());
  assert.notEqual(newId, sourceId);

  const page = await storedPage(newId);
  assert.equal(page.current_revision, '1');
  assert.equal(page.title, 'Clone source (Copy)');

  const snapshot = await repository().getContentSnapshot(newId, '1');
  assert.ok(snapshot);
  assert.equal(snapshot.source, 'admin-clone');
  assert.equal(snapshot.html_content, '<p>clone source</p>');
  assert.equal(snapshot.title, 'Clone source (Copy)');
});

test('admin detail page shows the content version and publish state', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>detail fixture</p>',
    codeType: 'html',
    title: 'Detail fixture'
  });

  const detail = await request(`/admin/pages/${created.body.urlId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /内容版本/);
  assert.match(detail.text, /Revision 1/);
  // The strong ETag is shown in the version row (HTML-escaped quotes).
  assert.ok(detail.text.includes(`content:${created.body.urlId}:1`));
  assert.match(detail.text, /发布状态/);
});

test('content saves require a concrete strong If-Match: 428 when missing, 412 for every other bad tag', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>guarded body</p>',
    codeType: 'html',
    title: 'Guarded'
  });
  const id = created.body.urlId;
  const snapshotBefore = await repository().getContentSnapshot(id, '1');

  const missing = await jsonRequest(`/admin/pages/${id}`, 'PUT', { title: 'Nope' });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.code, 'content_precondition_required');
  assert.equal(missing.body.contentRevision, '1');

  const badTags = [
    ['weak', `W/${etagFor(id, '1')}`],
    ['wildcard', '*'],
    ['list', `${etagFor(id, '1')}, ${etagFor(id, '2')}`],
    ['bare', `content:${id}:1`],
    ['single-quoted', `'content:${id}:1'`],
    ['access-family', `"access:${id}:1"`],
    ['wrong-share', etagFor('someone-else', '1')],
    ['stale', etagFor(id, '99')]
  ];

  for (const [label, tag] of badTags) {
    const response = await jsonRequest(`/admin/pages/${id}`, 'PUT', { title: 'Nope' }, { 'If-Match': tag });
    assert.equal(response.status, 412, `${label} tag must be a 412 conflict`);
    assert.equal(response.body.code, 'content_conflict', label);
    assert.equal(response.body.contentRevision, '1', label);
    assert.equal(response.body.current.htmlContent, '<p>guarded body</p>', label);
    assert.equal(response.body.current.title, 'Guarded', label);
  }

  // Nothing was applied and no snapshot was written by any rejection.
  const page = await storedPage(id);
  assert.equal(page.title, 'Guarded');
  assert.equal(page.current_revision, '1');
  const snapshots = await repository().listContentSnapshots(id);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], snapshotBefore);
});

test('a valid content save bumps the revision, writes an immutable snapshot, and reports the change', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>version one</p>',
    codeType: 'html',
    title: 'Versioned',
    description: 'first'
  });
  const id = created.body.urlId;
  const baseline = await repository().getContentSnapshot(id, '1');

  const saved = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Versioned two',
    htmlContent: '<p>version two</p>'
  }, { 'If-Match': etagFor(id, '1') });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.contentChanged, true);
  assert.equal(saved.body.page.currentRevision, '2');
  assert.equal(saved.body.page.contentEtag, etagFor(id, '2'));

  const page = await storedPage(id);
  assert.equal(page.title, 'Versioned two');
  assert.equal(page.html_content, '<p>version two</p>');
  assert.equal(page.description, 'first');
  // A content save never touches the access revision family.
  assert.equal(page.access_revision, '1');

  const snapshots = await repository().listContentSnapshots(id);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], baseline);
  assert.equal(snapshots[1].revision, '2');
  assert.equal(snapshots[1].html_content, '<p>version two</p>');
  assert.equal(snapshots[1].title, 'Versioned two');
  assert.equal(snapshots[1].description, 'first');
  assert.equal(snapshots[1].source, 'admin-edit');
  assert.equal(
    snapshots[1].snapshot_hash,
    computeSnapshotHash(id, '2', {
      htmlContent: '<p>version two</p>',
      codeType: 'html',
      title: 'Versioned two',
      description: 'first',
      markdownTheme: null
    })
  );
});

test('an unchanged content save succeeds without bumping the revision', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>stable</p>',
    codeType: 'html',
    title: 'Stable'
  });
  const id = created.body.urlId;

  const saved = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Stable',
    htmlContent: '<p>stable</p>'
  }, { 'If-Match': etagFor(id, '1') });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.contentChanged, false);
  assert.equal(saved.body.page.currentRevision, '1');
  assert.equal((await repository().listContentSnapshots(id)).length, 1);
});

test('access-only saves need no If-Match and never bump the content revision', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>access fixture</p>',
    codeType: 'html',
    title: 'Access fixture'
  });
  const id = created.body.urlId;

  const titleSave = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Access fixture v2'
  }, { 'If-Match': etagFor(id, '1') });
  assert.equal(titleSave.status, 200);
  assert.equal(titleSave.body.page.currentRevision, '2');

  const protectedSave = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    isProtected: true,
    password: 'Guard1!',
    expectedAccessRevision: '1'
  });
  assert.equal(protectedSave.status, 200);
  assert.equal(protectedSave.body.page.accessRevision, '2');
  assert.equal(protectedSave.body.page.currentRevision, '2');
  assert.equal((await repository().listContentSnapshots(id)).length, 2);
});

test('a combined save commits only when BOTH preconditions pass', async () => {
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>combined</p>',
    codeType: 'html',
    title: 'Combined'
  });
  const id = created.body.urlId;

  // Valid content tag, stale access expectation: nothing is applied.
  const staleAccess = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Combined v2',
    isProtected: true,
    password: 'Guard1!',
    expectedAccessRevision: '99'
  }, { 'If-Match': etagFor(id, '1') });
  assert.equal(staleAccess.status, 412);
  let page = await storedPage(id);
  assert.equal(page.title, 'Combined');
  assert.equal(page.is_protected, 0);
  assert.equal(page.current_revision, '1');
  assert.equal(page.access_revision, '1');

  // Stale content tag, valid access expectation: nothing is applied.
  const staleContent = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Combined v2',
    isProtected: true,
    password: 'Guard1!',
    expectedAccessRevision: '1'
  }, { 'If-Match': etagFor(id, '42') });
  assert.equal(staleContent.status, 412);
  assert.equal(staleContent.body.code, 'content_conflict');
  page = await storedPage(id);
  assert.equal(page.title, 'Combined');
  assert.equal(page.is_protected, 0);
  assert.equal(page.current_revision, '1');
  assert.equal(page.access_revision, '1');

  // Both valid: both families advance together.
  const both = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    title: 'Combined v2',
    isProtected: true,
    password: 'Guard1!',
    expectedAccessRevision: '1'
  }, { 'If-Match': etagFor(id, '1') });
  assert.equal(both.status, 200);
  assert.equal(both.body.page.currentRevision, '2');
  assert.equal(both.body.page.accessRevision, '2');
  page = await storedPage(id);
  assert.equal(page.title, 'Combined v2');
  assert.equal(page.is_protected, 1);
});

test('CRLF bodies are compared and stored byte-exactly', async () => {
  const crlfBody = 'line one\r\nline two\r\n';
  const created = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: crlfBody,
    codeType: 'html',
    title: 'CRLF fixture'
  });
  const id = created.body.urlId;

  const unchanged = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    htmlContent: crlfBody
  }, { 'If-Match': etagFor(id, '1') });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.contentChanged, false);
  assert.equal(unchanged.body.page.currentRevision, '1');

  const editedBody = 'line one\r\nline two changed\r\n';
  const edited = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
    htmlContent: editedBody
  }, { 'If-Match': etagFor(id, '1') });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.contentChanged, true);

  const page = await storedPage(id);
  assert.equal(page.html_content, editedBody);
  const snapshot = await repository().getContentSnapshot(id, '2');
  assert.equal(snapshot.html_content, editedBody);
});

test('metadata exposes the content ETag only with valid access', async () => {
  const open = await jsonRequest('/api/pages/create', 'POST', {
    htmlContent: '<p>open</p>',
    codeType: 'html',
    title: 'Open meta'
  });
  const openMeta = await request(`/api/pages/${open.body.urlId}`);
  assert.equal(openMeta.status, 200);
  assert.equal(openMeta.headers.etag, etagFor(open.body.urlId, '1'));
  assert.equal(openMeta.body.page.contentRevision, '1');

  const passwordHash = await hashSecret('Meta9!');
  await repository().create({
    id: 't06-locked-meta',
    htmlContent: '<p>locked secret body</p>',
    createdAt: Date.now(),
    passwordHash,
    encryptedPassword: encryptSecret('Meta9!'),
    isProtected: true,
    codeType: 'html',
    title: 'Locked meta secret title',
    description: 'locked description',
    expiresAt: null,
    markdownTheme: null
  });

  const lockedMeta = await request('/api/pages/t06-locked-meta');
  assert.equal(lockedMeta.status, 200);
  // No content ETag leaks: any ETag header present is only Express's weak
  // body hash of the neutral projection, never the content tag.
  assert.ok(!String(lockedMeta.headers.etag || '').includes('content:'));
  assert.equal('contentRevision' in lockedMeta.body.page, false);
  assert.notEqual(lockedMeta.body.page.title, 'Locked meta secret title');

  const unlock = await jsonRequest('/view/t06-locked-meta/password', 'POST', { password: 'Meta9!' });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers['set-cookie'].find(entry => entry.startsWith('page_access_t06-locked-meta=')).split(';')[0];

  const unlockedMeta = await request('/api/pages/t06-locked-meta', { headers: { Cookie: cookie } });
  assert.equal(unlockedMeta.status, 200);
  assert.equal(unlockedMeta.headers.etag, etagFor('t06-locked-meta', '1'));
  assert.equal(unlockedMeta.body.page.contentRevision, '1');
  assert.equal(unlockedMeta.body.page.title, 'Locked meta secret title');
});

test('an unbaselined legacy Share rejects content saves until the baseline exists', async () => {
  await repository().create({
    id: 't06-legacy',
    htmlContent: '<p>legacy body</p>',
    createdAt: 1700000000000,
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Legacy',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });

  // Simulate the pre-T06 state: no pointer, no snapshots.
  const legacy = repository().pages.get('t06-legacy');
  legacy.current_revision = null;
  repository().revisions.delete('t06-legacy');

  const missing = await jsonRequest('/admin/pages/t06-legacy', 'PUT', { title: 'Nope' });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.contentRevision, null);

  const tagged = await jsonRequest('/admin/pages/t06-legacy', 'PUT', { title: 'Nope' }, { 'If-Match': etagFor('t06-legacy', '1') });
  assert.equal(tagged.status, 412);
  assert.equal(tagged.body.code, 'content_conflict');

  const page = await storedPage('t06-legacy');
  assert.equal(page.title, 'Legacy');
  assert.equal(page.current_revision, null);
});

test('memory backfill baselines legacy Shares with a truthful capture time and is idempotent', async () => {
  await repository().create({
    id: 't06-backfill-a',
    htmlContent: '<p>backfill a</p>',
    createdAt: 1700000000000,
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Backfill A',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });
  await repository().create({
    id: 't06-backfill-b',
    htmlContent: '<p>backfill b</p>',
    createdAt: 1700000001000,
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Backfill B',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });

  for (const id of ['t06-backfill-a', 't06-backfill-b']) {
    repository().pages.get(id).current_revision = null;
    repository().revisions.delete(id);
  }

  const runAt = 1799999999000;
  const first = await repository().backfillRevisionBaselines({ now: runAt });
  // At least the two fixtures (the shared test repository may hold other
  // unbaselined leftovers from earlier tests in this file).
  assert.ok(first.baselined >= 2);
  assert.ok(first.skipped >= 1);

  for (const id of ['t06-backfill-a', 't06-backfill-b']) {
    const page = await storedPage(id);
    assert.equal(page.current_revision, '1');
    const snapshot = await repository().getContentSnapshot(id, '1');
    assert.ok(snapshot);
    // Capture time is the backfill run time, never the Share's created_at.
    assert.equal(snapshot.created_at, runAt);
    assert.notEqual(snapshot.created_at, page.created_at);
    assert.equal(snapshot.source, 'baseline');
    assert.equal(snapshot.html_content, page.html_content);
  }

  const second = await repository().backfillRevisionBaselines({ now: runAt + 1000 });
  assert.equal(second.baselined, 0);
});

test('all four content types create a baseline and accept a revisioned edit', async () => {
  const fixtures = [
    ['html', '<h1>html body</h1>', '<h1>html body v2</h1>'],
    ['markdown', '# markdown body', '# markdown body v2'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>'],
    ['mermaid', 'graph TD; A-->B', 'graph TD; A-->C']
  ];

  for (const [codeType, body, editedBody] of fixtures) {
    const created = await jsonRequest('/api/pages/create', 'POST', {
      htmlContent: body,
      codeType,
      title: `${codeType} fixture`
    });
    assert.equal(created.status, 200, codeType);
    const id = created.body.urlId;

    const snapshot = await repository().getContentSnapshot(id, '1');
    assert.ok(snapshot, codeType);
    assert.equal(snapshot.code_type, codeType);
    assert.equal(snapshot.html_content, body, codeType);

    const saved = await jsonRequest(`/admin/pages/${id}`, 'PUT', {
      htmlContent: editedBody
    }, { 'If-Match': etagFor(id, '1') });
    assert.equal(saved.status, 200, codeType);
    assert.equal(saved.body.contentChanged, true, codeType);
    assert.equal(saved.body.page.currentRevision, '2', codeType);

    const page = await storedPage(id);
    assert.equal(page.html_content, editedBody, codeType);
    assert.equal(page.code_type, codeType, codeType);
  }
});
