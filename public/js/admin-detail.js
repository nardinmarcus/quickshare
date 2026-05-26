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
  const togglePasswordBtn = document.getElementById('toggle-password-visibility');

  const titleDisplay = document.getElementById('page-title-display');
  const descriptionDisplayRow = document.getElementById('description-display-row');
  const descriptionDisplay = document.getElementById('description-display');
  const passwordDisplayRow = document.getElementById('password-display-row');
  const expiresDisplayRow = document.getElementById('expires-display-row');
  const statusDisplay = document.getElementById('status-display');

  let isEditing = false;
  const originalData = window.pageData || {};

  function enterEditMode() {
    isEditing = true;
    editBtn.hidden = true;
    editForm.hidden = false;
    contentTextarea.removeAttribute('readonly');
    contentTextarea.classList.add('admin-content-editable');
    updatePasswordInputVisibility();
  }

  function exitEditMode() {
    isEditing = false;
    editBtn.hidden = false;
    editForm.hidden = true;
    contentTextarea.setAttribute('readonly', '');
    contentTextarea.classList.remove('admin-content-editable');
    resetForm();
  }

  function resetForm() {
    document.getElementById('edit-title').value = originalData.title || '';
    document.getElementById('edit-description').value = originalData.description || '';
    const expiresInput = document.getElementById('edit-expires');
    if (originalData.expiresAt) {
      expiresInput.value = new Date(originalData.expiresAt).toISOString().slice(0, 16);
    } else {
      expiresInput.value = '';
    }
    protectedCheckbox.checked = originalData.isProtected;
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.type = 'password';
    }
    if (togglePasswordBtn) {
      togglePasswordBtn.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    }
    contentTextarea.value = originalData.htmlContent || '';
    updateProtectionHint(originalData.isProtected);
    updatePasswordInputVisibility();
  }

  function updateProtectionHint(isProtected) {
    if (isProtected) {
      protectionHint.textContent = 'Unchecking will remove password protection.';
    } else {
      protectionHint.textContent = 'Checking will enable password protection.';
    }
  }

  function updatePasswordInputVisibility() {
    if (passwordInputWrap) {
      passwordInputWrap.hidden = !protectedCheckbox.checked;
    }
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
      statusDisplay.innerHTML = '<span class="admin-status protected">Protected</span>';
      passwordDisplayRow.hidden = false;
      if (data.password) {
        document.getElementById('password-display').innerHTML =
          '<code class="admin-password-value">' + escapeHtml(data.password) + '</code>';
      } else {
        document.getElementById('password-display').innerHTML =
          '<span class="admin-muted">Unavailable for legacy share</span>';
      }
    } else {
      statusDisplay.innerHTML = '<span class="admin-status public">Public</span>';
      passwordDisplayRow.hidden = true;
    }

    if (data.expiresAt) {
      expiresDisplayRow.hidden = false;
      const date = new Date(Number(data.expiresAt));
      document.getElementById('expires-display').innerHTML =
        '<time datetime="' + date.toISOString() + '">' +
        date.toLocaleString('zh-CN', { hour12: false }) + '</time>';
    } else {
      expiresDisplayRow.hidden = true;
      document.getElementById('expires-display').innerHTML =
        '<span class="admin-muted">Never</span>';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  editBtn.addEventListener('click', enterEditMode);
  cancelBtn.addEventListener('click', exitEditMode);

  clearExpiresBtn.addEventListener('click', function () {
    document.getElementById('edit-expires').value = '';
  });

  protectedCheckbox.addEventListener('change', function () {
    updateProtectionHint(protectedCheckbox.checked);
    updatePasswordInputVisibility();
  });

  // Inline password validation
  var passwordHint = document.getElementById('edit-password-hint');
  if (passwordInput && passwordHint) {
    passwordInput.addEventListener('input', function () {
      var len = passwordInput.value.length;
      if (len === 0) {
        passwordHint.textContent = '';
        passwordHint.className = 'field-hint';
      } else if (len < 4) {
        passwordHint.textContent = 'Password must be at least 4 characters';
        passwordHint.className = 'field-hint error';
      } else if (len > 50) {
        passwordHint.textContent = 'Password must not exceed 50 characters';
        passwordHint.className = 'field-hint error';
      } else {
        passwordHint.textContent = '✓';
        passwordHint.className = 'field-hint valid';
      }
    });
  }

  // Inline expires validation
  var expiresInput = document.getElementById('edit-expires');
  var expiresHint = document.getElementById('edit-expires-hint');
  if (expiresInput && expiresHint) {
    expiresInput.addEventListener('change', function () {
      var val = expiresInput.value;
      if (val && new Date(val).getTime() < Date.now()) {
        expiresHint.textContent = 'Expiration time is in the past';
        expiresHint.className = 'field-hint error';
      } else {
        expiresHint.textContent = '';
        expiresHint.className = 'field-hint';
      }
    });
  }

  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', function () {
      const isHidden = passwordInput.type === 'password';
      passwordInput.type = isHidden ? 'text' : 'password';
      togglePasswordBtn.innerHTML = isHidden
        ? '<i class="fas fa-eye-slash" aria-hidden="true"></i>'
        : '<i class="fas fa-eye" aria-hidden="true"></i>';
    });
  }

  editForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const title = document.getElementById('edit-title').value.trim();
    const description = document.getElementById('edit-description').value.trim();
    const htmlContent = contentTextarea.value;
    const expiresAtValue = document.getElementById('edit-expires').value;
    const isProtected = protectedCheckbox.checked;
    const customPassword = passwordInput ? passwordInput.value.trim() : '';

    const payload = {
      title: title || null,
      description: description || null,
      htmlContent: htmlContent,
      isProtected: isProtected
    };

    var themeSelect = document.getElementById('edit-theme');
    if (themeSelect) {
      payload.markdownTheme = themeSelect.value;
    }

    if (expiresAtValue) {
      payload.expiresAt = new Date(expiresAtValue).getTime();
    } else {
      payload.expiresAt = null;
    }

    if (customPassword) {
      payload.password = customPassword;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.success) {
        originalData.title = data.page.title;
        originalData.description = data.page.description;
        originalData.htmlContent = data.page.htmlContent;
        originalData.isProtected = data.page.isProtected;
        originalData.expiresAt = data.page.expiresAt;
        originalData.password = data.page.password;
        originalData.markdownTheme = data.page.markdownTheme || '';

        updateViewMode(data.page);
        exitEditMode();
      } else {
        Toast.error(data.error || 'Failed to save changes');
      }
    } catch (err) {
      Toast.error('Network error: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
})();

// ===== Tab 切换 =====
document.querySelectorAll('.admin-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    var targetPanel = tab.dataset.tab;

    document.querySelectorAll('.admin-tab').forEach(function (t) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    document.querySelectorAll('.admin-tab-panel').forEach(function (p) {
      p.classList.remove('active');
      p.hidden = true;
    });
    var panel = document.querySelector('[data-panel="' + targetPanel + '"]');
    panel.classList.add('active');
    panel.hidden = false;

    if (targetPanel === 'rendered') {
      var iframe = document.getElementById('rendered-preview');
      if (iframe && !iframe.dataset.loaded) {
        iframe.src = '/view/' + window.pageData.id;
        iframe.dataset.loaded = 'true';
      }
    }
  });
});
