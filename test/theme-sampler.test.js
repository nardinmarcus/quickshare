const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.AUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'theme-sampler-secret';

const app = require('../app');
const { getMarkdownThemeOptions } = require('../utils/markdownThemeCatalog');

let server;
let baseUrl;

function request(route) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(route, baseUrl), (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
  });
}

test.before(async () => {
  await app.locals.pageRepository.create({
    id: 'sampler-markdown',
    htmlContent: '# Stored Markdown',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'markdown',
    title: 'Sampler Markdown',
    description: null,
    expiresAt: null,
    markdownTheme: 'github'
  });
  await app.locals.pageRepository.create({
    id: 'sampler-html',
    htmlContent: '<h1>Stored HTML</h1>',
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: 'Sampler HTML',
    description: null,
    expiresAt: null,
    markdownTheme: null
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

test('homepage projects every Catalog option into one labeled fixed Sampler', async () => {
  const homepage = await request('/');

  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /id="markdown-theme-selector"[^>]+hidden/);
  assert.match(homepage.text, /<label[^>]+for="markdown-theme"[^>]*>Markdown 主题<\/label>/);
  assert.match(homepage.text, /id="markdown-theme"[^>]+aria-controls="markdown-theme-sampler"/);
  assert.match(homepage.text, /data-theme-sampler[^>]+aria-label="ByteDance 蓝绿主题样例"/);
  assert.match(homepage.text, /id="markdown-theme-sampler"[^>]+data-theme-sampler-frame[^>]+title="ByteDance 蓝绿主题样例"[^>]+tabindex="-1"/);
  assert.match(homepage.text, /src="\/js\/theme-sampler\.js"/);

  for (const { id } of getMarkdownThemeOptions()) {
    assert.match(
      homepage.text,
      new RegExp(
        `<option\\b(?=[^>]*value="${id}")(?=[^>]*data-signature-href="/css/markdown-${id}\\.css")[^>]*>`
      )
    );
  }
});

test('homepage renders the fixed Theme Sampler as a compact five-part identification sample', async () => {
  const homepage = await request('/');
  const statusTag = homepage.text.match(/<p[^>]*data-theme-sampler-status[^>]*>/)[0];
  const frameTag = homepage.text.match(/<iframe[^>]*data-theme-sampler-frame[^>]*>/)[0];

  assert.equal(homepage.status, 200);
  assert.match(homepage.text, />主题样例</);
  assert.doesNotMatch(statusTag, /\bhidden\b/);
  assert.match(frameTag, /\bhidden\b/);

  for (const role of ['heading', 'body', 'link', 'quotation', 'fenced-code', 'table']) {
    assert.match(homepage.text, new RegExp(`data-sample-role="${role}"`));
  }

  for (const removedRole of ['emphasis', 'list', 'inline-code', 'task', 'keyboard', 'image', 'divider', 'diagram']) {
    assert.doesNotMatch(homepage.text, new RegExp(`data-sample-role="${removedRole}"`));
  }
});

test('homepage groups editing, theme choice, and publishing controls into one ordered workbench', async () => {
  const homepage = await request('/');
  const workbenchStart = homepage.text.indexOf('id="publishing-workbench"');
  const editorPosition = homepage.text.indexOf('class="publishing-editor"');
  const samplerPosition = homepage.text.indexOf('id="markdown-theme-selector"');
  const controlsPosition = homepage.text.indexOf('class="publishing-controls"');
  const settingsPosition = homepage.text.indexOf('id="publish-settings"');
  const publishPosition = homepage.text.indexOf('id="generate-button"');

  assert.equal(homepage.status, 200);
  assert.ok(workbenchStart >= 0);
  assert.ok(workbenchStart < editorPosition);
  assert.ok(editorPosition < samplerPosition);
  assert.ok(samplerPosition < controlsPosition);
  assert.ok(controlsPosition < settingsPosition);
  assert.ok(settingsPosition < publishPosition);
});

test('the fixed sample remains read-only and runtime-free', () => {
  const sampler = fs.readFileSync(
    path.join(__dirname, '../views/partials/theme-sampler.ejs'),
    'utf8'
  );

  assert.doesNotMatch(sampler, /textarea|contenteditable|html-input|rendered-preview/i);
  assert.doesNotMatch(sampler, /https?:\/\/|mermaid(?:\.min)?\.js|highlight(?:\.min)?\.js/i);
});

test('Sampler controller validates only trusted local styles and never requests full preview', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '../public/js/theme-sampler.js'),
    'utf8'
  );

  assert.match(script, /selectedOptions\[0\]/);
  assert.match(script, /dataset\.signatureHref/);
  assert.match(script, /\/css\/markdown-theme-baseline\.css/);
  assert.match(script, /fetch\(href/);
  assert.match(script, /frame\.srcdoc/);
  assert.match(script, /frame\.title/);
  assert.doesNotMatch(script, /\/api\/pages\/preview|html-input|content-textarea/i);
  assert.doesNotMatch(script, /https?:\/\/|mermaid|hljs|highlight\.js/i);

  const claudeSignature = fs.readFileSync(
    path.join(__dirname, '../public/css/markdown-claude.css'),
    'utf8'
  );
  assert.doesNotMatch(claudeSignature, /@import|https?:\/\//i);
});

test('Sampler rendering failure exposes an inline status without disabling theme choice', async () => {
  const homepage = await request('/');
  const script = fs.readFileSync(
    path.join(__dirname, '../public/js/theme-sampler.js'),
    'utf8'
  );
  const status = { hidden: false, textContent: '样例暂不可用' };
  let srcdocWrites = 0;
  const frame = {
    hidden: true,
    title: '',
    set srcdoc(value) {
      srcdocWrites += value.length > 0 ? 1 : 0;
    }
  };
  const template = { innerHTML: '<p>fixed sample</p>' };
  const option = {
    dataset: {
      themeLabel: 'ByteDance 蓝绿',
      signatureHref: '/css/markdown-bytedance.css'
    },
    textContent: 'ByteDance 蓝绿'
  };
  const select = { id: 'markdown-theme', selectedOptions: [option], disabled: false };
  const root = {
    dataset: { selectId: select.id },
    setAttribute() {},
    querySelector(selector) {
      if (selector === '[data-theme-sampler-frame]') return frame;
      if (selector === '[data-theme-sampler-template]') return template;
      if (selector === '[data-theme-sampler-status]') return status;
      return null;
    }
  };
  let exposeRoot = false;
  const document = {
    getElementById(id) {
      return id === select.id ? select : null;
    },
    querySelectorAll() {
      return exposeRoot ? [root] : [];
    }
  };
  const window = {};
  const fetch = async () => ({ ok: false, status: 404, text: async () => '' });

  assert.match(homepage.text, /data-theme-sampler-status[^>]+role="status"[^>]*>样例暂不可用</);
  vm.runInNewContext(script, { document, fetch, window });
  exposeRoot = true;
  const updatePromise = window.ThemeSampler.updateForSelect(select);

  assert.equal(status.hidden, true);
  assert.equal(frame.hidden, false);
  assert.equal(srcdocWrites, 1);

  await updatePromise;

  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '样例暂不可用');
  assert.equal(frame.hidden, true);
  assert.equal(select.disabled, false);
  assert.equal(srcdocWrites, 1);
});

test('homepage preference is validated against Catalog options and storage failures are silent', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');

  assert.match(script, /quickshare:creator-markdown-theme/);
  assert.match(script, /localStorage\.getItem/);
  assert.match(script, /localStorage\.setItem/);
  assert.match(script, /catch \(error\) \{[\s\S]*?return 'bytedance';/);
  assert.match(script, /Array\.from\(markdownThemeSelect\.options\)/);
  assert.match(script, /option\.value === value/);
  assert.doesNotMatch(script, /JSON\.parse\([^)]*localStorage/);
});

test('admin Markdown edit uses stored theme and Sampler without Creator Theme Preference', async () => {
  const [markdown, html] = await Promise.all([
    request('/admin/pages/sampler-markdown'),
    request('/admin/pages/sampler-html')
  ]);
  const adminScript = fs.readFileSync(
    path.join(__dirname, '../public/js/admin-detail.js'),
    'utf8'
  );

  assert.equal(markdown.status, 200);
  assert.match(
    markdown.text,
    /<option\b(?=[^>]*value="github")(?=[^>]*selected)[^>]*>GitHub 经典<\/option>/
  );
  assert.match(markdown.text, /data-theme-sampler[^>]+aria-label="GitHub 经典主题样例"/);
  assert.match(markdown.text, /src="\/js\/theme-sampler\.js"/);
  assert.doesNotMatch(html.text, /data-theme-sampler/);
  assert.doesNotMatch(adminScript, /localStorage|quickshare:creator-markdown-theme/);
});

test('site CSS keeps the sampler compact and focused at 375 px', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/theme-sampler.js'), 'utf8');

  assert.match(css, /\.theme-sampler-settings\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.theme-sampler-settings\.hidden\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.theme-select:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /#theme-field \.theme-select:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /\.theme-sampler-frame\s*\{[^}]*width:\s*100%[^}]*border:/s);
  assert.match(
    css,
    /@media \(max-width:\s*480px\)[\s\S]*?\.theme-sampler-settings\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
  );
  assert.match(
    script,
    /\.markdown-body\.theme-sampler-body\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.doesNotMatch(script, /theme-sampler-(?:diagram|image|assets|grid)/);
});

test('homepage CSS gives the visible Theme Sampler a bounded 1024 px workbench column', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');

  assert.match(
    css,
    /@media \(min-width:\s*1024px\)[\s\S]*?\.publishing-workbench:has\(\.markdown-theme-selector:not\(\.hidden\)\)\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(300px,\s*320px\)/s
  );
  assert.match(
    css,
    /@media \(min-width:\s*1024px\)[\s\S]*?\.markdown-theme-selector\s*\{[^}]*position:\s*sticky[^}]*max-width:\s*340px/s
  );
  assert.match(
    css,
    /\[data-page="home-page"\] \.markdown-theme-selector \.theme-sampler-frame\s*\{[^}]*height:\s*200px/s
  );
  assert.doesNotMatch(css, /\.theme-sampler-frame\s*\{[^}]*height:\s*(?:440|650)px/s);
});
