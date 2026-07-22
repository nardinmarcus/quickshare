(function () {
  const editBtn = document.getElementById('edit-toggle-btn');
  const editForm = document.getElementById('edit-form');
  const contentTextarea = document.getElementById('content-textarea');
  const cancelBtn = document.getElementById('edit-cancel');
  const saveBtn = document.getElementById('edit-save');
  const clearExpiresBtn = document.getElementById('clear-expires');
  const protectedCheckbox = document.getElementById('edit-protected');
  const protectionHint = document.getElementById('protection-hint');
  const passwordInputWrap = document.getElementById('password-input-wrap');
  const passwordInput = document.getElementById('edit-password');
  const passwordHint = document.getElementById('edit-password-hint');
  const togglePasswordBtn = document.getElementById('toggle-password-visibility');
  const expiresInput = document.getElementById('edit-expires');
  const expiresHint = document.getElementById('edit-expires-hint');
  const titleDisplay = document.getElementById('page-title-display');
  const descriptionDisplayRow = document.getElementById('description-display-row');
  const descriptionDisplay = document.getElementById('description-display');
  const passwordDisplayRow = document.getElementById('password-display-row');
  const expiresDisplayRow = document.getElementById('expires-display-row');
  const statusDisplay = document.getElementById('status-display');
  const pageDataElement = document.getElementById('page-data');
  const renderedPreview = document.getElementById('rendered-preview');
  const adminTime = window.AdminTime;
  const customPasswordPattern = /^[A-Za-z0-9!@#$%^&*()_+\-=.,?~]{4,12}$/;
  const customPasswordError = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';
  let originalData = {};

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  try {
    originalData = JSON.parse(pageDataElement.textContent || '{}');
  } catch (error) {
    console.error('无法读取分享数据：', error);
  }

  function updateProtectionHint(isProtected) {
    protectionHint.textContent = isProtected
      ? '取消勾选将移除密码保护。'
      : '勾选后将启用密码保护。';
  }

  function updatePasswordInputVisibility() {
    passwordInputWrap.hidden = !protectedCheckbox.checked;
  }

  function resetPasswordVisibility() {
    passwordInput.type = 'password';
    togglePasswordBtn.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    togglePasswordBtn.setAttribute('aria-label', '显示密码');
  }

  function resetRenderedPreview() {
    renderedPreview.removeAttribute('src');
    delete renderedPreview.dataset.loaded;
  }

  function loadRenderedPreview() {
    if (renderedPreview.dataset.loaded) return;

    renderedPreview.src = '/view/' + encodeURIComponent(originalData.id) + '?adminPreview=' + Date.now();
    renderedPreview.dataset.loaded = 'true';
  }

  function resetForm() {
    document.getElementById('edit-title').value = originalData.title || '';
    document.getElementById('edit-description').value = originalData.description || '';
    expiresInput.value = originalData.expiresAt
      ? adminTime.toDateTimeLocal(originalData.expiresAt)
      : '';
    protectedCheckbox.checked = Boolean(originalData.isProtected);
    passwordInput.value = '';
    passwordInput.setAttribute('aria-invalid', 'false');
    passwordHint.textContent = '';
    passwordHint.className = 'field-hint';
    expiresHint.textContent = '';
    expiresHint.className = 'field-hint';
    resetPasswordVisibility();
    contentTextarea.value = originalData.htmlContent || '';
    updateProtectionHint(Boolean(originalData.isProtected));
    updatePasswordInputVisibility();
  }

  function enterEditMode() {
    editBtn.hidden = true;
    editForm.hidden = false;
    contentTextarea.removeAttribute('readonly');
    contentTextarea.classList.add('admin-content-editable');
    updatePasswordInputVisibility();
    document.getElementById('edit-title').focus();
  }

  function exitEditMode() {
    editBtn.hidden = false;
    editForm.hidden = true;
    contentTextarea.setAttribute('readonly', '');
    contentTextarea.classList.remove('admin-content-editable');
    resetForm();
    editBtn.focus();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateViewMode(data) {
    titleDisplay.textContent = data.title || data.id;

    if (data.description) {
      descriptionDisplayRow.hidden = false;
      descriptionDisplay.textContent = data.description;
    } else {
      descriptionDisplayRow.hidden = true;
      descriptionDisplay.textContent = '';
    }

    if (data.isProtected) {
      statusDisplay.innerHTML = '<span class="admin-status protected">密码保护</span>';
      passwordDisplayRow.hidden = false;
      document.getElementById('password-display').innerHTML = data.password
        ? '<code class="admin-password-value">' + escapeHtml(data.password) + '</code>'
        : '<span class="admin-muted">旧版分享无法查看密码</span>';
    } else {
      statusDisplay.innerHTML = '<span class="admin-status public">公开</span>';
      passwordDisplayRow.hidden = true;
    }

    if (data.expiresAt) {
      const date = new Date(Number(data.expiresAt));
      expiresDisplayRow.hidden = false;
      document.getElementById('expires-display').innerHTML =
        '<time datetime="' + date.toISOString() + '">' +
        adminTime.format(data.expiresAt) + '</time>';
    } else {
      expiresDisplayRow.hidden = true;
      document.getElementById('expires-display').innerHTML =
        '<span class="admin-muted">永不过期</span>';
    }
  }

  editBtn.addEventListener('click', enterEditMode);
  cancelBtn.addEventListener('click', exitEditMode);

  clearExpiresBtn.addEventListener('click', function () {
    expiresInput.value = '';
    expiresHint.textContent = '';
    expiresHint.className = 'field-hint';
    expiresInput.focus();
  });

  protectedCheckbox.addEventListener('change', function () {
    if (!protectedCheckbox.checked) {
      passwordInput.value = '';
      passwordInput.setAttribute('aria-invalid', 'false');
      passwordHint.textContent = '';
      passwordHint.className = 'field-hint';
      resetPasswordVisibility();
    }

    updateProtectionHint(protectedCheckbox.checked);
    updatePasswordInputVisibility();
  });

  passwordInput.addEventListener('input', function () {
    const password = passwordInput.value;

    if (!password) {
      passwordHint.textContent = '';
      passwordHint.className = 'field-hint';
      passwordInput.setAttribute('aria-invalid', 'false');
    } else if (!customPasswordPattern.test(password)) {
      passwordHint.textContent = customPasswordError;
      passwordHint.className = 'field-hint error';
      passwordInput.setAttribute('aria-invalid', 'true');
    } else {
      passwordHint.textContent = '密码格式有效';
      passwordHint.className = 'field-hint valid';
      passwordInput.setAttribute('aria-invalid', 'false');
    }
  });

  expiresInput.addEventListener('change', function () {
    const expiresAt = expiresInput.value
      ? adminTime.parseDateTimeLocal(expiresInput.value)
      : null;

    if (expiresInput.value && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
      expiresHint.textContent = '过期时间不能早于当前时间';
      expiresHint.className = 'field-hint error';
    } else {
      expiresHint.textContent = '';
      expiresHint.className = 'field-hint';
    }
  });

  togglePasswordBtn.addEventListener('click', function () {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    togglePasswordBtn.innerHTML = isHidden
      ? '<i class="fas fa-eye-slash" aria-hidden="true"></i>'
      : '<i class="fas fa-eye" aria-hidden="true"></i>';
    togglePasswordBtn.setAttribute('aria-label', isHidden ? '隐藏密码' : '显示密码');
  });

  editForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    const title = document.getElementById('edit-title').value.trim();
    const description = document.getElementById('edit-description').value.trim();
    const expiresAtValue = expiresInput.value;
    const expiresAt = expiresAtValue
      ? adminTime.parseDateTimeLocal(expiresAtValue)
      : null;
    const customPassword = passwordInput.value;

    if (protectedCheckbox.checked && customPassword && !customPasswordPattern.test(customPassword)) {
      passwordHint.textContent = customPasswordError;
      passwordHint.className = 'field-hint error';
      passwordInput.setAttribute('aria-invalid', 'true');
      Toast.error(customPasswordError);
      passwordInput.focus();
      return;
    }

    if (expiresAtValue && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
      expiresHint.textContent = '过期时间不能早于当前时间';
      expiresHint.className = 'field-hint error';
      Toast.error('请设置有效的过期时间');
      expiresInput.focus();
      return;
    }

    const payload = {
      title: title || null,
      description: description || null,
      htmlContent: contentTextarea.value,
      isProtected: protectedCheckbox.checked,
      expiresAt
    };
    const themeSelect = document.getElementById('edit-theme');

    if (themeSelect) payload.markdownTheme = themeSelect.value;
    if (protectedCheckbox.checked && customPassword) payload.password = customPassword;

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    editForm.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存修改失败');
      }

      originalData = {
        ...originalData,
        ...data.page,
        markdownTheme: data.page.markdownTheme || ''
      };
      updateViewMode(data.page);
      resetRenderedPreview();
      if (document.getElementById('tab-rendered').getAttribute('aria-selected') === 'true') {
        loadRenderedPreview();
      }
      exitEditMode();
      Toast.success('修改已保存');
    } catch (error) {
      Toast.error(error.message || '保存修改失败');
    } finally {
      editForm.setAttribute('aria-busy', 'false');
      saveBtn.disabled = false;
      saveBtn.textContent = '保存修改';
    }
  });

  const tabs = Array.from(document.querySelectorAll('.admin-tab'));

  function activateTab(tab, shouldFocus) {
    tabs.forEach(function (item) {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.setAttribute('tabindex', selected ? '0' : '-1');

      const panel = document.getElementById(item.getAttribute('aria-controls'));
      panel.classList.toggle('active', selected);
      panel.hidden = !selected;
    });

    if (shouldFocus) tab.focus();

    if (tab.dataset.tab === 'rendered') {
      loadRenderedPreview();
    }
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      activateTab(tab, false);
    });

    tab.addEventListener('keydown', function (event) {
      let nextIndex = index;

      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });
})();
