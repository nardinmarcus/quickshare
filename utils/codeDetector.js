/**
 * 代码类型检测工具
 * 用于检测输入的代码类型（HTML、Markdown、SVG、Mermaid等）
 */

const CODE_TYPES = {
  HTML: 'html',
  MARKDOWN: 'markdown',
  SVG: 'svg',
  MERMAID: 'mermaid',
  UNKNOWN: 'unknown'
};

function debugLog(...args) {
  if (process.env.DEBUG_RENDERER === 'true') {
    console.log(...args);
  }
}

/**
 * 检测代码类型
 * @param {string} code - 输入的代码内容
 * @returns {string} - 返回代码类型
 */
function detectCodeType(code) {
  if (!code || typeof code !== 'string') {
    return CODE_TYPES.UNKNOWN;
  }
  
  const trimmedCode = code.trim();
  debugLog(`[DEBUG] 内容长度: ${trimmedCode.length} 字符`);
  
  // 第一级检测: 文档开头的明确标记
  // 这些检查有最高优先级，只检查文档开头
  
  // 1.1 检查是否是完整的HTML文档
  if (trimmedCode.startsWith('<!DOCTYPE html>') || 
      trimmedCode.startsWith('<html')) {
    debugLog('[DEBUG] 检测到完整HTML文档');
    return CODE_TYPES.HTML;
  }
  
  // 1.2 检查是否以特定代码块标记开头
  if (trimmedCode.startsWith('```html')) {
    debugLog('[DEBUG] 检测到内容以```html开头');
    return CODE_TYPES.HTML;
  }
  
  if (trimmedCode.startsWith('```mermaid')) {
    debugLog('[DEBUG] 检测到内容以```mermaid开头');
    return CODE_TYPES.MERMAID;
  }
  
  if (trimmedCode.startsWith('```svg')) {
    debugLog('[DEBUG] 检测到内容以```svg开头');
    return CODE_TYPES.SVG;
  }
  
  // 1.3 检查是否是纯SVG文档
  if (trimmedCode.startsWith('<svg') && 
      trimmedCode.includes('</svg>') && 
      trimmedCode.includes('xmlns="http://www.w3.org/2000/svg"')) {
    debugLog('[DEBUG] 检测到纯SVG文档');
    return CODE_TYPES.SVG;
  }
  
  // 第二级检测: 内容中的特定标记
  // 这些检查在文档中寻找特定的标记
  
  // 2.1 检查是否包含代码块标记
  if (trimmedCode.includes('```mermaid')) {
    // 如果文档中包含```mermaid标记，首先检查是否有明确的Markdown特征
    if (isDefinitelyMarkdown(trimmedCode)) {
      debugLog('[DEBUG] 检测到Mermaid代码块，但内容是Markdown');
      return CODE_TYPES.MARKDOWN;
    }
    debugLog('[DEBUG] 检测到Mermaid代码块');
    return CODE_TYPES.MERMAID;
  }
  
  if (trimmedCode.includes('```svg')) {
    // 如果文档中包含```svg标记，首先检查是否有明确的Markdown特征
    if (isDefinitelyMarkdown(trimmedCode)) {
      debugLog('[DEBUG] 检测到SVG代码块，但内容是Markdown');
      return CODE_TYPES.MARKDOWN;
    }
    debugLog('[DEBUG] 检测到SVG代码块');
    return CODE_TYPES.SVG;
  }
  
  // 2.2 检测纯Mermaid语法
  const mermaidPatterns = [
    /^\s*graph\s+[A-Za-z\s]/i,        // 流程图
    /^\s*flowchart\s+[A-Za-z\s]/i,    // 流程图 (新语法)
    /^\s*sequenceDiagram/i,           // 序列图
    /^\s*classDiagram/i,              // 类图
    /^\s*gantt/i,                    // 甘特图
    /^\s*pie/i,                      // 饼图
    /^\s*erDiagram/i,                // ER图
    /^\s*journey/i,                  // 用户旅程图
    /^\s*stateDiagram/i,             // 状态图
    /^\s*gitGraph/i                  // Git图
  ];
  
  const isPureMermaid = mermaidPatterns.some(pattern => pattern.test(trimmedCode));
  
  if (isPureMermaid && !containsMarkdownFeatures(trimmedCode)) {
    debugLog('[DEBUG] 检测到纯 Mermaid 语法');
    return CODE_TYPES.MERMAID;
  }
  
  // 2.3 检测HTML标签
  const hasHtmlTags = trimmedCode.startsWith('<') && 
    (trimmedCode.includes('<div') || 
     trimmedCode.includes('<p') || 
     trimmedCode.includes('<span') || 
     trimmedCode.includes('<h1') || 
     trimmedCode.includes('<body') || 
     trimmedCode.includes('<head') ||
     trimmedCode.includes('<style') ||
     trimmedCode.includes('<script') ||
     trimmedCode.includes('<link') ||
     trimmedCode.includes('<meta'));
  
  if (hasHtmlTags) {
    debugLog('[DEBUG] 检测到HTML标签');
    return CODE_TYPES.HTML;
  }
  
  // 第三级检测: 内容特征分析
  // 3.1 检测明确的Markdown特征
  if (isDefinitelyMarkdown(trimmedCode)) {
    debugLog('[DEBUG] 检测到明确的Markdown特征');
    return CODE_TYPES.MARKDOWN;
  }
  
  // 3.2 默认返回HTML
  debugLog('[DEBUG] 无法确定内容类型，默认返回HTML');
  return CODE_TYPES.HTML;
}

