const VALID_TITLE_CODE_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);

function normalizeTitle(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) {
    return normalized;
  }

  // Keep the established 160 code-unit cap, but never split a UTF-16
  // surrogate pair: a lone high surrogate cannot be encoded as UTF-8 and
  // would corrupt the title on its way into PostgreSQL (and every client
  // that round-trips the bytes). Back off one code unit so the pair
  // stays complete; the raw content is never truncated by this rule.
  const cut = normalized.slice(0, 160);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

function decodeBasicHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value) {
  return decodeBasicHtmlEntities(value.replace(/<[^>]*>/g, ' '));
}

function extractTagText(content, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = content.match(pattern);

  return match ? normalizeTitle(stripHtmlTags(match[1])) : '';
}

function extractMarkdownTitle(content) {
  const heading = content
    .split(/\r?\n/)
    .map(line => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .find(Boolean);

  return normalizeTitle(heading || '');
}

function extractMermaidTitle(content) {
  const line = content
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value && !value.startsWith('%%'));

  return normalizeTitle(line || '');
}

function titleFallback(codeType, createdAt) {
  const label = {
    html: 'HTML Share',
    markdown: 'Markdown Share',
    svg: 'SVG Share',
    mermaid: 'Mermaid Share'
  }[codeType] || 'QuickShare Page';

  return `${label} ${new Date(createdAt).toISOString().slice(0, 10)}`;
}

function derivePageTitle(content, codeType, requestedTitle, createdAt) {
  const explicitTitle = normalizeTitle(requestedTitle);

  if (explicitTitle) {
    return explicitTitle;
  }

  const normalizedCodeType = VALID_TITLE_CODE_TYPES.has(codeType) ? codeType : 'html';
  const candidates = normalizedCodeType === 'markdown'
    ? [extractMarkdownTitle(content)]
    : normalizedCodeType === 'svg'
      ? [extractTagText(content, 'title')]
      : normalizedCodeType === 'mermaid'
        ? [extractMermaidTitle(content)]
        : [
            extractTagText(content, 'title'),
            extractTagText(content, 'h1'),
            extractTagText(content, 'h2')
          ];

  return candidates.find(Boolean) || titleFallback(normalizedCodeType, createdAt);
}

module.exports = {
  derivePageTitle,
  normalizeTitle
};
