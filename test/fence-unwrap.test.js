const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'fence-unwrap-secret';

const app = require('../app');

let server;
let baseUrl;

const FENCE = '```';
const pythonBody = 'def double(x):\n    return x * 2\n'.repeat(20);

const PAGES = {
  'md-python-fence': { codeType: 'markdown', content: `# Script\n\n${FENCE}python\n${pythonBody}${FENCE}\n` },
  'md-html-fence': { codeType: 'markdown', content: `${FENCE}html\n<section><h2>Snippet</h2><p>${'shown as code '.repeat(20)}</p></section>\n${FENCE}` },
  'md-markdown-fence': { codeType: 'markdown', content: `${FENCE}markdown\n# Inner Title\n\n${'- item\n'.repeat(20)}${FENCE}` },
  'html-html-fence': { codeType: 'html', content: `${FENCE}html\n<!DOCTYPE html><html><head><title>x</title></head><body><h1 id="unwrapped">${'Hello '.repeat(20)}</h1></body></html>\n${FENCE}` },
  'svg-svg-fence': { codeType: 'svg', content: `${FENCE}svg\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="unwrapped-rect" width="10" height="10"/></svg>\n${FENCE}` }
};

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, baseUrl), (res) => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

function sandboxDocument(html) {
  const match = html.match(/srcdoc="([\s\S]*?)"\s*>/);
  assert.ok(match, 'view response embeds a srcdoc sandbox');
  return match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function view(id) {
  const response = await get(`/view/${id}`);
  assert.equal(response.status, 200);
  const doc = sandboxDocument(response.text);
  const codeType = (doc.match(/<meta name="code-type" content="([^"]+)">/) || [])[1];
  return { doc, codeType };
}

test.before(async () => {
  for (const [id, { codeType, content }] of Object.entries(PAGES)) {
    await app.locals.pageRepository.create({
      id,
      htmlContent: content,
      createdAt: Date.now(),
      passwordHash: null,
      encryptedPassword: null,
      isProtected: false,
      codeType,
      title: id,
      description: null,
      expiresAt: null,
      markdownTheme: codeType === 'markdown' ? 'bytedance' : null
    });
  }

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

test('a markdown Share dominated by a non-renderable fence stays markdown and keeps the code block', async () => {
  const { doc, codeType } = await view('md-python-fence');

  assert.equal(codeType, 'markdown');
  assert.match(doc, /<pre[\s>][\s\S]*def double\(x\):\n {4}return x \* 2/);
});

test('a markdown Share dominated by an html fence shows the html as code instead of rendering it', async () => {
  const { doc, codeType } = await view('md-html-fence');

  assert.equal(codeType, 'markdown');
  assert.match(doc, /<pre[\s>][\s\S]*&lt;section&gt;/);
});

test('a markdown Share wrapped in a markdown fence still renders the inner markdown', async () => {
  const { doc, codeType } = await view('md-markdown-fence');

  assert.equal(codeType, 'markdown');
  assert.match(doc, /<h1[^>]*>Inner Title<\/h1>/);
});

test('an html Share wrapped in a matching html fence is still unwrapped', async () => {
  const { doc, codeType } = await view('html-html-fence');

  assert.equal(codeType, 'html');
  assert.match(doc, /<h1 id="unwrapped">/);
  assert.doesNotMatch(doc, /```html/);
});

test('an svg Share wrapped in a matching svg fence is still unwrapped', async () => {
  const { doc, codeType } = await view('svg-svg-fence');

  assert.equal(codeType, 'svg');
  assert.match(doc, /<rect id="unwrapped-rect"/);
  assert.doesNotMatch(doc, /```svg/);
});