/**
 * 检测是否包含Markdown特征
 * @param {string} content - 要检测的内容
 * @returns {boolean} - 是否包含Markdown特征
 */
function containsMarkdownFeatures(content) {
  // 检查是否包含Markdown特征
  return (
    content.includes('###') || 
    content.includes('##') || 
    content.includes('# ') || 
    /^-\s.+/m.test(content) || 
    /^\*\s.+/m.test(content) || 
    /^\d+\.\s.+/m.test(content) || 
    content.includes('```') || 
    /\[.+\]\(.+\)/.test(content) || 
    /!\[.+\]\(.+\)/.test(content) || 
    /^>\s.+/m.test(content) || 
    /\|.+\|/.test(content) || 
    /\*\*.+\*\*/.test(content) || 
    /__.+__/.test(content)
  );
}

/**
 * 检测内容是否明确是Markdown格式
 * @param {string} content - 要检测的内容
 * @returns {boolean} - 是否是Markdown
 */
function isDefinitelyMarkdown(content) {
  // 检查明确的Markdown标记
  const hasHeadings = /^#{1,6}\s.+/m.test(content);
  const hasListItems = /^[-*+]\s.+/m.test(content);
  const hasNumberedList = /^\d+\.\s.+/m.test(content);
  const hasBlockquotes = /^>\s.+/m.test(content);
  const hasCodeBlocks = /^```[\s\S]*?```/m.test(content);
  const hasLinks = /\[.+?\]\(.+?\)/m.test(content);
  const hasImages = /!\[.+?\]\(.+?\)/m.test(content);
  const hasTables = /\|.+\|[\s\S]*?\|.+\|/m.test(content);
  
  // 如果包含多个Markdown特征，或者内容很短且包含至少一个特征，则认为是Markdown
  const markdownFeatureCount = [
    hasHeadings, hasListItems, hasNumberedList, hasBlockquotes, 
    hasCodeBlocks, hasLinks, hasImages, hasTables
  ].filter(Boolean).length;
  
  return markdownFeatureCount >= 2 || (content.length < 1000 && markdownFeatureCount >= 1);
}

/**
 * 提取代码块内容和类型
 * @param {string} content - 输入的内容
 * @returns {Array} - 返回提取到的代码块数组，每个元素包含type和content
 */
function extractCodeBlocks(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  // 匹配代码块的正则表达式
  // 匹配```type和内容的格式
  const codeBlockRegex = /```([a-zA-Z0-9_]+)[\s\n]([\s\S]*?)```/g;
  
  const blocks = [];
  let match;
  
  // 查找所有代码块
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const blockType = match[1].toLowerCase(); // 代码块类型（小写）
    const blockContent = match[2].trim();    // 代码块内容
    
    // 根据代码块类型确定内容类型
    let contentType = CODE_TYPES.UNKNOWN;
    
    // 映射代码块类型到内容类型
    switch (blockType) {
      case 'html':
        contentType = CODE_TYPES.HTML;
        break;
      case 'xml':
        // XML也作为HTML处理
        contentType = CODE_TYPES.HTML;
        break;
      case 'svg':
        contentType = CODE_TYPES.SVG;
        break;
      case 'mermaid':
        contentType = CODE_TYPES.MERMAID;
        break;
      case 'markdown':
      case 'md':
        contentType = CODE_TYPES.MARKDOWN;
        break;
      default:
        // 对于未知类型，使用detectCodeType函数检测
        contentType = detectCodeType(blockContent);
    }
    
    blocks.push({
      originalType: blockType,  // 原始代码块类型
      type: contentType,       // 内容类型
      content: blockContent    // 内容
    });
  }
  
  debugLog(`[DEBUG] 提取到${blocks.length}个代码块`);
  return blocks;
}

module.exports = {
  detectCodeType,
  extractCodeBlocks,
  CODE_TYPES
};
