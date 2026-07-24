const DEFAULT_MARKDOWN_THEME_ID = 'bytedance';
const MARKDOWN_THEME_BASELINE_HREF = '/css/markdown-theme-baseline.css';

// 页面底色对所有主题保持中性：主题色只做点缀（标题、链接、引用条等），
// 不再作为整个页面的大面积底色。该值与 markdown-theme-baseline.css 中的
// --theme-canvas 默认值保持一致。
const MARKDOWN_CANVAS = Object.freeze({
  light: '#f5f7fa',
  dark: '#111827'
});

function appearance(canvas, themeColor = canvas) {
  return Object.freeze({ canvas, themeColor });
}

function catalogEntry({ id, label }) {
  return Object.freeze({
    id,
    label,
    signatureHref: `/css/markdown-${id}.css`,
    appearances: Object.freeze({
      light: appearance(MARKDOWN_CANVAS.light),
      dark: appearance(MARKDOWN_CANVAS.dark)
    })
  });
}

const MARKDOWN_THEME_CATALOG = Object.freeze([
  catalogEntry({ id: 'bytedance', label: 'ByteDance 蓝绿' }),
  catalogEntry({ id: 'github', label: 'GitHub 经典' }),
  catalogEntry({ id: 'apple', label: 'Apple 极简' }),
  catalogEntry({ id: 'notion', label: 'Notion 笔记' }),
  catalogEntry({ id: 'claude', label: 'Claude 暖调' }),
  catalogEntry({ id: 'raycast', label: 'Raycast 专注' }),
  catalogEntry({ id: 'google', label: 'Google Material' }),
  catalogEntry({ id: 'tesla', label: 'Tesla 黑白' }),
  catalogEntry({ id: 'airbnb', label: 'Airbnb 暖居' }),
  catalogEntry({ id: 'bugatti', label: 'Bugatti 蓝曜' }),
  catalogEntry({ id: 'linear', label: 'Linear 精密' }),
  catalogEntry({ id: 'playstation', label: 'PlayStation 蓝境' })
]);

const CATALOG_BY_ID = new Map(MARKDOWN_THEME_CATALOG.map(theme => [theme.id, theme]));
const MARKDOWN_THEME_OPTIONS = Object.freeze(
  MARKDOWN_THEME_CATALOG.map(({ id, label, signatureHref }) => (
    Object.freeze({ id, label, signatureHref })
  ))
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
  MARKDOWN_CANVAS,
  MARKDOWN_THEME_BASELINE_HREF,
  MARKDOWN_THEME_CATALOG,
  getMarkdownThemeOptions,
  resolveMarkdownTheme,
  resolveMarkdownThemeId
};
