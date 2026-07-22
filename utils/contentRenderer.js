/**
 * u5185u5bb9u6e32u67d3u5de5u5177
 * u7528u4e8eu6e32u67d3u4e0du540cu7c7bu578bu7684u5185u5bb9uff08HTMLu3001Markdownu3001SVGu3001Mermaiduff09
 */

const { marked } = require('marked');
const { CODE_TYPES } = require('./codeDetector');
const {
  MARKDOWN_THEME_BASELINE_HREF,
  resolveMarkdownTheme
} = require('./markdownThemeCatalog');

const MERMAID_THEME_CSS = `
  .node rect, .node circle, .node polygon { rx: 10; ry: 10; }
  .edgePath .path { stroke-linecap: round; stroke-linejoin: round; }
  .label { font-weight: 500; }
  .cluster rect { rx: 12; }
`;

const STANDALONE_MERMAID_LIGHT_THEME = {
  darkMode: false,
  background: '#ffffff',
  primaryColor: '#eef2ff',
  primaryTextColor: '#1e293b',
  primaryBorderColor: '#6366f1',
  secondaryColor: '#f0fdf4',
  tertiaryColor: '#f8fafc',
  lineColor: '#94a3b8',
  clusterBorder: '#e2e8f0',
  defaultLinkColor: '#6366f1',
  titleColor: '#0f172a'
};

const STANDALONE_MERMAID_DARK_THEME = {
  darkMode: true,
  background: '#0f172a',
  primaryColor: '#1e293b',
  primaryTextColor: '#e2e8f0',
  primaryBorderColor: '#6366f1',
  secondaryColor: '#1e3a5f',
  tertiaryColor: '#0f172a',
  lineColor: '#64748b',
  clusterBorder: '#334155',
  defaultLinkColor: '#818cf8',
  titleColor: '#f1f5f9'
};

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.6.0/dist/mermaid.min.js';
const HIGHLIGHT_CSS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css';
const HIGHLIGHT_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js';

const MERMAID_PATTERNS = [
  /^(graph|flowchart)\s+(TB|TD|BT|RL|LR)\b/m,
  /^sequenceDiagram\b/m,
  /^classDiagram\b/m,
  /^stateDiagram(-v2)?\b/m,
  /^erDiagram\b/m,
  /^gantt\b/m,
  /^pie\b/m,
  /^journey\b/m,
  /^gitGraph\b/m,
  /^mindmap\b/m,
  /^timeline\b/m,
  /^C4Context\b/m
];

function debugLog(...args) {
  if (process.env.DEBUG_RENDERER === 'true') {
    console.log(...args);
  }
}

function isMermaidCode(code) {
  return MERMAID_PATTERNS.some(pattern => pattern.test(code));
}

function normalizeCodeRendererArgs(args) {
  const [first, language, isEscaped] = args;

  if (first && typeof first === 'object') {
    return {
      code: first.text || '',
      language: first.lang || '',
      isEscaped: Boolean(first.escaped)
    };
  }

  return {
    code: first || '',
    language: language || '',
    isEscaped: Boolean(isEscaped)
  };
}

/**
 * u6e32u67d3HTMLu5185u5bb9
 * @param {string} content - HTMLu5185u5bb9
 * @returns {string} - u5904u7406u540eu7684HTML
 */
