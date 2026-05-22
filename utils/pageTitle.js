const VALID_TITLE_CODE_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);

function normalizeTitle(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
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
  derivePageTitle
};
