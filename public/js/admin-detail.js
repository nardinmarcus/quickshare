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

        updateViewMode(data.page);
        exitEditMode();
      } else {
        alert(data.error || 'Failed to save changes');
      }
    } catch (err) {
      alert('Network error: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
})();
