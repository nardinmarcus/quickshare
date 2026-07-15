(function () {
  'use strict';

  var toggle = document.getElementById('homepage-access-toggle');
  var state = document.getElementById('homepage-access-state');
  var stateIcon = state ? state.querySelector('i') : null;
  var stateText = state ? state.querySelector('span') : null;
  var status = document.getElementById('homepage-access-status');
  var modal = document.getElementById('homepage-access-confirm');
  var modalContent = modal ? modal.querySelector('.admin-modal-content') : null;
  var modalStatus = document.getElementById('homepage-access-confirm-status');
  var cancelButton = document.getElementById('homepage-access-cancel');
  var confirmButton = document.getElementById('homepage-access-confirm-button');
  var csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

  if (!toggle || !state || !stateIcon || !stateText || !status || !modal ||
      !modalContent || !modalStatus || !cancelButton || !confirmButton) {
    return;
  }

  var persistedPasswordRequired = toggle.checked;
  var lastFocusedElement = null;

  function focusableElements() {
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (element) {
      return !element.hidden;
    });
  }

  function updatePresentation(passwordRequired, message, isError) {
    toggle.checked = passwordRequired;
    state.dataset.state = passwordRequired ? 'locked' : 'public';
    stateIcon.className = passwordRequired ? 'fas fa-lock' : 'fas fa-globe';
    stateText.textContent = passwordRequired ? '需要密码' : '公开发布';
    status.textContent = message || ('当前：' + (passwordRequired ? '需要密码' : '公开发布'));
    status.classList.toggle('is-error', Boolean(isError));
  }

  function setBusy(isBusy) {
    if (isBusy) {
      toggle.disabled = true;
    } else {
      toggle.disabled = false;
    }

    confirmButton.disabled = isBusy;
    cancelButton.disabled = isBusy;
    modal.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  function closeConfirmModal(restoreToggle) {
    if (modal.getAttribute('aria-busy') === 'true') return;

    modal.hidden = true;
    modalStatus.textContent = '';

    if (restoreToggle) {
      toggle.checked = persistedPasswordRequired;
    }

    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
  }

  function openConfirmModal() {
    lastFocusedElement = document.activeElement;
    modalStatus.textContent = '';
    modal.hidden = false;
    modalContent.focus();
    cancelButton.focus();
  }

  async function readJson(response) {
    var contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      throw new Error('服务器返回了无法识别的响应');
    }

    return response.json();
  }

  async function savePasswordRequired(passwordRequired) {
    setBusy(true);
    status.classList.remove('is-error');
    status.textContent = '正在保存首页访问设置…';

    if (!modal.hidden) {
      modalStatus.textContent = '正在保存，请稍候…';
      modalStatus.focus();
    }

    try {
      var response = await fetch('/admin/settings/homepage-access', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ passwordRequired: passwordRequired })
      });
      var data = await readJson(response);

      if (!response.ok || data.success !== true) {
        if (response.status === 401) {
          throw new Error('登录已失效，请重新登录管理后台');
        }
        throw new Error(data.error || '保存失败');
      }

      if (typeof data.passwordRequired !== 'boolean' || typeof data.changed !== 'boolean' ||
          data.passwordRequired !== passwordRequired) {
        throw new Error('服务器返回了无效的设置状态');
      }

      persistedPasswordRequired = data.passwordRequired;
      updatePresentation(
        persistedPasswordRequired,
        '已保存：' + (persistedPasswordRequired ? '需要密码' : '公开发布'),
        false
      );
      setBusy(false);

      if (!modal.hidden) {
        closeConfirmModal(false);
      }
    } catch (error) {
      updatePresentation(
        persistedPasswordRequired,
        '保存失败：' + (error.message || '请稍后重试'),
        true
      );
      setBusy(false);

      if (!modal.hidden) {
        modalStatus.textContent = '保存失败。请重试或取消。';
        confirmButton.focus();
      } else {
        toggle.focus();
      }
    }
  }

  toggle.addEventListener('change', function () {
    if (toggle.checked === persistedPasswordRequired) return;

    if (!toggle.checked) {
      openConfirmModal();
      return;
    }

    savePasswordRequired(true);
  });

  confirmButton.addEventListener('click', function () {
    if (confirmButton.disabled) return;
    savePasswordRequired(false);
  });

  cancelButton.addEventListener('click', function () {
    closeConfirmModal(true);
  });

  modal.querySelector('.admin-modal-backdrop').addEventListener('click', function () {
    closeConfirmModal(true);
  });

  modal.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab') return;

    var elements = focusableElements();
    if (elements.length === 0) {
      event.preventDefault();
      return;
    }

    var first = elements[0];
    var last = elements[elements.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) {
      event.preventDefault();
      closeConfirmModal(true);
    }
  });
})();
