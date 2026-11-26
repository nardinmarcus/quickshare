const { API_CONTENT_TYPES } = require('./apiCapabilities');
const { detectCodeType, extractCodeBlocks } = require('./codeDetector');
const { renderContent, escapeHtml } = require('./contentRenderer');
const { FAVICON_VERSION } = require('./faviconVersion');

// The accepted Share content types come from the shared capabilities
// definition (T05), so /api/v1/capabilities can never advertise a type the
// creation route would reject.
const VALID_CODE_TYPES = new Set(API_CONTENT_TYPES);

function normalizeCodeType(content, requestedCodeType) {
  if (VALID_CODE_TYPES.has(requestedCodeType)) {
    return requestedCodeType;
  }

  const detectedType = detectCodeType(content);
  return VALID_CODE_TYPES.has(detectedType) ? detectedType : 'html';
}

function injectCodeTypeMeta(renderedContent, contentType) {
  if (!renderedContent.includes('</head>')) {
    return renderedContent;
  }

  return renderedContent.replace(
    '</head>',
    `<meta name="code-type" content="${escapeHtml(contentType)}">\n</head>`
  );
}

function renderSandboxedDocument(renderedContent, contentType, {
  title,
  description,
  pageUrl,
  socialImageUrl,
  viewEventUrl
} = {}) {
  const escapedContent = escapeHtml(renderedContent);
  const pageTitle = title ? `${escapeHtml(title)} - QuickShare` : 'QuickShare';
  const ogDescription = description ? escapeHtml(description) : '通过 QuickShare 分享的内容';
  const ogUrl = pageUrl ? escapeHtml(pageUrl) : '';

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="code-type" content="${escapeHtml(contentType)}">
      <title>${pageTitle}</title>
      <link rel="icon" href="/icon/web/favicon.ico?v=${FAVICON_VERSION}" sizes="any">
      <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png?v=${FAVICON_VERSION}">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png?v=${FAVICON_VERSION}">
      <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png?v=${FAVICON_VERSION}">
      <meta property="og:title" content="${pageTitle}">
      <meta property="og:description" content="${ogDescription}">
      <meta property="og:type" content="article">
      ${ogUrl ? `<meta property="og:url" content="${ogUrl}">` : ''}
      <meta property="og:image" content="${escapeHtml(socialImageUrl)}">
      <meta property="og:image:type" content="image/png">
      <meta property="og:image:width" content="512">
      <meta property="og:image:height" content="512">
      <meta property="og:image:alt" content="QuickShare Site Identity Icon">
      <meta name="twitter:card" content="summary">
      <meta name="twitter:title" content="${pageTitle}">
      <meta name="twitter:description" content="${ogDescription}">
      ${pageUrl ? '<script defer src="https://umami.namooca.com/script.js" data-website-id="c5b79d49-f1e7-46c1-87c7-b2965383c820"></script>' : ''}
      <style>
        html, body {
          width: 100%;
          height: 100%;
          margin: 0;
          background: #ffffff;
        }
        iframe {
          width: 100%;
          height: 100vh;
          border: 0;
          display: block;
        }
      </style>
    </head>
    <body>
      <iframe
        title="Shared content"
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
        referrerpolicy="no-referrer"
        srcdoc="${escapedContent}">
      </iframe>
      ${viewEventUrl ? `<script src="/js/view-event.js" data-view-event-url="${escapeHtml(viewEventUrl)}"></script>` : ''}
    </body>
    </html>
  `;
}

async function prepareSandboxContent(rawContent, requestedCodeType, markdownTheme) {
  let processedContent = rawContent;
  let contentType = normalizeCodeType(rawContent, requestedCodeType);
  const codeBlocks = extractCodeBlocks(rawContent);

  if (codeBlocks.length === 1
    && codeBlocks[0].type === contentType
    && codeBlocks[0].content.length > rawContent.length * 0.7) {
    processedContent = codeBlocks[0].content;
  }

  const renderedContent = await renderContent(processedContent, contentType, markdownTheme);

  return {
    contentType,
    renderedContent: injectCodeTypeMeta(renderedContent, contentType)
  };
}

module.exports = {
  VALID_CODE_TYPES,
  normalizeCodeType,
  prepareSandboxContent,
  renderSandboxedDocument
};
