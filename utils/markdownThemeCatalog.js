const DEFAULT_MARKDOWN_THEME_ID = 'bytedance';
const MARKDOWN_THEME_BASELINE_HREF = '/css/markdown-theme-baseline.css';

function appearance(canvas, themeColor = canvas) {
  return Object.freeze({ canvas, themeColor });
}

function catalogEntry({ id, label, light, dark }) {
  return Object.freeze({
    id,
    label,
    signatureHref: `/css/markdown-${id}.css`,
    appearances: Object.freeze({
      light: appearance(light),
      dark: appearance(dark)
    })
  });
}

const MARKDOWN_THEME_CATALOG = Object.freeze([
  catalogEntry({ id: 'bytedance', label: 'ByteDance 蓝绿', light: '#f5f7fa', dark: '#111827' }),
  catalogEntry({ id: 'github', label: 'GitHub 经典', light: '#ffffff', dark: '#ffffff' }),
  catalogEntry({ id: 'apple', label: 'Apple 极简', light: '#ffffff', dark: '#ffffff' }),
  catalogEntry({ id: 'notion', label: 'Notion 笔记', light: '#ffffff', dark: '#ffffff' }),
  catalogEntry({ id: 'claude', label: 'Claude 暖调', light: '#faf9f5', dark: '#faf9f5' })
]);

const CATALOG_BY_ID = new Map(MARKDOWN_THEME_CATALOG.map(theme => [theme.id, theme]));
const MARKDOWN_THEME_OPTIONS = Object.freeze(
  MARKDOWN_THEME_CATALOG.map(({ id, label }) => Object.freeze({ id, label }))
);

function resolveMarkdownThemeId(value) {
  return typeof value === 'string' && CATALOG_BY_ID.has(value)
    ? value
    : DEFAULT_MARKDOWN_THEME_ID;
}

function resolveMarkdownTheme(value) {
  return CATALOG_BY_ID.get(resolveMarkdownThemeId(value));
}

function getMarkdownThemeOptions() {
  return MARKDOWN_THEME_OPTIONS;
}

module.exports = {
  DEFAULT_MARKDOWN_THEME_ID,
  MARKDOWN_THEME_BASELINE_HREF,
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme,
  resolveMarkdownThemeId
};
