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
  const prepublishPreviewButton = document.getElementById('prepublish-preview-button');
  const resultSection = document.getElementById('result-section');
  const resultEyebrow = document.getElementById('result-eyebrow');
  const resultTitle = document.getElementById('result-title');
  const resultPageTitle = document.getElementById('result-page-title');
  const resultUrl = document.getElementById('result-url');
  const resultType = document.getElementById('result-type');
  const resultAccess = document.getElementById('result-access');
  const resultExpiry = document.getElementById('result-expiry');
  const copyButton = document.getElementById('copy-button');
  const openShareButton = document.getElementById('open-share-button');
  const continueButton = document.getElementById('continue-button');
  const manualCopyOutput = document.getElementById('manual-copy-output');
  const publishStatus = document.getElementById('publish-status');
  const publishError = document.getElementById('publish-error');
  const publishPreview = document.getElementById('publish-preview');
  const publishPreviewTitle = document.getElementById('publish-preview-title');
  const publishPreviewFrame = document.getElementById('publish-preview-frame');
  const openPublishPreviewLink = document.getElementById('open-publish-preview');
  const closePublishPreviewButton = document.getElementById('close-publish-preview');
  const loadingIndicator = document.getElementById('loading-indicator');
  const linkAccessRadio = document.getElementById('access-link');
  const passwordToggle = document.getElementById('password-toggle');
  const passwordSettings = document.getElementById('password-settings');
  const passwordModeSummary = document.getElementById('password-mode-summary');
  const generatedPassword = document.getElementById('generated-password');
  const resultPasswordRow = document.getElementById('result-password-row');
  const copyPasswordButton = document.getElementById('copy-password-button');
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
  let isPreviewing = false;
  let previewRequestVersion = 0;
  let previewAbortController = null;
  let previewObjectUrl = null;
  let hasPublishedResult = false;
  let draftVersion = 0;
  
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
        markDraftDirty();
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
      resetPublishedState();
      closePublishPreview(false);
      setPublishState('idle', '准备发布');
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

  function setPublishState(state, message) {
    if (publishStatus) {
      publishStatus.dataset.state = state;
      publishStatus.textContent = message;
    }

    if (publishError) {
      const isError = state === 'error';
      publishError.textContent = isError ? message : '';
      publishError.classList.toggle('hidden', !isError);
    }
  }

  function reportPublishError(message, focusTarget) {
    setPublishState('error', message);

    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    } else if (publishError) {
      publishError.focus();
    }
  }

  function setButtonBusy(button, busy, busyLabel, idleMarkup) {
    if (!button) return;

    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    button.innerHTML = busy
      ? `<i class="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>${busyLabel}`
      : idleMarkup;
  }

  function hideManualCopy() {
    if (!manualCopyOutput) return;

    manualCopyOutput.hidden = true;
    manualCopyOutput.value = '';
  }

  async function copyText(text) {
    if (!text) return false;

    hideManualCopy();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        console.warn('Clipboard API unavailable, using fallback:', error);
      }
    }

    let textArea;

    try {
      textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();

      if (document.execCommand('copy')) {
        return true;
      }
    } catch (error) {
      console.warn('Clipboard fallback failed:', error);
    } finally {
      if (textArea) textArea.remove();
    }

    if (manualCopyOutput) {
      manualCopyOutput.value = text;
      manualCopyOutput.hidden = false;
      manualCopyOutput.focus();
      manualCopyOutput.select();
    }
    showErrorToast('自动复制失败，请从下方文本框手动复制');
    return false;
  }

  function cancelPendingPreview() {
    previewRequestVersion += 1;
    if (previewAbortController) previewAbortController.abort();
    previewAbortController = null;
    isPreviewing = false;

    setButtonBusy(
      prepublishPreviewButton,
      false,
      '生成预览中…',
      '<i class="fas fa-eye mr-1" aria-hidden="true"></i>安全预览'
    );
    if (prepublishPreviewButton) prepublishPreviewButton.disabled = isSubmitting;
    if (generateButton && !isSubmitting) generateButton.disabled = false;
  }

  function clearOpenPreviewDocument() {
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }

    if (openPublishPreviewLink) {
      openPublishPreviewLink.removeAttribute('href');
      openPublishPreviewLink.hidden = true;
    }
  }

  function setOpenPreviewDocument(safeDocument) {
    clearOpenPreviewDocument();
    if (!openPublishPreviewLink) return;

    previewObjectUrl = URL.createObjectURL(new Blob([safeDocument], { type: 'text/html' }));
    openPublishPreviewLink.href = previewObjectUrl;
    openPublishPreviewLink.hidden = false;
  }

  function closePublishPreview(restoreFocus = true, cancelRequest = true) {
    if (cancelRequest) cancelPendingPreview();
    if (publishPreview) publishPreview.hidden = true;
    if (publishPreviewFrame) publishPreviewFrame.removeAttribute('srcdoc');
    clearOpenPreviewDocument();
    if (restoreFocus && prepublishPreviewButton) prepublishPreviewButton.focus();
  }

  function markDraftDirty() {
    draftVersion += 1;

    if (isPreviewing || (publishPreview && !publishPreview.hidden)) {
      closePublishPreview(false);
    }

    if (hasPublishedResult) {
      if (resultEyebrow) resultEyebrow.textContent = '上次发布结果';
      if (resultSection) resultSection.dataset.status = 'previous';
      setPublishState('idle', '草稿已修改，下方链接仍指向上次发布的内容');
      return;
    }

    setPublishState('idle', '内容已更改，可以预览或发布');
  }

  function resetPasswordVisibility() {
    if (customPasswordInput) customPasswordInput.type = 'password';
    if (toggleCustomPasswordBtn) {
      toggleCustomPasswordBtn.setAttribute('aria-label', '显示密码');
      toggleCustomPasswordBtn.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    }
  }

  function resetPublishedState() {
    if (resultSection) {
      resultSection.classList.add('hidden');
      resultSection.classList.remove('fade-in', 'glow-effect', 'flow-effect');
      resultSection.dataset.status = 'current';
    }
    hasPublishedResult = false;
    if (resultEyebrow) resultEyebrow.textContent = '发布回执';
    if (resultUrl) {
      resultUrl.textContent = '';
      resultUrl.dataset.originalUrl = '';
      resultUrl.removeAttribute('href');
    }
    if (resultPageTitle) resultPageTitle.textContent = '';
    if (resultType) resultType.textContent = '—';
    if (resultAccess) resultAccess.textContent = '—';
    if (resultExpiry) resultExpiry.textContent = '—';
    showResultPassword(null);
    hideManualCopy();
  }

  function resetCreationForm() {
    if (htmlInput) htmlInput.value = '';
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = '';
    if (shareTitleInput) shareTitleInput.value = '';
    if (shareDescriptionInput) shareDescriptionInput.value = '';
    if (shareExpiresInput) shareExpiresInput.value = '';
    if (shareExpiresHint) {
      shareExpiresHint.textContent = '';
      shareExpiresHint.className = 'field-hint';
    }
    if (linkAccessRadio) linkAccessRadio.checked = true;
    if (passwordToggle) passwordToggle.checked = false;
    if (customPasswordInput) {
      customPasswordInput.value = '';
      customPasswordInput.setAttribute('aria-invalid', 'false');
    }

    const themeSelect = document.getElementById('markdown-theme');
    if (themeSelect) themeSelect.value = 'bytedance';

    draftVersion = 0;
    userCustomPassword = '';
    resetPasswordVisibility();
    updatePasswordHint('');
    showPasswordDefaultMode();
    syncPasswordSettings();
    resetPublishedState();
    closePublishPreview(false);
    syncToTextarea();
    setPublishState('idle', '准备发布');
    if (htmlInput) htmlInput.focus();
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
    if (copyPasswordLink) {
      copyPasswordLink.classList.toggle('hidden', !password);
    }
  }

  if (passwordToggle) {
    passwordToggle.addEventListener('change', () => {
      syncPasswordSettings();
      markDraftDirty();
    });
  }
  if (linkAccessRadio) {
    linkAccessRadio.addEventListener('change', () => {
      syncPasswordSettings();
      markDraftDirty();
    });
  }

  // "自定义密码"按钮 → 切换到输入模式
  if (useCustomPasswordBtn) {
    useCustomPasswordBtn.addEventListener('click', () => {
      showPasswordCustomMode();
      markDraftDirty();
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
      markDraftDirty();
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
      markDraftDirty();
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
      markDraftDirty();
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

  [shareTitleInput, shareDescriptionInput, shareExpiresInput].forEach((field) => {
    if (field) field.addEventListener('input', markDraftDirty);
  });

  const markdownThemeSelect = document.getElementById('markdown-theme');
  if (markdownThemeSelect) markdownThemeSelect.addEventListener('change', markDraftDirty);

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
      markDraftDirty();
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

  function buildPreviewRequest() {
    syncToTextarea();

    const htmlContent = htmlInput ? htmlInput.value.trim() : '';
    if (!htmlContent) {
      const error = userFacingError('请输入要分享的内容');
      error.focusTarget = htmlInput;
      throw error;
    }

    const codeType = detectCodeType(htmlContent);
    const requestBody = {
      htmlContent,
      codeType,
      title: shareTitleInput ? shareTitleInput.value : '',
      description: shareDescriptionInput ? shareDescriptionInput.value : ''
    };

    if (codeType === 'markdown') {
      const themeSelect = document.getElementById('markdown-theme');
      requestBody.markdownTheme = themeSelect ? themeSelect.value : 'random';
    }

    return requestBody;
  }

  function buildPublishRequest() {
    const requestBody = buildPreviewRequest();
    const isProtected = Boolean(passwordToggle && passwordToggle.checked);

    if (isProtected && passwordCustomMode && !passwordCustomMode.classList.contains('hidden')) {
      const password = customPasswordInput ? customPasswordInput.value : '';
      const validationError = passwordValidationError(password);

      if (validationError) {
        updatePasswordHint(password);
        const error = userFacingError(validationError);
        error.focusTarget = customPasswordInput;
        throw error;
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
        const error = userFacingError('到期时间必须晚于当前时间');
        error.focusTarget = shareExpiresInput;
        throw error;
      }
    }

    requestBody.isProtected = isProtected;
    requestBody.expiresAt = expiresAt;
    if (isProtected && userCustomPassword) requestBody.password = userCustomPassword;

    return requestBody;
  }

  function showPublishedResult(data) {
    const url = `${window.location.origin}/view/${data.urlId}`;
    const typeLabels = {
      html: 'HTML',
      markdown: 'Markdown',
      svg: 'SVG',
      mermaid: 'Mermaid'
    };

    if (resultUrl) {
      resultUrl.textContent = url;
      resultUrl.href = url;
      resultUrl.dataset.originalUrl = url;
    }
    if (resultPageTitle) resultPageTitle.textContent = data.title || '未命名分享';
    if (resultType) resultType.textContent = typeLabels[data.codeType] || 'HTML';
    if (resultAccess) resultAccess.textContent = data.isProtected ? '密码保护' : '持有链接可访问';
    if (resultExpiry) {
      resultExpiry.textContent = data.expiresAt
        ? new Date(Number(data.expiresAt)).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
        : '长期有效';
    }

    hasPublishedResult = true;
    hideManualCopy();
    if (resultEyebrow) resultEyebrow.textContent = '发布回执';
    showResultPassword(data.isProtected ? data.password : null);
    closePublishPreview(false, false);

    if (resultSection) {
      resultSection.dataset.status = 'current';
      resultSection.classList.remove('hidden');
      resultSection.classList.add('fade-in');
    }
    if (resultTitle) resultTitle.focus();
  }

  if (prepublishPreviewButton) {
    prepublishPreviewButton.addEventListener('click', async () => {
      if (prepublishPreviewButton.disabled || isSubmitting || isPreviewing) return;

      let requestVersion = null;

      try {
        const requestBody = buildPreviewRequest();
        cancelPendingPreview();
        requestVersion = ++previewRequestVersion;
        previewAbortController = new AbortController();
        isPreviewing = true;
        if (generateButton) generateButton.disabled = true;
        setPublishState('busy', '正在生成安全预览…');
        setButtonBusy(
          prepublishPreviewButton,
          true,
          '生成预览中…',
          '<i class="fas fa-eye mr-1" aria-hidden="true"></i>安全预览'
        );

        const response = await fetch('/api/pages/preview', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(requestBody),
          signal: previewAbortController.signal
        });
        const data = await response.json().catch(() => null);

        if (requestVersion !== previewRequestVersion) return;

        if (!response.ok || !data?.success) {
          throw userFacingError(data?.error || '预览生成失败，请稍后重试');
        }

        if (publishPreviewFrame) publishPreviewFrame.srcdoc = data.document;
        setOpenPreviewDocument(data.document);
        if (publishPreview) publishPreview.hidden = false;
        setPublishState('success', '预览已更新，确认无误后即可发布');
        if (publishPreviewTitle) publishPreviewTitle.focus();
      } catch (error) {
        if (error.name === 'AbortError' || (requestVersion && requestVersion !== previewRequestVersion)) {
          return;
        }
        reportPublishError(
          error.userFacing ? error.message : '预览生成失败，请稍后重试',
          error.focusTarget
        );
      } finally {
        if (requestVersion === previewRequestVersion) {
          previewAbortController = null;
          isPreviewing = false;
          setButtonBusy(
            prepublishPreviewButton,
            false,
            '生成预览中…',
            '<i class="fas fa-eye mr-1" aria-hidden="true"></i>安全预览'
          );
          if (generateButton && !isSubmitting) generateButton.disabled = false;
        }
      }
    });
  }

  if (closePublishPreviewButton) {
    closePublishPreviewButton.addEventListener('click', () => {
      closePublishPreview();
      setPublishState('idle', '预览已关闭，可以继续编辑或发布');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && publishPreview && !publishPreview.hidden) {
      closePublishPreview();
      setPublishState('idle', '预览已关闭，可以继续编辑或发布');
    }
  });

  if (generateButton) {
    generateButton.addEventListener('click', async () => {
      if (isSubmitting || isPreviewing) return;

      let submittedDraftVersion = null;

      try {
        const requestBody = buildPublishRequest();
        submittedDraftVersion = draftVersion;
        isSubmitting = true;
        closePublishPreview(false);
        if (prepublishPreviewButton) prepublishPreviewButton.disabled = true;
        setPublishState('busy', '正在发布并生成链接…');
        setButtonBusy(
          generateButton,
          true,
          '发布中…',
          '<i class="fas fa-link mr-1" aria-hidden="true"></i>发布并生成链接'
        );

        const response = await fetch('/api/pages/create', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(requestBody)
        });
        const data = await response.json().catch(() => null);

        if (!response.ok || !data?.success) {
          throw userFacingError(data?.error || '发布失败，请稍后重试');
        }

        showPublishedResult(data);
        if (submittedDraftVersion === draftVersion) {
          setPublishState('success', '发布成功，分享链接已生成');
        } else {
          if (resultEyebrow) resultEyebrow.textContent = '上次发布结果';
          if (resultSection) resultSection.dataset.status = 'previous';
          setPublishState('idle', '发布已完成，但当前草稿随后有修改；下方链接对应提交时的内容');
        }
        showSuccessToast('发布成功');
      } catch (error) {
        reportPublishError(
          error.userFacing ? error.message : '发布失败，请稍后重试',
          error.focusTarget
        );
      } finally {
        isSubmitting = false;
        setButtonBusy(
          generateButton,
          false,
          '发布中…',
          '<i class="fas fa-link mr-1" aria-hidden="true"></i>发布并生成链接'
        );
        if (prepublishPreviewButton) prepublishPreviewButton.disabled = false;
      }
    });
  }

  if (openShareButton) {
    openShareButton.addEventListener('click', () => {
      const url = resultUrl?.dataset.originalUrl;
      if (url) window.open(url, '_blank', 'noopener');
    });
  }

  if (copyButton) {
    copyButton.addEventListener('click', async () => {
      const copied = await copyText(resultUrl?.dataset.originalUrl);
      if (copied) showSuccessToast('链接已复制到剪贴板');
    });
  }

  if (copyPasswordButton) {
    copyPasswordButton.addEventListener('click', async () => {
      const copied = await copyText(generatedPassword?.textContent);
      if (copied) showSuccessToast('密码已复制到剪贴板');
    });
  }

  if (copyPasswordLink) {
    copyPasswordLink.addEventListener('click', async () => {
      const url = resultUrl?.dataset.originalUrl;
      const password = generatedPassword?.textContent;
      const copied = await copyText(url && password ? `链接: ${url}\n密码: ${password}` : '');
      if (copied) showSuccessToast('密码和链接已复制到剪贴板');
    });
  }

  if (continueButton) {
    continueButton.addEventListener('click', resetCreationForm);
  }
  
  // 初始化完成
  console.log('应用初始化完成');
});
