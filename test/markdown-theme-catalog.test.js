const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_MARKDOWN_THEME_ID,
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme,
  resolveMarkdownThemeId
} = require('../utils/markdownThemeCatalog');

const EXPECTED_THEMES = [
  ['bytedance', 'ByteDance 蓝绿'],
  ['github', 'GitHub 经典'],
  ['apple', 'Apple 极简'],
  ['notion', 'Notion 笔记'],
  ['claude', 'Claude 暖调'],
  ['raycast', 'Raycast 专注'],
  ['google', 'Google Material'],
  ['tesla', 'Tesla 黑白'],
  ['airbnb', 'Airbnb 暖居'],
  ['bugatti', 'Bugatti 蓝曜'],
  ['linear', 'Linear 精密'],
  ['playstation', 'PlayStation 蓝境']
];

test('Catalog owns the ordered existing theme identities and trusted assets', () => {
  assert.equal(DEFAULT_MARKDOWN_THEME_ID, 'bytedance');
  assert.deepEqual(
    MARKDOWN_THEME_CATALOG.map(({ id, label }) => [id, label]),
    EXPECTED_THEMES
  );
  assert.equal(new Set(MARKDOWN_THEME_CATALOG.map(({ id }) => id)).size, EXPECTED_THEMES.length);
  assert.equal(Object.isFrozen(MARKDOWN_THEME_CATALOG), true);

  for (const theme of MARKDOWN_THEME_CATALOG) {
    assert.equal(Object.isFrozen(theme), true);
    assert.match(theme.signatureHref, /^\/css\/markdown-[a-z]+\.css$/);
    assert.deepEqual(Object.keys(theme.appearances), ['light', 'dark']);

    for (const appearance of Object.values(theme.appearances)) {
      assert.match(appearance.canvas, /^#[0-9a-f]{6}$/i);
      assert.match(appearance.themeColor, /^#[0-9a-f]{6}$/i);
    }
  }
});

test('Catalog exposes a minimal immutable selector projection', () => {
  const options = getMarkdownThemeOptions();

  assert.deepEqual(options, EXPECTED_THEMES.map(([id, label]) => ({ id, label })));
  assert.equal(Object.isFrozen(options), true);
  assert.equal(options.every(Object.isFrozen), true);
  assert.equal('signatureHref' in options[0], false);
  assert.equal('appearances' in options[0], false);
});

test('Catalog resolves every invalid or legacy request to ByteDance', () => {
  for (const value of [undefined, null, '', 'random', 'legacy-theme', '../admin.css', {}, []]) {
    assert.equal(resolveMarkdownThemeId(value), 'bytedance');
    assert.equal(resolveMarkdownTheme(value).id, 'bytedance');
  }

  for (const [id] of EXPECTED_THEMES) {
    assert.equal(resolveMarkdownThemeId(id), id);
    assert.equal(resolveMarkdownTheme(id).id, id);
  }
});

test('shared baseline owns reading containment while ByteDance owns only its signature', () => {
  const baseline = fs.readFileSync(
    path.join(__dirname, '../public/css/markdown-theme-baseline.css'),
    'utf8'
  );
  const bytedance = fs.readFileSync(
    path.join(__dirname, '../public/css/markdown-bytedance.css'),
    'utf8'
  );

  assert.match(baseline, /box-sizing:\s*border-box/);
  assert.match(baseline, /\.markdown-body\s*>\s*\*\s*\{[^}]*min-width:\s*0/s);
  assert.match(baseline, /\.markdown-body\s+:where\(pre, table, \.mermaid/);
  assert.match(baseline, /:focus-visible/);
  assert.match(baseline, /@media \(max-width:\s*480px\)/);
  for (const token of [
    'canvas',
    'text',
    'muted',
    'accent',
    'link',
    'border',
    'quote-surface',
    'table-surface',
    'diagram-surface',
    'diagram-text',
    'diagram-node-surface',
    'diagram-node-border',
    'diagram-line',
    'diagram-label-surface',
    'code-text',
    'code-surface',
    'focus',
    'heading-on-accent'
  ]) {
    assert.match(baseline, new RegExp(`--theme-${token}:`));
  }
  assert.match(baseline, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.match(baseline, /\.hljs-keyword/);
  assert.match(baseline, /\.mermaid :where\(\.node rect/);
  assert.doesNotMatch(baseline, /#1677ff|#05d4cd/);

  assert.match(bytedance, /--theme-accent:\s*#1677ff/i);
  assert.match(bytedance, /--theme-secondary:\s*#008f8a/i);
  assert.match(bytedance, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.doesNotMatch(bytedance, /@import|fonts\.googleapis\.com|filter:\s*blur|content:\s*["']u[0-9a-f]{4}/i);
});