function renderHtml(content) {
  const trimmedContent = content.trimStart();

  // u5982u679cu662fu5b8cu6574u7684HTMLu6587u6863uff0cu76f4u63a5u8fd4u56de
  if (/^<!doctype\s+html\b/i.test(trimmedContent) || /^<html\b/i.test(trimmedContent)) {
    return content;
  }
  
  const usesCodeHighlight = /<pre\b[^>]*>[\s\S]*?<code\b[^>]*>/i.test(content);
  const highlightStylesheet = usesCodeHighlight
    ? `<link rel="stylesheet" href="${HIGHLIGHT_CSS_CDN}">`
    : '';
  const highlightScript = usesCodeHighlight
    ? `
      <script src="${HIGHLIGHT_JS_CDN}"></script>
      <script>
        document.addEventListener('DOMContentLoaded', () => {
          if (window.hljs) {
            document.querySelectorAll('pre code').forEach((block) => {
              hljs.highlightElement(block);
            });
          }
        });
      </script>`
    : '';

  // u5982u679cu4e0du662fu5b8cu6574u7684HTMLu6587u6863uff0cu6dfbu52a0u57fau672cu7684HTMLu7ed3u6784
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QuickShare 查看器</title>
      
      <!-- 网站图标 -->
      <link rel="icon" href="/icon/web/favicon.ico" sizes="any">
      <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png">
      <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png">
      <meta name="theme-color" content="#6366f1">
      
      <!-- iOS 特殊设置 -->
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
      <meta name="apple-mobile-web-app-title" content="QuickShare">
      
      <link rel="stylesheet" href="/css/styles.css">
      ${highlightStylesheet}
      <style>
        body {
          font-family: 'Roboto', sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 1000px;
          margin: 0 auto;
          padding: 20px;
        }
        .container {
          background-color: white;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          padding: 30px;
          margin-top: 20px;
        }
        @media (prefers-color-scheme: dark) {
          body {
            background-color: #1a1a1a;
            color: #e6e6e6;
          }
          .container {
            background-color: #2a2a2a;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        ${content}
      </div>
      ${highlightScript}
    </body>
    </html>
  `;
}

/**
 * u6e32u67d3Markdownu5185u5bb9
 * @param {string} content - Markdownu5185u5bb9
 * @returns {string} - u6e32u67d3u540eu7684HTML
 */
async function renderMarkdown(content, theme) {
  const resolvedTheme = resolveMarkdownTheme(theme);
  const themeCss = resolvedTheme.signatureHref;
  // 预处理内容，处理独立的 Mermaid 代码
  const processedContent = await preprocessMarkdown(content);
  
  // 如果是独立的 Mermaid 代码，直接返回预处理结果
  if (processedContent.markdown.startsWith('<div class="mermaid">')) {
    return processedContent.markdown;
  }
  
  // 配置Marked选项
  marked.setOptions({
    gfm: true,
    breaks: true,
    smartLists: true,
    smartypants: true
  });
  
  // 自定义 renderer 来处理代码块
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code.bind(renderer);
  
  // 重写代码块渲染器
  renderer.code = function(...args) {
    const { code, language } = normalizeCodeRendererArgs(args);
    const normalizedLanguage = String(language || '').toLowerCase();

    // 如果是 Mermaid 代码或语言标记为 mermaid
    if (normalizedLanguage === 'mermaid' || isMermaidCode(code)) {
      return `<div class="mermaid">${escapeHtml(code)}</div>`;
    }
    
    // 如果是 SVG 代码
    if (normalizedLanguage === 'svg') {
      return `<div class="embedded-svg-container">${code}</div>`;
    }
    
    // 否则使用原始渲染器
    return originalCodeRenderer(...args);
  };
  
  // 使用自定义渲染器
  marked.setOptions({ renderer });
  
  // 将Markdown转换为HTML
  const htmlContent = marked.parse(content);
  const usesMermaid = htmlContent.includes('class="mermaid"') || htmlContent.includes("class='mermaid'");
  const usesCodeHighlight = htmlContent.includes('<pre><code');
  
  // 使用与 renderMermaid 一致的 Mermaid CDN 版本
  const mermaidScript = `
  <script src="${MERMAID_CDN}"></script>
  <script>
    // 配置 Mermaid
    document.addEventListener('DOMContentLoaded', function() {
      const appearanceQuery = window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : { matches: false };

      try {
        const themeToken = function(name, fallback) {
          const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          return value || fallback;
        };

        const mermaidThemeVariables = function() {
          return {
            darkMode: appearanceQuery.matches,
            background: themeToken('--theme-diagram-surface', '#ffffff'),
            fontFamily: themeToken('--theme-font-family', 'ui-sans-serif, system-ui, sans-serif'),
            fontSize: '14px',
            primaryColor: themeToken('--theme-diagram-node-surface', '#f1f5f9'),
            primaryTextColor: themeToken('--theme-diagram-text', '#243147'),
            primaryBorderColor: themeToken('--theme-diagram-node-border', '#2563eb'),
            secondaryColor: themeToken('--theme-quote-surface', '#f1f5f9'),
            tertiaryColor: themeToken('--theme-table-surface', '#ffffff'),
            lineColor: themeToken('--theme-diagram-line', '#64748b'),
            mainBkg: themeToken('--theme-diagram-node-surface', '#f1f5f9'),
            nodeBorder: themeToken('--theme-diagram-node-border', '#2563eb'),
            clusterBkg: themeToken('--theme-table-surface', '#ffffff'),
            clusterBorder: themeToken('--theme-border', '#cbd5e1'),
            defaultLinkColor: themeToken('--theme-link', '#095fba'),
            titleColor: themeToken('--theme-text', '#243147'),
            edgeLabelBackground: themeToken('--theme-diagram-label-surface', '#ffffff'),
            nodeTextColor: themeToken('--theme-diagram-text', '#243147'),
            useGradient: false,
            radius: 8,
            strokeWidth: 2
          };
        };

        const mermaidConfig = function(startOnLoad) {
          return {
            startOnLoad: startOnLoad,
            securityLevel: 'loose',
            theme: 'base',
            themeVariables: mermaidThemeVariables(),
            themeCSS: ${JSON.stringify(MERMAID_THEME_CSS)},
            look: 'neo',
            flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'rounded' },
            sequence: { useMaxWidth: true },
            gantt: { useMaxWidth: true },
            er: { useMaxWidth: true },
            pie: { useMaxWidth: true }
          };
        };

        // 将 <pre><code class="language-mermaid"> 转换为 <div class="mermaid">
        const convertMermaidCodeBlocks = function() {
          const codeBlocks = document.querySelectorAll('pre code.language-mermaid');
          console.log('Found ' + codeBlocks.length + ' Mermaid code blocks to convert');

          codeBlocks.forEach(function(codeBlock, index) {
            // 获取 Mermaid 代码
            const code = codeBlock.textContent;
            const pre = codeBlock.parentNode;

            // 创建新的 div.mermaid 元素
            const mermaidDiv = document.createElement('div');
            mermaidDiv.className = 'mermaid';
            mermaidDiv.id = 'mermaid-converted-' + index;
            mermaidDiv.textContent = code;

            // 替换 pre 元素
            if (pre && pre.parentNode) {
              pre.parentNode.replaceChild(mermaidDiv, pre);
              console.log('Converted Mermaid code block #' + index);
            }
          });

          return codeBlocks.length > 0;
        };

        // 首先转换代码块
        convertMermaidCodeBlocks();

        document.querySelectorAll('.mermaid').forEach(function(el) {
          if (!el.dataset.mermaidSource) {
            el.dataset.mermaidSource = el.textContent;
          }
        });

        mermaid.initialize(mermaidConfig(true));

        const rerenderForAppearance = function() {
          const nodes = Array.from(document.querySelectorAll('.mermaid'));

          nodes.forEach(function(el) {
            if (el.dataset.mermaidSource) {
              el.removeAttribute('data-processed');
              el.textContent = el.dataset.mermaidSource;
              el.classList.remove('mermaid-error');
            }
          });

          mermaid.initialize(mermaidConfig(false));

          if (typeof mermaid.run === 'function') {
            Promise.resolve(mermaid.run({ nodes: nodes })).catch(function(error) {
              console.error('Failed to rerender Mermaid after appearance change:', error);
            });
          } else if (typeof mermaid.init === 'function') {
            nodes.forEach(function(el) { mermaid.init(undefined, el); });
          }
        };

        if (typeof appearanceQuery.addEventListener === 'function') {
          appearanceQuery.addEventListener('change', rerenderForAppearance);
        } else if (typeof appearanceQuery.addListener === 'function') {
          appearanceQuery.addListener(rerenderForAppearance);
        }
        
        // 定时检查是否有未渲染的 Mermaid 元素
        setTimeout(function checkMermaidElements() {
          // 再次转换代码块，以防动态加载的内容
          const hasNewCodeBlocks = convertMermaidCodeBlocks();
          
          const mermaidElements = document.querySelectorAll('.mermaid');
          console.log('Found ' + mermaidElements.length + ' Mermaid elements in total');
          
          let hasUnrenderedElements = hasNewCodeBlocks; // 如果有新转换的代码块，就需要继续尝试渲染
          
          // 检查是否有未渲染的 Mermaid 元素
          mermaidElements.forEach(function(el) {
            if (el.querySelector('svg') === null && !el.classList.contains('mermaid-error')) {
              hasUnrenderedElements = true;
              console.log('Found unrendered Mermaid element, trying to render manually');
              try {
                // 尝试使用不同版本的 API
                if (typeof mermaid.init === 'function') {
                  mermaid.init(undefined, el);
                } else if (typeof mermaid.run === 'function') {
                  mermaid.run({ nodes: [el] });
                }
              } catch (err) {
                console.error('Failed to render Mermaid diagram:', err);
                // 显示原始代码
                el.innerHTML = '<pre>' + el.textContent + '</pre>';
                el.classList.add('mermaid-error');
              }
            }
          });
          
          // 如果还有未渲染的元素，继续尝试
          if (hasUnrenderedElements) {
            setTimeout(checkMermaidElements, 1000);
          }
        }, 500);
      } catch (e) {
        console.error('Error initializing Mermaid:', e);
      }
    });
  </script>
  `;
  
  // 添加 Mermaid 相关的 CSS 样式
  const mermaidStyles = `
  <style>
    .mermaid {
      margin: 20px 0;
      text-align: center;
      overflow: auto;
      padding: 10px;
      border-radius: 8px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .mermaid-error {
      margin: 20px 0;
      padding: 10px;
      border-radius: 5px;
      background-color: #fff0f0;
      border: 1px solid #ffcccc;
      color: #cc0000;
    }

    @media (prefers-color-scheme: dark) {
      .mermaid-error {
        background-color: #3a2222;
        border-color: #662222;
        color: #ff6666;
      }
    }
  </style>
  `;

  const mermaidAssets = usesMermaid ? `${mermaidStyles}
      ${mermaidScript}` : '';
  const highlightScript = usesCodeHighlight
    ? `
      <script src="${HIGHLIGHT_JS_CDN}"></script>
      <script>
        document.addEventListener('DOMContentLoaded', () => {
          if (window.hljs) {
            document.querySelectorAll('pre code').forEach((block) => {
              hljs.highlightElement(block);
            });
          }
        });
      </script>`
    : '';

  // 添加嵌入内容的样式
  const embeddedStyles = `
    .embedded-svg-container {
      margin: 20px 0;
      overflow: auto;
      max-width: 100%;
    }
    .embedded-mermaid-container {
      margin: 20px 0;
      text-align: center;
    }
    .mermaid {
      margin: 20px 0;
      text-align: center;
    }
  `;

  // 返回带有字节跳动风格的HTML
  return `
    <!DOCTYPE html>
    <html lang="zh-CN" data-markdown-theme="${resolvedTheme.id}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QuickShare Markdown查看器</title>
      
      <!-- 网站图标 -->
      <link rel="icon" href="/icon/web/favicon.ico" sizes="any">
      <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png">
      <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png">
      <meta name="theme-color" content="${resolvedTheme.appearances.light.themeColor}" media="(prefers-color-scheme: light)">
      <meta name="theme-color" content="${resolvedTheme.appearances.dark.themeColor}" media="(prefers-color-scheme: dark)">
      
      <!-- iOS 特殊设置 -->
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
      <meta name="apple-mobile-web-app-title" content="QuickShare">
      
      <link rel="stylesheet" href="${MARKDOWN_THEME_BASELINE_HREF}">
      <link rel="stylesheet" href="${themeCss}">
      <style>
        :root {
          --theme-canvas: ${resolvedTheme.appearances.light.canvas};
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --theme-canvas: ${resolvedTheme.appearances.dark.canvas};
          }
        }
        ${embeddedStyles}
      </style>
      ${mermaidAssets}
    </head>
    <body>
      <div class="markdown-body">
        ${htmlContent}
      </div>
      ${highlightScript}
    </body>
    </html>
  `;
}

/**
 * u6e32u67d3SVGu5185u5bb9
 * @param {string} content - SVGu5185u5bb9
 * @returns {string} - u5305u542bSVGu7684HTML
 */
function renderSvg(content) {
  // u5982u679cu662fu5355u72ecu7684SVGu6587u4ef6uff0cu5c06u5176u5d4cu5165u5230HTMLu4e2d
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QuickShare SVG查看器</title>
      
      <!-- 网站图标 -->
      <link rel="icon" href="/icon/web/favicon.ico" sizes="any">
      <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png">
      <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png">
      <meta name="theme-color" content="#6366f1">
      
      <!-- iOS 特殊设置 -->
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
      <meta name="apple-mobile-web-app-title" content="QuickShare">
      
      <style>
        body {
          font-family: 'Roboto', sans-serif;
          line-height: 1.6;
          color: #333;
          margin: 0;
          padding: 20px;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background-color: #f5f5f7;
        }
        .svg-container {
          max-width: 100%;
          overflow: auto;
          background-color: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        svg {
          display: block;
          max-width: 100%;
          height: auto;
        }
        @media (prefers-color-scheme: dark) {
          body {
            background-color: #1a1a1a;
            color: #e6e6e6;
          }
          .svg-container {
            background-color: #2a2a2a;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          }
        }
      </style>
    </head>
    <body>
      <div class="svg-container">
        ${content}
      </div>
    </body>
    </html>
  `;
}

/**
 * u6e32u67d3Mermaidu56feu8868
 * @param {string} content - Mermaidu8bedu6cd5u7684u5185u5bb9
 * @returns {Promise<string>} - u6e32u67d3u540eu7684HTML
 */
async function renderMermaid(content) {
  debugLog('[DEBUG] renderMermaid 被调用');
  debugLog(`[DEBUG] Mermaid 原始内容长度: ${content.length}`);
  debugLog(`[DEBUG] Mermaid 原始内容前100字符: ${content.substring(0, 100)}...`);
  
  try {
    // 处理可能的Markdown包裹
    let mermaidCode = content;
    
    // 检查是否是纯 Mermaid 语法（不带 ```mermaid 标记）
    const mermaidPatterns = [
      /^\s*graph\s+[A-Za-z\s]/i,        // 流程图
      /^\s*flowchart\s+[A-Za-z\s]/i,    // 流程图 (新语法)
      /^\s*sequenceDiagram/i,           // 序列图
      /^\s*classDiagram/i,              // 类图
      /^\s*gantt\s*$/i,                 // 甘特图
      /^\s*pie\s*$/i,                   // 饼图
      /^\s*erDiagram/i,                // ER图
      /^\s*journey/i,                  // 用户旅程图
      /^\s*stateDiagram/i,             // 状态图
      /^\s*gitGraph/i                  // Git图
    ];
    
    // 检查是否是纯 Mermaid 语法
    const isPureMermaid = mermaidPatterns.some(pattern => pattern.test(content.trim()));
    
    if (!content.includes('```mermaid') && isPureMermaid) {
      debugLog('[DEBUG] 检测到纯 Mermaid 语法');
      mermaidCode = content.trim();
    }
    // 处理 Markdown 包裹的 Mermaid
    else if (content.includes('```mermaid')) {
      debugLog('[DEBUG] 检测到 Markdown 包裹的 Mermaid 内容');
      // 更健壮的提取方式，处理多个 ```mermaid 块
      const matches = content.match(/```mermaid\n([\s\S]+?)\n```/g);
      if (matches && matches.length > 0) {
        // 只处理第一个 mermaid 块
        const firstMatch = matches[0].match(/```mermaid\n([\s\S]+?)\n```/);
        if (firstMatch && firstMatch[1]) {
          mermaidCode = firstMatch[1].trim();
          debugLog(`[DEBUG] 提取的 Mermaid 代码长度: ${mermaidCode.length}`);
        } else {
          debugLog('[DEBUG] 无法提取 Mermaid 代码');
        }
      } else {
        debugLog('[DEBUG] 无法匹配 Mermaid 代码块');
      }
    }
    
    debugLog('[DEBUG] 使用客户端渲染方式处理 Mermaid 图表');
    
    // 对 Mermaid 代码进行转义，以便在 HTML 中安全使用
    const escapedMermaidCode = escapeHtml(mermaidCode);
    
    // 记录最终要渲染的代码
    debugLog(`[DEBUG] 最终要渲染的 Mermaid 代码: ${escapedMermaidCode.substring(0, 100)}...`);
    
    debugLog('[DEBUG] 准备生成客户端渲染 HTML');
    
    // 生成包含 Mermaid 图表的 HTML，使用客户端渲染
    return `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QuickShare Mermaid查看器</title>
        
        <!-- 网站图标 -->
        <link rel="icon" href="/icon/web/favicon.ico" sizes="any">
        <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png">
        <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png">
        <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png">
        <meta name="theme-color" content="#6366f1">
        
        <!-- iOS 特殊设置 -->
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="apple-mobile-web-app-title" content="QuickShare">
        
        <!-- 引入 Mermaid 库 -->
        <script src="${MERMAID_CDN}"></script>
        
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 24px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
            background-color: #f5f5f7;
            box-sizing: border-box;
          }
          .mermaid-container {
            width: 100%;
            max-width: 1200px;
            overflow: visible;
            background-color: white;
            padding: 32px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          .mermaid-wrapper {
            width: 100%;
            overflow: auto;
            position: relative;
          }
          .zoom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            font-size: 13px;
            color: #666;
          }
          .zoom-controls button {
            width: 28px;
            height: 28px;
            border: 1px solid #ddd;
            border-radius: 4px;
            background: white;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
          }
          .zoom-controls button:hover { background: #f0f0f0; }
          .zoom-controls span { min-width: 40px; text-align: center; }
          .mermaid {
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
            min-height: 200px;
            margin: 0 auto;
            transform-origin: top center;
            transition: transform 0.15s ease;
          }
          .mermaid svg {
            width: 100% !important;
            height: auto !important;
            max-width: 100%;
          }
          pre.mermaid-code {
            background-color: #f8f9fa;
            border-radius: 4px;
            padding: 15px;
            overflow-x: auto;
            margin: 15px 0;
            border-left: 4px solid #6366f1;
            display: none; /* 默认隐藏代码 */
          }
          .toggle-code-btn {
            background-color: #6366f1;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 15px;
            font-size: 14px;
          }
          .toggle-code-btn:hover {
            background-color: #4f46e5;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background-color: #0f172a;
              color: #e2e8f0;
            }
            .mermaid-container {
              background-color: #1e293b;
              box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            }
            pre.mermaid-code {
              background-color: #334155;
              border-left: 4px solid #6366f1;
            }
            .zoom-controls button {
              border-color: #475569;
              background: #1e293b;
              color: #e2e8f0;
            }
            .zoom-controls button:hover { background: #334155; }
          }
        </style>
      </head>
      <body>
        <div class="mermaid-container">
          <button class="toggle-code-btn" onclick="toggleCode()">显示/隐藏代码</button>
          <pre class="mermaid-code"><code>${escapedMermaidCode}</code></pre>
          <div class="zoom-controls">
            <button onclick="zoomOut()">−</button>
            <span id="zoomLevel">100%</span>
            <button onclick="zoomIn()">+</button>
            <button onclick="zoomReset()" style="width:auto;padding:0 8px;font-size:12px;">重置</button>
          </div>
          <div class="mermaid-wrapper">
            <div class="mermaid">
${escapedMermaidCode}
            </div>
          </div>
        </div>
        
        <script>
          // 初始化 Mermaid
          const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          mermaid.initialize({
            startOnLoad: true,
            securityLevel: 'loose',
            theme: 'base',
            themeVariables: isDark ? ${JSON.stringify(STANDALONE_MERMAID_DARK_THEME)} : ${JSON.stringify(STANDALONE_MERMAID_LIGHT_THEME)},
            themeCSS: ${JSON.stringify(MERMAID_THEME_CSS)},
            look: 'neo',
            flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'rounded' },
            sequence: { useMaxWidth: true },
            gantt: { useMaxWidth: true },
            er: { useMaxWidth: true },
            pie: { useMaxWidth: true }
          });
          
          // 确保 Mermaid 图表被渲染
          setTimeout(() => {
            try {
              mermaid.init(undefined, document.querySelectorAll('.mermaid'));
              console.log('Mermaid 图表渲染完成');
            } catch (e) {
              console.error('Mermaid 图表渲染失败:', e);
            }
          }, 100);
          
          // 显示/隐藏代码的函数
          function toggleCode() {
            const codeBlock = document.querySelector('.mermaid-code');
            if (codeBlock.style.display === 'block') {
              codeBlock.style.display = 'none';
            } else {
              codeBlock.style.display = 'block';
            }
          }

          // 缩放控制
          let scale = 1;
          const step = 0.15;
          const minScale = 0.3;
          const maxScale = 3;
          const mermaidEl = document.querySelector('.mermaid');
          const zoomLabel = document.getElementById('zoomLevel');

          function applyZoom() {
            mermaidEl.style.transform = 'scale(' + scale + ')';
            zoomLabel.textContent = Math.round(scale * 100) + '%';
          }
          function zoomIn() { scale = Math.min(maxScale, scale + step); applyZoom(); }
          function zoomOut() { scale = Math.max(minScale, scale - step); applyZoom(); }
          function zoomReset() { scale = 1; applyZoom(); }

          mermaidEl.addEventListener('wheel', function(e) {
            e.preventDefault();
            scale = Math.max(minScale, Math.min(maxScale, scale + (e.deltaY < 0 ? step : -step)));
            applyZoom();
          }, { passive: false });
        </script>
      </body>
      </html>
    `;
  } catch (error) {
    console.error('Mermaid渲染错误:', error);
    debugLog(`[DEBUG] Mermaid 渲染错误详情: ${error.message}`);
    debugLog(`[DEBUG] 错误堆栈: ${error.stack}`);
    // u5982u679cu6e32u67d3u5931u8d25uff0cu8fd4u56deu9519u8befu4fe1u606f
    return `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QuickShare Mermaidu9519u8bef</title>
        <style>
          body {
            font-family: 'Roboto', sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: #f5f5f7;
          }
          .error-container {
            max-width: 800px;
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          .error-title {
            color: #e74c3c;
            margin-bottom: 10px;
          }
          .code-block {
            background-color: #f8f9fa;
            border-radius: 4px;
            padding: 15px;
            overflow-x: auto;
            margin: 15px 0;
            border-left: 4px solid #e74c3c;
          }
          pre {
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background-color: #1a1a1a;
              color: #e6e6e6;
            }
            .error-container {
              background-color: #2a2a2a;
              box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            }
            .code-block {
              background-color: #333;
              border-left: 4px solid #e74c3c;
            }
          }
        </style>
      </head>
      <body>
        <div class="error-container">
          <h2 class="error-title">Mermaidu56feu8868u6e32u67d3u9519u8bef</h2>
          <p>u60a8u63d0u4f9bu7684Mermaidu56feu8868u4ee3u7801u65e0u6cd5u6e32u67d3u3002u8bf7u68c0u67e5u8bedu6cd5u662fu5426u6b63u786eu3002</p>
          <div class="code-block">
            <pre><code>${escapeHtml(content)}</code></pre>
          </div>
          <p>u9519u8befu4fe1u606f: ${escapeHtml(error.message)}</p>
        </div>
      </body>
      </html>
    `;
  }
}

/**
 * u8f6cu4e49HTMLu5b57u7b26
 * @param {string} unsafe - u9700u8981u8f6cu4e49u7684u5b57u7b26u4e32
 * @returns {string} - u8f6cu4e49u540eu7684u5b57u7b26u4e32
 */
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * u6839u636eu5185u5bb9u7c7bu578bu6e32u67d3u5185u5bb9
 * @param {string} content - u8981u6e32u67d3u7684u5185u5bb9
 * @param {string} contentType - u5185u5bb9u7c7bu578b
 * @returns {Promise<string>} - u6e32u67d3u540eu7684HTML
 */
async function renderContent(content, contentType, theme) {
  debugLog(`[DEBUG] renderContent 被调用，内容类型: ${contentType}`);
  debugLog(`[DEBUG] 内容长度: ${content.length} 字符`);

  switch (contentType) {
    case CODE_TYPES.HTML:
      debugLog('[DEBUG] 使用 HTML 渲染器');
      return renderHtml(content);
    case CODE_TYPES.MARKDOWN:
      debugLog('[DEBUG] 使用 Markdown 渲染器');
      const markdownResult = await renderMarkdown(content, theme);
      debugLog(`[DEBUG] Markdown 渲染完成，结果长度: ${markdownResult.length} 字符`);
      return markdownResult;
    case CODE_TYPES.SVG:
      debugLog('[DEBUG] 使用 SVG 渲染器');
      return renderSvg(content);
    case CODE_TYPES.MERMAID:
      debugLog('[DEBUG] 使用 Mermaid 渲染器');
      return await renderMermaid(content);
    default:
      debugLog(`[DEBUG] 使用默认渲染器 (Markdown)，因为内容类型 '${contentType}' 未知`);
      return await renderMarkdown(content, theme);
  }
}

/**
 * 预处理Markdown内容
 * @param {string} content - Markdown内容
 * @returns {Object} - 处理后的内容
 */
async function preprocessMarkdown(content) {
  // 检查是否是独立的 Mermaid 代码
  const isMermaidContent = (code) => {
    return isMermaidCode(code);
  };
  
  // 如果是独立的 Mermaid 代码，直接将其包裹在 mermaid 类中
  if (!content.includes('```') && isMermaidContent(content)) {
    debugLog('[DEBUG] 检测到独立的 Mermaid 代码');
    return {
      markdown: `<div class="mermaid">
${content}
</div>`,
      mermaidCharts: [{ id: 'mermaid-standalone', code: content }],
      svgBlocks: []
    };
  }
  
  // 对于 Markdown 内容，我们不需要做特殊处理
  // 因为我们已经自定义了 marked 渲染器来处理 Mermaid 和 SVG 代码块
  return {
    markdown: content,
    mermaidCharts: [],
    svgBlocks: []
  };
}

module.exports = {
  renderContent,
  renderHtml,
  renderMarkdown,
  renderSvg,
  renderMermaid,
  escapeHtml
};
