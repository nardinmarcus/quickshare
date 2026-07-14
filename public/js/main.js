// QuickShare main JavaScript file.
// Handles user interactions and application behavior.

// 错误提示功能
function showErrorToast(message) {
  const errorToast = document.getElementById('error-toast');
  const errorMessage = document.getElementById('error-message');
  if (errorToast && errorMessage) {
    errorMessage.textContent = message;
    errorToast.classList.add('show');
    
    setTimeout(() => {
      errorToast.classList.remove('show');
    }, 3000);
  } else {
    console.error('错误提示元素不存在:', message);
  }
}

// 成功提示功能
function showSuccessToast(message) {
  const successToast = document.getElementById('success-toast');
  const successMessage = document.getElementById('success-message');
  if (successToast && successMessage) {
    successMessage.textContent = message;
    successToast.classList.add('show');
    
    setTimeout(() => {
      successToast.classList.remove('show');
    }, 3000);
  } else {
    console.error('成功提示元素不存在:', message);
  }
}

// 使用延迟加载确保所有元素已经完全渲染好
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM完全加载，初始化应用...');

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function jsonHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    const csrfToken = getCsrfToken();

    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    return headers;
  }
  
  // DOM 元素
  const htmlInput = document.getElementById('html-input');
  const fileInput = document.getElementById('html-file');
  const codeInputContainer = document.getElementById('code-input-container');
  const fileName = document.getElementById('file-name');
  const clearButton = document.getElementById('clear-button');
  const generateButton = document.getElementById('generate-button');
  const resultSection = document.getElementById('result-section');
  const resultUrl = document.getElementById('result-url');
  const copyButton = document.getElementById('copy-button');
  const previewButton = document.getElementById('preview-button');
  const loadingIndicator = document.getElementById('loading-indicator');
  const linkAccessRadio = document.getElementById('access-link');
  const passwordToggle = document.getElementById('password-toggle');
  const passwordSettings = document.getElementById('password-settings');
  const passwordModeSummary = document.getElementById('password-mode-summary');
  const generatedPassword = document.getElementById('generated-password');
  const resultPasswordRow = document.getElementById('result-password-row');
  const copyPasswordLink = document.getElementById('copy-password-link');
  const passwordDefaultMode = document.getElementById('password-default-mode');
  const passwordCustomMode = document.getElementById('password-custom-mode');
  const useCustomPasswordBtn = document.getElementById('use-custom-password-btn');
  const confirmCustomPasswordBtn = document.getElementById('confirm-custom-password');
  const cancelCustomPasswordBtn = document.getElementById('cancel-custom-password');
  const customPasswordInput = document.getElementById('custom-password-input');
  const toggleCustomPasswordBtn = document.getElementById('toggle-custom-password');
  const shareTitleInput = document.getElementById('share-title');
  const shareDescriptionInput = document.getElementById('share-description');
  const shareExpiresInput = document.getElementById('share-expires');
  const shareExpiresHint = document.getElementById('share-expires-hint');

  // 用户自定义密码（空字符串表示使用默认密码）
  let userCustomPassword = '';
  let isSubmitting = false;
  
  // 创建代码编辑器
  let codeElement = null;
  let highlightEnabled = true;
  
  // 初始化代码编辑器 - 简化版本，不使用双层结构
  function initCodeEditor() {
    if (htmlInput && codeInputContainer) {
      console.log('初始化简化版代码编辑器');
      
      // 不创建额外的代码元素，直接使用 textarea
      htmlInput.style.fontFamily = 'monospace';
      htmlInput.style.fontSize = '14px';
      htmlInput.style.lineHeight = '1.5';
      htmlInput.style.color = 'var(--text-primary)';
      htmlInput.style.backgroundColor = 'var(--bg-input)';
      htmlInput.style.border = '1px solid var(--border-color)';
      htmlInput.style.borderRadius = '8px';
      htmlInput.style.padding = '15px';
      htmlInput.style.boxSizing = 'border-box';
      htmlInput.style.width = '100%';
      htmlInput.style.minHeight = '200px';
      htmlInput.style.maxHeight = '500px';
      htmlInput.style.overflow = 'auto';
      htmlInput.style.whiteSpace = 'pre-wrap';
      htmlInput.style.wordBreak = 'break-word';
      htmlInput.style.resize = 'vertical';
      htmlInput.style.outline = 'none';
      
      // 如果有初始内容，更新代码类型指示器
      if (htmlInput.value) {
        const codeType = detectCodeType(htmlInput.value);
        updateCodeTypeIndicator(codeType, htmlInput.value);
      }
    }
  }
  
  // 显示加载指示器
  function showLoading() {
    if (loadingIndicator) {
      loadingIndicator.style.display = 'flex';
    }
  }
  
  // 隐藏加载指示器
  function hideLoading() {
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }
  }
  
  // 同步内容 - 简化版本，只更新代码类型指示器
  function syncToTextarea() {
    if (htmlInput) {
      // 只更新代码类型指示器
      const codeType = detectCodeType(htmlInput.value);
      updateCodeTypeIndicator(codeType, htmlInput.value);
    }
  }
  
  // 更新语法高亮 - 简化版本
  function updateHighlighting() {
    // 简化版本不需要高亮功能
    console.log('简化版本不使用语法高亮');
  }
  
  // 切换高亮状态 - 简化版本
  function toggleHighlighting() {
    // 简化版本不需要高亮功能
    console.log('简化版本不使用语法高亮切换');
  }
  
  // 格式化 URL 显示
  function formatUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const id = path.split('/').pop();
      
      // 创建带样式的 URL 显示
      return `<span style="color: var(--text-secondary);">${urlObj.origin}</span><span style="color: var(--primary);">/view/</span><span style="color: var(--accent); font-weight: bold;">${id}</span>`;
    } catch (e) {
      return url; // 如果解析失败，返回原始 URL
    }
  }
  
  // 文件上传处理
  if (fileInput) {
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      
      const allowedExts = ['.html', '.htm', '.md', '.markdown', '.svg', '.mmd', '.mermaid'];
      if (!allowedExts.some(ext => file.name.toLowerCase().endsWith(ext))) {
        showErrorToast('请上传 HTML / Markdown / SVG / Mermaid 文件');
        return;
      }
      
      showLoading();
      fileName.textContent = file.name;
      
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target.result;
        htmlInput.value = content;
        
        // 将光标移动到文本末尾
        htmlInput.selectionStart = htmlInput.selectionEnd = content.length;
        
        // 同步到高亮区域
        syncToTextarea();
        hideLoading();
      };
      reader.readAsText(file);
    });
  }
  
  // 清除按钮功能
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      console.log('清除按钮被点击');
      if (htmlInput) {
        htmlInput.value = '';
      }
      if (fileName) {
        fileName.textContent = '';
      }
      if (resultSection) {
        resultSection.style.display = 'none';
        resultSection.classList.remove('fade-in');
      }
      // 同步到高亮区域
      syncToTextarea();
      // 显示成功提示
      showSuccessToast('内容已清除');
    });
  }
  
  const customPasswordPattern = /^[A-Za-z0-9!@#$%^&*()_+\-=.,?~]{4,12}$/;
  const customPasswordError = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';

  function passwordValidationError(password) {
    return customPasswordPattern.test(password) ? '' : customPasswordError;
  }

  function userFacingError(message) {
    const error = new Error(message);
    error.userFacing = true;
    return error;
  }

  function updatePasswordHint(password) {
    const passwordHint = document.getElementById('custom-password-hint');

    if (!passwordHint) return;

    if (!password) {
      passwordHint.textContent = '仅限英文字母、数字及 !@#$%^&*()_+-=.,?~';
      passwordHint.className = 'field-hint';
      if (customPasswordInput) customPasswordInput.setAttribute('aria-invalid', 'false');
      return;
    }

    const error = passwordValidationError(password);
    passwordHint.textContent = error || '密码格式有效';
    passwordHint.className = error ? 'field-hint error' : 'field-hint valid';
    if (customPasswordInput) customPasswordInput.setAttribute('aria-invalid', error ? 'true' : 'false');
  }

  // 辅助函数：显示自动/已确认的自定义密码模式
  function showPasswordDefaultMode() {
    if (passwordDefaultMode) passwordDefaultMode.classList.remove('hidden');
    if (passwordCustomMode) passwordCustomMode.classList.add('hidden');
    if (passwordModeSummary) {
      passwordModeSummary.textContent = userCustomPassword
        ? '将使用已设置的自定义密码'
        : '自动生成 6 位数字密码';
    }
  }

  // 辅助函数：显示自定义模式
  function showPasswordCustomMode() {
    if (passwordDefaultMode) passwordDefaultMode.classList.add('hidden');
    if (passwordCustomMode) passwordCustomMode.classList.remove('hidden');
    if (customPasswordInput) {
      customPasswordInput.value = userCustomPassword;
      customPasswordInput.focus();
    }
  }

  function syncPasswordSettings() {
    if (passwordToggle && passwordToggle.checked) {
      if (passwordSettings) passwordSettings.classList.remove('hidden');
      showPasswordDefaultMode();
      return;
    }

    if (passwordSettings) passwordSettings.classList.add('hidden');
    if (passwordDefaultMode) passwordDefaultMode.classList.add('hidden');
    if (passwordCustomMode) passwordCustomMode.classList.add('hidden');
  }

  function showResultPassword(password) {
    if (generatedPassword) generatedPassword.textContent = password || '';
    if (resultPasswordRow) {
      resultPasswordRow.classList.toggle('hidden', !password);
    }
  }

  if (passwordToggle) {
    passwordToggle.addEventListener('change', syncPasswordSettings);
  }
  if (linkAccessRadio) {
    linkAccessRadio.addEventListener('change', syncPasswordSettings);
  }

  // "自定义密码"按钮 → 切换到输入模式
  if (useCustomPasswordBtn) {
    useCustomPasswordBtn.addEventListener('click', () => {
      showPasswordCustomMode();
    });
  }

  // "确认"按钮 → 保存自定义密码
  if (confirmCustomPasswordBtn) {
    confirmCustomPasswordBtn.addEventListener('click', () => {
      const password = customPasswordInput ? customPasswordInput.value : '';
      if (!password) {
        showErrorToast('请输入密码');
        return;
      }

      const error = passwordValidationError(password);
      if (error) {
        updatePasswordHint(password);
        showErrorToast(error);
        return;
      }

      userCustomPassword = password;
      showPasswordDefaultMode();
      showSuccessToast('自定义密码已设置');
    });
  }

  // "默认密码"按钮 → 切换回默认模式，使用默认密码
  if (cancelCustomPasswordBtn) {
    cancelCustomPasswordBtn.addEventListener('click', () => {
      userCustomPassword = '';
      if (customPasswordInput) customPasswordInput.value = '';
      updatePasswordHint('');
      showPasswordDefaultMode();
    });
  }

  // 自定义密码显示/隐藏切换
  if (toggleCustomPasswordBtn && customPasswordInput) {
    toggleCustomPasswordBtn.addEventListener('click', () => {
      const isHidden = customPasswordInput.type === 'password';
      customPasswordInput.type = isHidden ? 'text' : 'password';
      toggleCustomPasswordBtn.setAttribute('aria-label', isHidden ? '隐藏密码' : '显示密码');
      toggleCustomPasswordBtn.innerHTML = isHidden
        ? '<i class="fas fa-eye-slash" aria-hidden="true"></i>'
        : '<i class="fas fa-eye" aria-hidden="true"></i>';
    });
  }

  if (customPasswordInput) {
    customPasswordInput.addEventListener('input', () => {
      updatePasswordHint(customPasswordInput.value);
    });
  }

  if (shareExpiresInput && shareExpiresHint) {
    shareExpiresInput.addEventListener('change', () => {
      const expiresAt = shareExpiresInput.value ? new Date(shareExpiresInput.value).getTime() : null;
      const invalid = expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now());
      shareExpiresHint.textContent = invalid ? '到期时间必须晚于当前时间' : '';
      shareExpiresHint.className = invalid ? 'field-hint error' : 'field-hint';
    });
  }

  syncPasswordSettings();

  // 代码类型检测函数
  function detectCodeType(code) {
    if (!code || typeof code !== 'string') {
      return 'html'; // 默认返回HTML而不是Markdown
    }
    
    const trimmedCode = code.trim();
    console.log('检测代码类型，前50个字符:', trimmedCode.substring(0, 50) + '...');
    
    // 检测纯Mermaid - 优先检查，因为这是最明确的格式
    if ((trimmedCode.startsWith('graph ') || 
        trimmedCode.startsWith('sequenceDiagram') || 
        trimmedCode.startsWith('classDiagram') || 
        trimmedCode.startsWith('gantt') || 
        trimmedCode.startsWith('pie') || 
        trimmedCode.startsWith('flowchart'))) {
      console.log('检测到纯Mermaid图表');
      return 'mermaid';
    }
    
    // 检测HTML - 只有明确的HTML文档才识别为HTML
    if (trimmedCode.startsWith('<!DOCTYPE html>') || 
        trimmedCode.startsWith('<html')) {
      console.log('检测到完整HTML文档');
      return 'html';
    }
    
    // 检测纯SVG - 只有当它是一个完整的SVG标签时
    if (trimmedCode.startsWith('<svg') && 
        trimmedCode.includes('</svg>') && 
        trimmedCode.includes('xmlns="http://www.w3.org/2000/svg"')) {
      console.log('检测到纯SVG');
      return 'svg';
    }
    
    // 检查是否包含明确的Markdown特征
    // 计算Markdown特征的数量和权重
    let markdownScore = 0;
    
    // 标题 (权重高)
    if (trimmedCode.includes('# ')) markdownScore += 2;
    if (trimmedCode.includes('## ')) markdownScore += 2;
    if (trimmedCode.includes('### ')) markdownScore += 2;
    
    // 列表
    if (/^-\s.+/m.test(trimmedCode)) markdownScore += 1;
    if (/^\*\s.+/m.test(trimmedCode)) markdownScore += 1;
    if (/^\d+\.\s.+/m.test(trimmedCode)) markdownScore += 1;
    
    // 代码块 (权重高)
    if (trimmedCode.includes('```')) markdownScore += 3;
    
    // 链接和图片 (权重高)
    if (/\[.+\]\(.+\)/.test(trimmedCode)) markdownScore += 2;
    if (/!\[.+\]\(.+\)/.test(trimmedCode)) markdownScore += 2;
    
    // 引用
    if (/^>\s.+/m.test(trimmedCode)) markdownScore += 2;
    
    // 表格
    if (/\|.+\|/.test(trimmedCode)) markdownScore += 2;
    
    // 格式化文本
    if (/\*\*.+\*\*/.test(trimmedCode)) markdownScore += 1;
    if (/__.+__/.test(trimmedCode)) markdownScore += 1;
    
    console.log('Markdown特征分数:', markdownScore);
    
    // 如果Markdown分数足够高，则返回Markdown
    if (markdownScore >= 3) {
      console.log('检测到Markdown内容');
      return 'markdown';
    }
    
    // 检查是否包含Markdown代码块标记
    if (trimmedCode.includes('```svg') || 
        trimmedCode.includes('```mermaid') ||
        trimmedCode.includes('```javascript') ||
        trimmedCode.includes('```python') ||
        trimmedCode.includes('```java') ||
        trimmedCode.includes('```html') ||
        trimmedCode.includes('```css')) {
      console.log('检测到Markdown代码块');
      return 'markdown';
    }
    
    // 检测纯文本 - 没有HTML标签的纯文本内容可能是Markdown
    if (!trimmedCode.includes('<') && !trimmedCode.includes('>')) {
      // 如果内容很短且没有明显的Markdown特征，可能是普通文本
      if (trimmedCode.length < 50 && markdownScore < 2) {
        console.log('检测到短纯文本，可能是HTML');
        return 'html';
      }
      console.log('检测到纯文本，可能是Markdown');
      return 'markdown';
    }
    
    // 检测HTML片段
    if (trimmedCode.startsWith('<') && 
        (trimmedCode.includes('<div') || 
         trimmedCode.includes('<p') || 
         trimmedCode.includes('<span') || 
         trimmedCode.includes('<h1') || 
         trimmedCode.includes('<body') || 
         trimmedCode.includes('<head'))) {
      console.log('检测到HTML片段');
      return 'html';
    }
    
    // 更智能的类型检测 - 处理混合内容
    // 如果包含 HTML 标签，但不是完整的 HTML 文档，我们需要进一步判断
    if (trimmedCode.includes('<') && trimmedCode.includes('>')) {
      // 计算 HTML 标签的数量
      const htmlTagsCount = (trimmedCode.match(/<\/?[a-z][\s\S]*?>/gi) || []).length;
      console.log('HTML标签数量:', htmlTagsCount);
      
      // 如果HTML标签数量很少，而Markdown特征分数较高，则可能是Markdown中嵌入了少量HTML
      if (htmlTagsCount < 5 && markdownScore >= 3) {
        console.log('检测到Markdown中嵌入了少量HTML');
        return 'markdown';
      }
      
      // 如果是SVG标签但嵌入在Markdown中
      if (trimmedCode.includes('<svg') && 
          trimmedCode.includes('</svg>') && 
          trimmedCode.includes('xmlns="http://www.w3.org/2000/svg"') &&
          markdownScore >= 3) {
        console.log('检测到Markdown中嵌入了SVG');
        return 'markdown';
      }
      
      // 如果内容中有大量HTML标签，可能是HTML
      if (htmlTagsCount > 10) {
        console.log('检测到大量HTML标签，可能是HTML');
        return 'html';
      }
      
      // 如果Markdown特征分数明显高于HTML标签数量
      if (markdownScore > htmlTagsCount * 1.5) {
        console.log('Markdown特征明显多于HTML标签');
        return 'markdown';
      }
      
      // 默认返回HTML
      console.log('默认判断为HTML');
      return 'html';
    }
    
    // 如果没有明确的特征，默认返回HTML
    console.log('没有明确特征，默认返回HTML');
    return 'html';
  }

  // 显示代码类型标记
  function updateCodeTypeIndicator(codeType, content) {
    const indicator = document.getElementById('code-type-indicator');
    const codeTypeText = document.getElementById('code-type-text');
    const themeSelector = document.getElementById('markdown-theme-selector');

    if (!indicator || !codeTypeText) {
      return;
    }

    if (themeSelector) {
      if (codeType === 'markdown' && content && content.trim() !== '') {
        themeSelector.classList.remove('hidden');
      } else {
        themeSelector.classList.add('hidden');
      }
    }
    
    // 如果没有内容，隐藏指示器
    if (!content || content.trim() === '') {
      indicator.style.display = 'none';
      return;
    } else {
      indicator.style.display = 'flex';
    }
    
    // 根据代码类型设置样式和图标
    let iconClass = '';
    let label = '';
    let className = '';
    
    switch(codeType) {
      case 'html':
        iconClass = 'fas fa-code';
        label = 'HTML';
        className = 'html-type';
        break;
      case 'markdown':
        iconClass = 'fab fa-markdown';
        label = 'Markdown';
        className = 'markdown-type';
        break;
      case 'svg':
        iconClass = 'fas fa-bezier-curve';
        label = 'SVG';
        className = 'svg-type';
        break;
      case 'mermaid':
        iconClass = 'fas fa-project-diagram';
        label = 'Mermaid';
        className = 'mermaid-type';
        break;
      default:
        iconClass = 'fas fa-code';
        label = 'Code';
        className = 'default-type';
    }
    
    // 更新指示器类名
    indicator.className = `code-type-indicator ${className}`;
    
    // 更新图标和文本
    const iconElement = indicator.querySelector('i');
    if (iconElement) {
      iconElement.className = iconClass;
    }
    
    // 更新文本
    codeTypeText.textContent = label;
  }

  // 初始化代码编辑器
  initCodeEditor();
  
  // 在输入框内容变化时检测代码类型并更新高亮
  if (htmlInput) {
    htmlInput.addEventListener('input', () => {
      const content = htmlInput.value;
      const codeType = detectCodeType(content);
      updateCodeTypeIndicator(codeType, content);
      
      // 同步到高亮区域
      syncToTextarea();
    });
    
    // 页面加载时检测初始内容
    if (htmlInput.value) {
      const content = htmlInput.value;
      
      // 检查是否在编辑页面上
      const isEditPage = window.location.pathname.includes('/edit/') || window.location.pathname.includes('/view/');
      
      // 如果是编辑页面，尝试从多个来源获取代码类型
      let codeType = 'html';
      if (isEditPage) {
        // 1. 尝试从 meta 标签中获取代码类型
        const metaCodeType = document.querySelector('meta[name="code-type"]');
        if (metaCodeType && metaCodeType.getAttribute('content')) {
          const typeFromMeta = metaCodeType.getAttribute('content');
          if (['html', 'markdown', 'svg', 'mermaid'].includes(typeFromMeta)) {
            codeType = typeFromMeta;
            console.log(`从 meta 标签中获取代码类型: ${codeType}`);
          }
        } else {
          // 2. 尝试从 URL 参数中获取代码类型
          const urlParams = new URLSearchParams(window.location.search);
          const typeFromUrl = urlParams.get('type');
          
          if (typeFromUrl && ['html', 'markdown', 'svg', 'mermaid'].includes(typeFromUrl)) {
            codeType = typeFromUrl;
            console.log(`从 URL 参数中获取代码类型: ${codeType}`);
          } else {
            // 3. 如果以上方法都失败，则使用检测函数
            codeType = detectCodeType(content);
            console.log(`检测到的代码类型: ${codeType}`);
          }
        }
      } else {
        // 如果不是编辑页面，使用检测函数
        codeType = detectCodeType(content);
      }
      
      updateCodeTypeIndicator(codeType, content);
    } else {
      // 初始时如果没有内容，隐藏指示器
      updateCodeTypeIndicator('html', '');
    }
  }

  // 生成链接
  if (generateButton) {
    generateButton.addEventListener('click', async () => {
      if (isSubmitting) {
        return;
      }

      console.log('生成链接按钮被点击');
      // 确保从编辑器同步到textarea
      syncToTextarea();
      
      if (!htmlInput) {
        showErrorToast('HTML输入元素不存在');
        return;
      }
      
      const htmlContent = htmlInput.value.trim();
      
      if (!htmlContent) {
        showErrorToast('请输入 HTML 内容');
        return;
      }

      const isProtected = passwordToggle ? passwordToggle.checked : false;

      if (isProtected && passwordCustomMode && !passwordCustomMode.classList.contains('hidden')) {
        const password = customPasswordInput ? customPasswordInput.value : '';
        const validationError = passwordValidationError(password);

        if (validationError) {
          updatePasswordHint(password);
          showErrorToast(validationError);
          return;
        }

        userCustomPassword = password;
        showPasswordDefaultMode();
      }

      let expiresAt = null;
      if (shareExpiresInput && shareExpiresInput.value) {
        expiresAt = new Date(shareExpiresInput.value).getTime();

        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          if (shareExpiresHint) {
            shareExpiresHint.textContent = '到期时间必须晚于当前时间';
            shareExpiresHint.className = 'field-hint error';
          }
          showErrorToast('到期时间必须晚于当前时间');
          return;
        }
      }

      isSubmitting = true;
      
      try {
        // 显示加载指示器
        loadingIndicator.classList.add('show');
        
        // 添加按钮加载动画
        generateButton.innerHTML = '<i class="fas fa-spinner fa-spin loading-spinner"></i> 处理中...';
        generateButton.disabled = true;
        
        // 检测代码类型
        const codeType = detectCodeType(htmlContent);
        console.log('检测到的代码类型:', codeType);
        
        // 调用 API 生成链接
        const requestBody = {
          htmlContent,
          isProtected,
          codeType,
          title: shareTitleInput ? shareTitleInput.value : '',
          description: shareDescriptionInput ? shareDescriptionInput.value : '',
          expiresAt
        };
        if (isProtected && userCustomPassword) {
          requestBody.password = userCustomPassword;
        }
        if (codeType === 'markdown') {
          var themeSelect = document.getElementById('markdown-theme');
          requestBody.markdownTheme = themeSelect ? themeSelect.value : 'random';
        }
        const response = await fetch('/api/pages/create', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(requestBody),
        });
        
        const data = await response.json().catch(() => null);
        console.log('API响应数据:', {
          success: data?.success,
          urlId: data?.urlId,
          isProtected: data?.isProtected,
          codeType: data?.codeType
        });
        
        if (response.ok && data && data.success) {
          const url = `${window.location.origin}/view/${data.urlId}`;
          
          // 格式化 URL 显示
          const formattedUrl = formatUrl(url);
          if (resultUrl) {
            resultUrl.innerHTML = formattedUrl;
            
            // 保存原始 URL 用于复制和预览
            resultUrl.dataset.originalUrl = url;
          }
          
          showResultPassword(data.isProtected ? data.password : null);
          
          // 显示结果区域
          if (resultSection) {
            resultSection.style.display = 'block';
            
            // 使用 setTimeout 确保动画效果正确显示
            setTimeout(() => {
              resultSection.classList.add('fade-in');
              // 添加光影效果和流动效果，只出现一次
              // 先移除之前的类，确保动画可以重新触发
              resultSection.classList.remove('glow-effect');
              resultSection.classList.remove('flow-effect');
              
              // 使用 setTimeout 确保在下一个渲染周期添加类
              setTimeout(() => {
                resultSection.classList.add('glow-effect');
                resultSection.classList.add('flow-effect');
                
                // 动画结束后不需要手动移除类，因为 CSS 中设置了 forwards
                // 但为了确保下次点击时可以再次触发动画，我们在动画完成后移除类
                setTimeout(() => {
                  resultSection.classList.remove('glow-effect');
                  resultSection.classList.remove('flow-effect');
                }, 3000);
              }, 10);
            }, 10);
          }
          
          // 添加成功反馈
          generateButton.classList.add('success-pulse');
          setTimeout(() => {
            generateButton.classList.remove('success-pulse');
          }, 500);
          
          // 不需要显示生成链接的toast提示
        } else {
          throw userFacingError(data?.error || '发布失败，请稍后重试');
        }
      } catch (error) {
        console.error('生成链接错误:', error);
        showErrorToast(error.userFacing ? error.message : '发布失败，请稍后重试');
      } finally {
        isSubmitting = false;
        generateButton.innerHTML = '<i class="fas fa-link mr-1"></i>发布并生成链接';
        generateButton.disabled = false;
        if (loadingIndicator) loadingIndicator.classList.remove('show');
      }
    });
  }
  
  // 复制链接按钮 - 只复制链接
  if (copyButton) {
    copyButton.addEventListener('click', () => {
      if (!resultUrl || !resultUrl.dataset.originalUrl) {
        showErrorToast('没有可复制的链接');
        return;
      }
      
      // 始终只复制链接，不复制密码
      const textToCopy = resultUrl.dataset.originalUrl;
      console.log('要复制的链接:', textToCopy);
      
      // 使用传统的复制方法
      try {
        // 创建一个临时文本区域
        const textArea = document.createElement('textarea');
        textArea.value = textToCopy;
        textArea.style.position = 'fixed';  // 避免滚动到视图中
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        // 执行复制命令
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
          showSuccessToast('链接已复制到剪贴板');
          copyButton.classList.add('success-pulse');
          setTimeout(() => {
            copyButton.classList.remove('success-pulse');
          }, 500);
        } else {
          throw new Error('execCommand 复制失败');
        }
      } catch (error) {
        console.error('复制失败:', error);
        showErrorToast('复制链接失败');
      }
    });
  }
  
  // 预览按钮
  if (previewButton) {
    previewButton.addEventListener('click', () => {
      if (!resultUrl || !resultUrl.dataset.originalUrl) {
        showErrorToast('没有可预览的链接');
        return;
      }
      
      window.open(resultUrl.dataset.originalUrl, '_blank');
    });
  }
  
  // 密码区域点击复制功能
  if (generatedPassword) {
    generatedPassword.addEventListener('click', () => {
      if (!generatedPassword.textContent) {
        showErrorToast('没有可复制的密码');
        return;
      }
      
      const textToCopy = generatedPassword.textContent;
      // 使用传统的复制方法
      const copyToClipboard = (text) => {
        try {
          // 创建一个临时文本区域
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';  // 避免滚动到视图中
          textArea.style.left = '-999999px';
          textArea.style.top = '-999999px';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          
          // 执行复制命令
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          
          if (successful) {
            showSuccessToast('密码已复制到剪贴板');
            
            // 添加视觉反馈
            generatedPassword.classList.add('copied');
            setTimeout(() => {
              generatedPassword.classList.remove('copied');
            }, 500);
            
            return true;
          } else {
            throw new Error('execCommand 复制失败');
          }
        } catch (err) {
          console.error('复制失败:', err);
          showErrorToast('复制失败');
          return false;
        }
      };
      
      copyToClipboard(textToCopy);
    });
  }
  
  // 复制密码和链接按钮
  if (copyPasswordLink) {
    copyPasswordLink.addEventListener('click', (e) => {
      e.preventDefault(); // 防止默认的锚点行为
      
      if (!resultUrl || !resultUrl.dataset.originalUrl || !generatedPassword || !generatedPassword.textContent) {
        showErrorToast('没有可复制的内容');
        return;
      }
      
      const textToCopy = `链接: ${resultUrl.dataset.originalUrl}\n密码: ${generatedPassword.textContent}`;
      // 使用传统的复制方法
      const copyToClipboard = (text) => {
        try {
          // 创建一个临时文本区域
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';  // 避免滚动到视图中
          textArea.style.left = '-999999px';
          textArea.style.top = '-999999px';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          
          // 执行复制命令
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          
          if (successful) {
            showSuccessToast('链接和密码已复制到剪贴板');
            
            // 添加视觉反馈
            copyPasswordLink.classList.add('success-pulse');
            setTimeout(() => {
              copyPasswordLink.classList.remove('success-pulse');
            }, 500);
            
            return true;
          } else {
            throw new Error('execCommand 复制失败');
          }
        } catch (err) {
          console.error('复制失败:', err);
          showErrorToast('复制失败');
          return false;
        }
      };
      
      copyToClipboard(textToCopy);
    });
  }
  
  // 初始化完成
  console.log('应用初始化完成');
});
