const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown } = require('../utils/contentRenderer');

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
