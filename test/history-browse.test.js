const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Share history browsing (T07, issue #31): the admin history list,
// single-Revision read and sandboxed preview are owner-only surfaces.
// A public Share does not make its history public, an API Key does not
// grant history access, and the list carries metadata only — never the
// snapshot bodies it paginates over.

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_PASSWORD = 't07-main-password';
process.env.ADMIN_DASHBOARD_PASSWORD = 't07-dashboard-password';
process.env.SHARE_API_KEY = 't07-legacy-key';
process.env.SESSION_SECRET = 't07-session-secret';
process.env.TZ = 'UTC';

const app = require('../app');
const repository = app.locals.pageRepository;

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const body = options.body || '';
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        json: res.headers['content-type']?.includes('application/json') && text
          ? JSON.parse(text)
          : null
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function jsonRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? '' : JSON.stringify(body)
  });
}

async function loginDashboard() {
  const response = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=t07-dashboard-password'
  });

  assert.equal(response.status, 302);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('dashboard_admin_session='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function dashboardCsrf(cookie, pagePath) {
  const page = await request(pagePath, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const match = page.text.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function createViaApiKey(body) {
  const res = await jsonRequest('/api/v1/share', {
    method: 'POST',
    headers: { 'X-API-Key': 't07-legacy-key' },
    body
  });
  assert.equal(res.status, 200);
  return res.json.urlId;
}

async function adminEdit(cookie, csrf, id, candidate) {
  const page = await repository.getById(id);
  const etag = `"content:${id}:${page.current_revision}"`;
  const res = await jsonRequest(`/admin/pages/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'If-Match': etag },
    body: candidate
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

test('history endpoints require the dashboard identity — not anonymity, not an API Key', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<h1>boundary</h1>', codeType: 'html', title: 'Boundary' });

  const anonymousList = await jsonRequest(`/admin/pages/${id}/revisions`);
  assert.equal(anonymousList.status, 401);
  assert.equal(anonymousList.json.success, false);

  const anonymousRead = await jsonRequest(`/admin/pages/${id}/revisions/1`);
  assert.equal(anonymousRead.status, 401);

  const apiKeyList = await jsonRequest(`/admin/pages/${id}/revisions`, {
    headers: { 'X-API-Key': 't07-legacy-key' }
  });
  assert.equal(apiKeyList.status, 401);

  const anonymousPreview = await request(`/admin/pages/${id}/revisions/1/preview`);
  assert.equal(anonymousPreview.status, 302);
  assert.match(anonymousPreview.headers.location, /\/admin\/login/);

  const ownerList = await jsonRequest(`/admin/pages/${id}/revisions`, {
    headers: { Cookie: cookie }
  });
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.json.total, 1);
});

test('list is newest-first metadata only: no bodies, with time, source and restore provenance', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie, '/admin/pages');
  const id = await createViaApiKey({
    htmlContent: 'body-marker-rev-one',
    codeType: 'html',
    title: 'History title',
    description: 'History description'
  });

  await adminEdit(cookie, csrf, id, { htmlContent: 'body-marker-rev-two', title: 'History title 2' });
  await adminEdit(cookie, csrf, id, { htmlContent: 'body-marker-rev-three', title: 'History title 3' });

  const res = await jsonRequest(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.limit, 20);
  assert.equal(res.json.offset, 0);
  assert.deepEqual(res.json.revisions.map(item => item.revision), ['3', '2', '1']);

  // The list response as a whole must not carry any snapshot body.
  assert.ok(!res.text.includes('body-marker-rev-one'));
  assert.ok(!res.text.includes('body-marker-rev-two'));
  assert.ok(!res.text.includes('body-marker-rev-three'));

  for (const item of res.json.revisions) {
    assert.equal(item.htmlContent, undefined);
    assert.equal(item.html_content, undefined);
    assert.equal(typeof item.createdAt, 'number');
    assert.equal(typeof item.createdAtText, 'string');
    assert.ok(item.createdAtText.length > 0);
    assert.equal(item.restoredFromRevision, null);
  }

  assert.equal(res.json.revisions[2].source, 'api-create');
  assert.equal(res.json.revisions[0].source, 'admin-edit');
  assert.match(res.headers['cache-control'], /no-store/);
});

test('list pagination clamps limit to 100 and pages with offset', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: 'page-body-0', codeType: 'html', title: 'Paged' });

  for (let index = 1; index <= 24; index += 1) {
    await repository.updatePage(id, { htmlContent: `page-body-${index}` });
  }

  const firstPage = await jsonRequest(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  assert.equal(firstPage.json.total, 25);
  assert.equal(firstPage.json.revisions.length, 20);
  assert.equal(firstPage.json.revisions[0].revision, '25');
  assert.equal(firstPage.json.revisions[19].revision, '6');

  const secondPage = await jsonRequest(`/admin/pages/${id}/revisions?limit=20&offset=20`, {
    headers: { Cookie: cookie }
  });
  assert.equal(secondPage.json.revisions.length, 5);
  assert.equal(secondPage.json.revisions[0].revision, '5');
  assert.equal(secondPage.json.revisions[4].revision, '1');

  const clamped = await jsonRequest(`/admin/pages/${id}/revisions?limit=500`, {
    headers: { Cookie: cookie }
  });
  assert.equal(clamped.json.limit, 100);
  assert.equal(clamped.json.revisions.length, 25);

  const beyond = await jsonRequest(`/admin/pages/${id}/revisions?offset=1000`, {
    headers: { Cookie: cookie }
  });
  assert.equal(beyond.json.total, 25);
  assert.deepEqual(beyond.json.revisions, []);
});

test('single read returns the exact stored snapshot bytes, including CRLF bodies', async () => {
  const cookie = await loginDashboard();
  const crlfBody = 'first line\r\nsecond line\r\n\r\nlast line\r\n';
  const id = await createViaApiKey({
    htmlContent: crlfBody,
    codeType: 'html',
    title: 'CRLF title',
    description: 'CRLF description'
  });

  await repository.updatePage(id, { htmlContent: 'replacement body' });

  const res = await jsonRequest(`/admin/pages/${id}/revisions/1`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const snapshot = res.json.revision;
  assert.equal(snapshot.revision, '1');
  assert.equal(snapshot.htmlContent, crlfBody);
  assert.equal(snapshot.codeType, 'html');
  assert.equal(snapshot.title, 'CRLF title');
  assert.equal(snapshot.description, 'CRLF description');
  assert.equal(snapshot.contentEtag, `"content:${id}:1"`);
  assert.equal(snapshot.source, 'api-create');

  const missing = await jsonRequest(`/admin/pages/${id}/revisions/99`, { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.success, false);

  const malformed = await jsonRequest(`/admin/pages/${id}/revisions/not-a-number`, {
    headers: { Cookie: cookie }
  });
  assert.equal(malformed.status, 404);

  const missingShareList = await jsonRequest('/admin/pages/no-such-share/revisions', {
    headers: { Cookie: cookie }
  });
  assert.equal(missingShareList.status, 404);

  const missingShareRead = await jsonRequest('/admin/pages/no-such-share/revisions/1', {
    headers: { Cookie: cookie }
  });
  assert.equal(missingShareRead.status, 404);
});

test('a Share without a baseline reports an empty history, not an error', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: 'baseline body', codeType: 'html', title: 'Will unbaseline' });

  // Simulate a pre-T06 Share: no baseline Revision and no snapshots.
  const page = await repository.getById(id);
  page.current_revision = null;
  repository.revisions.delete(id);

  const res = await jsonRequest(`/admin/pages/${id}/revisions`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 0);
  assert.deepEqual(res.json.revisions, []);
});

test('preview renders the historical snapshot through the sandbox pipeline for all four content types', async () => {
  const cookie = await loginDashboard();

  // Markers use only letters/digits/hyphens so they survive the
  // renderer's HTML escaping unchanged and can be asserted in the
  // srcdoc-escaped preview document.
  const fixtures = [
    {
      codeType: 'html',
      first: '<h1>html-marker-rev1</h1>',
      second: '<h1>html-marker-rev2</h1>',
      expectFirst: ['html-marker-rev1'],
      absentSecond: ['html-marker-rev2']
    },
    {
      codeType: 'markdown',
      first: '# markdown-marker-rev1',
      second: '# markdown-marker-rev2',
      expectFirst: ['markdown-marker-rev1', '&lt;h1'],
      absentSecond: ['markdown-marker-rev2']
    },
    {
      codeType: 'svg',
      first: '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="15">svg-marker-rev1</text></svg>',
      second: '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="15">svg-marker-rev2</text></svg>',
      expectFirst: ['svg-marker-rev1', '&lt;svg'],
      absentSecond: ['svg-marker-rev2']
    },
    {
      codeType: 'mermaid',
      first: 'graph TD; Alpha-->Beta;',
      second: 'graph TD; Alpha-->Gamma;',
      expectFirst: ['graph TD', 'mermaid-code', 'Beta'],
      absentSecond: ['Gamma']
    }
  ];

  for (const fixture of fixtures) {
    const id = await createViaApiKey({
      htmlContent: fixture.first,
      codeType: fixture.codeType,
      title: `${fixture.codeType} history`
    });
    await repository.updatePage(id, { htmlContent: fixture.second });

    const preview = await request(`/admin/pages/${id}/revisions/1/preview`, {
      headers: { Cookie: cookie }
    });
    assert.equal(preview.status, 200, fixture.codeType);
    assert.match(preview.headers['content-type'], /text\/html/);
    assert.match(preview.headers['cache-control'], /no-store/);
    // Same sandbox as the public view: scripts allowed, same-origin not.
    assert.ok(preview.text.includes('sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"'), fixture.codeType);
    assert.ok(!preview.text.includes('allow-same-origin'), fixture.codeType);

    for (const marker of fixture.expectFirst) {
      assert.ok(preview.text.includes(marker), `${fixture.codeType} preview should contain ${marker}`);
    }

    for (const marker of fixture.absentSecond) {
      assert.ok(!preview.text.includes(marker),
        `${fixture.codeType} preview of rev1 must not contain rev2 marker ${marker}`);
    }
  }
});

test('history stays owner-only for a protected Share while its public projection stays neutral', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({
    htmlContent: 'protected-history-body',
    codeType: 'html',
    title: 'Protected history title',
    isProtected: true,
    password: 'history-pw-1'
  });

  const publicMeta = await jsonRequest(`/api/pages/${id}`);
  assert.equal(publicMeta.status, 200);
  assert.equal(publicMeta.json.page.title, '受保护内容');
  assert.ok(!publicMeta.text.includes('protected-history-body'));
  assert.ok(!publicMeta.text.includes('Protected history title'));

  const anonymousList = await jsonRequest(`/admin/pages/${id}/revisions`);
  assert.equal(anonymousList.status, 401);
  assert.ok(!anonymousList.text.includes('protected-history-body'));

  const ownerPreview = await request(`/admin/pages/${id}/revisions/1/preview`, {
    headers: { Cookie: cookie }
  });
  assert.equal(ownerPreview.status, 200);
  assert.ok(ownerPreview.text.includes('protected-history-body'));
});

test('preview of a missing revision is a 404 and the preview document carries no admin credential', async () => {
  const cookie = await loginDashboard();
  const csrf = await dashboardCsrf(cookie, '/admin/pages');
  const id = await createViaApiKey({ htmlContent: '<p>cred-check</p>', codeType: 'html', title: 'Cred check' });

  const missing = await request(`/admin/pages/${id}/revisions/42/preview`, {
    headers: { Cookie: cookie }
  });
  assert.equal(missing.status, 404);

  const preview = await request(`/admin/pages/${id}/revisions/1/preview`, {
    headers: { Cookie: cookie }
  });
  assert.equal(preview.status, 200);
  assert.ok(!preview.text.includes(csrf));
  assert.ok(!preview.text.includes('dashboard_admin_session'));
  assert.ok(!preview.text.includes('t07-dashboard-password'));
});

test('admin detail page ships the history section and the shared diff scripts', async () => {
  const cookie = await loginDashboard();
  const id = await createViaApiKey({ htmlContent: '<p>shell</p>', codeType: 'html', title: 'Shell' });

  const detail = await request(`/admin/pages/${id}`, { headers: { Cookie: cookie } });
  assert.equal(detail.status, 200);
  assert.ok(detail.text.includes('id="history-section"'));
  assert.ok(detail.text.includes('id="history-list"'));
  assert.ok(detail.text.includes('id="history-compare-diff"'));
  assert.ok(detail.text.includes('sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"'));
  assert.ok(detail.text.includes('/js/source-diff.js'));
  assert.ok(detail.text.includes('/js/admin-history.js'));
  // T07 shipped browsing only; T09 adds the restore shell (asserted in
  // test/restore-revisions.test.js). Purge remains a later ticket.
  assert.ok(detail.text.includes('history-restore'));
  assert.ok(!detail.text.includes('history-purge'));
});
