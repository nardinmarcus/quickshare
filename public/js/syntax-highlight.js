/**
 * QuickShare syntax highlighting.
 * Uses highlight.js to add syntax highlighting to code blocks.
 */
document.addEventListener('DOMContentLoaded', () => {
  if (typeof window.hljs === 'undefined') return;

  // 初始化语法高亮
  hljs.configure({
    languages: ['html', 'xml', 'javascript', 'css', 'php', 'python', 'java', 'json'],
    tabReplace: '  ', // 2个空格替代tab
    useBR: false,
    cssSelector: 'pre code, code.hljs', // 应用高亮的选择器
    ignoreUnescapedHTML: true
  });
  
  // 应用高亮到所有代码块
  function applyHighlighting() {
    document.querySelectorAll('pre code, code.hljs').forEach(block => {
      hljs.highlightElement(block);
    });
  }
  
  // 初始应用
  applyHighlighting();
  
  // 当主题变化时重新应用高亮
  document.addEventListener('themeChange', (e) => {
    // 延迟执行以确保DOM已更新
    setTimeout(applyHighlighting, 100);
  });
  
  // 为查看页面添加语法高亮
  if (window.location.pathname.startsWith('/view/')) {
    // 查找页面中的代码块并添加高亮类
    document.querySelectorAll('pre, code').forEach(block => {
      if (!block.classList.contains('hljs')) {
        block.classList.add('hljs');
        hljs.highlightElement(block);
      }
    });
    
    // 为没有包裹在pre标签中的code标签添加pre包装
    document.querySelectorAll('code:not(pre code)').forEach(codeBlock => {
      // 避免重复处理
      if (codeBlock.parentNode.tagName !== 'PRE') {
        const preElement = document.createElement('pre');
        const parent = codeBlock.parentNode;
        parent.insertBefore(preElement, codeBlock);
        preElement.appendChild(codeBlock);
        hljs.highlightElement(codeBlock);
      }
    });
  }
});
