const test = require('node:test');
const assert = require('node:assert/strict');

const { renderHtml, renderMarkdown } = require('../utils/contentRenderer');
const { resolveMarkdownTheme } = require('../utils/markdownThemeCatalog');

test('renderHtml loads highlighting only for partial HTML with a preformatted code block', () => {
  const plain = renderHtml('<p>Plain partial HTML</p>');
  const code = renderHtml('<pre><code>const answer = 42;</code></pre>');

  assert.doesNotMatch(plain, /highlight\.min\.js/);
  assert.doesNotMatch(plain, /atom-one-dark\.min\.css/);
  assert.equal((code.match(/highlight\.min\.js/g) || []).length, 1);
  assert.equal((code.match(/atom-one-dark\.min\.css/g) || []).length, 1);
});

test('renderHtml preserves complete documents without injecting QuickShare assets', () => {
  const documents = [
    '<!DOCTYPE html><html><head><link href="/user.css" rel="stylesheet"></head><body><script>window.userScript = true</script></body></html>',
    '<!doctype html><html><body><pre><code>lowercase doctype</code></pre></body></html>',
    '<HTML><body><pre><code>mixed case element</code></pre></body></HTML>'
  ];

  for (const document of documents) {
    const html = renderHtml(document);

    assert.equal(html, document);
    assert.doesNotMatch(html, /highlight\.min\.js/);
    assert.doesNotMatch(html, /\/css\/styles\.css/);
  }
});

test('renderMarkdown avoids heavy external assets for plain markdown', async () => {
  const html = await renderMarkdown('# Plain Report\n\nThis page has no code blocks.');

  assert.doesNotMatch(html, /mermaid\.min\.js/);
  assert.doesNotMatch(html, /highlight\.min\.js/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
});

test('renderMarkdown loads highlight assets only for non-mermaid code blocks', async () => {
  const fence = '`'.repeat(3);
  const html = await renderMarkdown(`${fence}js\nconsole.log('hello');\n${fence}`);

  assert.match(html, /highlight\.min\.js/);
  assert.match(html, /atom-one-dark\.min\.css/);
  assert.doesNotMatch(html, /mermaid\.min\.js/);
});

test('renderMarkdown loads Mermaid only when a mermaid block exists', async () => {
  const fence = '`'.repeat(3);
  const html = await renderMarkdown(`${fence}mermaid\ngraph TD\nA-->B\n${fence}`);

  assert.match(html, /mermaid\.min\.js/);
  assert.doesNotMatch(html, /highlight\.min\.js/);
});

test('renderMarkdown loads the shared baseline before one trusted signature', async () => {
  const html = await renderMarkdown('# Catalog contract', 'github');
  const baselinePosition = html.indexOf('/css/markdown-theme-baseline.css');
  const signaturePosition = html.indexOf('/css/markdown-github.css');

  assert.ok(baselinePosition >= 0);
  assert.ok(signaturePosition > baselinePosition);
  assert.equal((html.match(/markdown-theme-baseline\.css/g) || []).length, 1);
  assert.equal((html.match(/markdown-github\.css/g) || []).length, 1);
  assert.match(html, /<html[^>]+data-markdown-theme="github"/);
});

test('renderMarkdown derives light and dark wrapper metadata from the resolved Catalog entry', async () => {
  const theme = resolveMarkdownTheme('bytedance');
  const html = await renderMarkdown('# Adaptive ByteDance', 'bytedance');

  assert.match(
    html,
    new RegExp(`<meta name="theme-color" content="${theme.appearances.light.themeColor}" media="\\(prefers-color-scheme: light\\)">`)
  );
  assert.match(
    html,
    new RegExp(`<meta name="theme-color" content="${theme.appearances.dark.themeColor}" media="\\(prefers-color-scheme: dark\\)">`)
  );
  assert.match(html, new RegExp(`--theme-canvas: ${theme.appearances.light.canvas}`));
  assert.match(html, new RegExp(`--theme-canvas: ${theme.appearances.dark.canvas}`));
});

test('renderMarkdown never reflects an invalid theme into an asset URL', async () => {
  const html = await renderMarkdown('# Safe fallback', '../../admin-secret');

  assert.match(html, /data-markdown-theme="bytedance"/);
  assert.match(html, /href="\/css\/markdown-bytedance\.css"/);
  assert.doesNotMatch(html, /admin-secret/);
});
