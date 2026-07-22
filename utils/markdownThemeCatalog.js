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
  catalogEntry({ id: 'github', label: 'GitHub 经典', light: '#ffffff', dark: '#0d1117' }),
  catalogEntry({ id: 'apple', label: 'Apple 极简', light: '#ffffff', dark: '#000000' }),
  catalogEntry({ id: 'notion', label: 'Notion 笔记', light: '#fbfbfa', dark: '#191919' }),
  catalogEntry({ id: 'claude', label: 'Claude 暖调', light: '#faf7f2', dark: '#211e1a' }),
  catalogEntry({ id: 'raycast', label: 'Raycast 专注', light: '#f4f1f6', dark: '#151119' }),
  catalogEntry({ id: 'google', label: 'Google Material', light: '#f8fafd', dark: '#111318' }),
  catalogEntry({ id: 'airbnb', label: 'Airbnb 暖居', light: '#fff8f2', dark: '#211a18' }),
  catalogEntry({ id: 'linear', label: 'Linear 精密', light: '#f7f8fb', dark: '#17191f' })
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
