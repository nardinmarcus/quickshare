function dashboardCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

window.Toast = {
  container: null,

  init: function () {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', '通知');
    document.body.appendChild(this.container);
  },

  show: function (message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    this.init();

    var toast = document.createElement('div');
    var icons = { success: 'fa-check', error: 'fa-times', info: 'fa-info' };
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = '<i class="fas ' + icons[type] + '" aria-hidden="true"></i>';

    var content = document.createElement('span');
    content.className = 'toast-content';
    content.textContent = message;

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭通知');
    close.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';

    var progress = document.createElement('div');
    progress.className = 'toast-progress';
    progress.style.width = '100%';

    toast.append(icon, content, close, progress);
    this.container.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('show'); });

    var startTime = Date.now();
    var timer = setInterval(function () {
      var elapsed = Date.now() - startTime;
      var remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      progress.style.width = remaining + '%';
      if (remaining <= 0) clearInterval(timer);
    }, 50);

    var self = this;
    var autoClose = setTimeout(function () { self.dismiss(toast, timer); }, duration);

    close.addEventListener('click', function () {
      clearTimeout(autoClose);
      clearInterval(timer);
      self.dismiss(toast);
    });
  },

  dismiss: function (toast, timer) {
    if (timer) clearInterval(timer);
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 350);
  },

  success: function (message, duration) { this.show(message, 'success', duration); },
  error: function (message, duration) { this.show(message, 'error', duration); },
  info: function (message, duration) { this.show(message, 'info', duration); }
};

(function initAdminPages() {
  var pagesContext = document.getElementById('admin-pages-context');
  var searchForm = document.getElementById('admin-search-form');
  var searchInput = document.getElementById('admin-search-input');
  var jumpInput = document.getElementById('jump-page-input');
  var jumpBtn = document.getElementById('jump-page-btn');
  var dateFromInput = document.getElementById('filter-date-from');
  var dateToInput = document.getElementById('filter-date-to');
  var dateFilterBtn = document.getElementById('date-filter-btn');

  function adminPageParams() {
    var source = pagesContext && pagesContext.dataset.adminPagesUrl
      ? pagesContext.dataset.adminPagesUrl
      : '/admin/pages' + window.location.search;

    return new URL(source, window.location.origin).searchParams;
  }

  function navigateAdminPages(params) {
    var query = params.toString();
    window.location.href = query ? '/admin/pages?' + query : '/admin/pages';
  }

  if (searchForm && searchInput) {
    searchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var params = adminPageParams();

      if (searchInput.value) params.set('search', searchInput.value);
      else params.delete('search');

      params.delete('page');
      navigateAdminPages(params);
    });
  }

  if (jumpInput && jumpBtn) {
    function doJump() {
      var page = parseInt(jumpInput.value, 10);
      if (!Number.isFinite(page) || page < 1) return;

      var maxPage = parseInt(jumpInput.max, 10) || 1;
      var params = adminPageParams();
      params.set('page', Math.min(page, maxPage));
      navigateAdminPages(params);
    }

    jumpBtn.addEventListener('click', doJump);
    jumpInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') doJump();
    });
  }

  if (dateFilterBtn && dateFromInput && dateToInput) {
    dateFilterBtn.addEventListener('click', function () {
      var params = adminPageParams();

      if (dateFromInput.value) params.set('dateFrom', dateFromInput.value);
      else params.delete('dateFrom');

      if (dateToInput.value) params.set('dateTo', dateToInput.value);
      else params.delete('dateTo');

      params.delete('page');
      navigateAdminPages(params);
    });
  }

  var modal = document.getElementById('delete-modal');
  var modalTarget = document.getElementById('delete-modal-target');
  var confirmBtn = document.getElementById('delete-modal-confirm');
  var cancelBtn = document.getElementById('delete-modal-cancel');
  var modalStatus = document.getElementById('delete-modal-status');

  if (!modal || !modalTarget || !confirmBtn || !cancelBtn || !modalStatus) return;

  var pendingDelete = null;
  var lastFocusedElement = null;

  function focusableElements() {
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (element) {
      return !element.hidden && element.getAttribute('aria-hidden') !== 'true';
    });
  }

  function openDeleteModal(target, onConfirm, trigger) {
    modalTarget.textContent = target;
    pendingDelete = onConfirm;
    lastFocusedElement = trigger || document.activeElement;
    confirmBtn.disabled = false;
    confirmBtn.textContent = '删除';
    cancelBtn.disabled = false;
    modalStatus.textContent = '';
    modal.setAttribute('aria-busy', 'false');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    cancelBtn.focus();
  }

  function closeDeleteModal() {
    if (modal.hidden) return;
    if (modal.getAttribute('aria-busy') === 'true') return;

    modal.hidden = true;
    document.body.style.overflow = '';
    modalTarget.textContent = '';
    confirmBtn.disabled = false;
    confirmBtn.textContent = '删除';
    cancelBtn.disabled = false;
    modalStatus.textContent = '';
    modal.setAttribute('aria-busy', 'false');
    pendingDelete = null;

    if (lastFocusedElement && document.contains(lastFocusedElement)) {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }

  document.querySelectorAll('.admin-delete-btn[data-page-id]').forEach(function (button) {
    button.addEventListener('click', function () {
      var pageId = button.dataset.pageId;
      var pageTitle = button.dataset.pageTitle || pageId;

      openDeleteModal(pageTitle, async function () {
        var response = await fetch('/admin/pages/' + encodeURIComponent(pageId), {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            'X-CSRF-Token': dashboardCsrfToken()
          }
        });
        var data = await readJson(response);

        if (!response.ok || !data.success) {
          throw new Error(data.error || '删除分享失败');
        }

        Toast.success('分享已删除');
        setTimeout(function () { window.location.reload(); }, 800);
      }, button);
    });
  });

  var selectAll = document.getElementById('select-all');
  var toolbar = document.getElementById('batch-toolbar');
  var countSpan = document.getElementById('batch-count');
  var batchDeleteBtn = document.getElementById('batch-delete-btn');
  var batchCancelBtn = document.getElementById('batch-cancel-btn');
  var checkboxes = Array.from(document.querySelectorAll('.row-checkbox'));

  function selectedIds() {
    return checkboxes
      .filter(function (checkbox) { return checkbox.checked; })
      .map(function (checkbox) { return checkbox.dataset.id; });
  }

  function updateToolbar() {
    if (!selectAll || !toolbar || !countSpan || !batchDeleteBtn) return;

    var count = selectedIds().length;
    countSpan.textContent = '已选择 ' + count + ' 项';
    batchDeleteBtn.disabled = count === 0;
    toolbar.hidden = count === 0;
    selectAll.checked = count > 0 && count === checkboxes.length;
    selectAll.indeterminate = count > 0 && count < checkboxes.length;
  }

  if (selectAll && toolbar && countSpan && batchDeleteBtn && batchCancelBtn && checkboxes.length > 0) {
    selectAll.addEventListener('change', function () {
      checkboxes.forEach(function (checkbox) {
        checkbox.checked = selectAll.checked;
      });
      updateToolbar();
    });

    checkboxes.forEach(function (checkbox) {
      checkbox.addEventListener('change', updateToolbar);
    });

    batchCancelBtn.addEventListener('click', function () {
      checkboxes.forEach(function (checkbox) {
        checkbox.checked = false;
      });
      updateToolbar();
      selectAll.focus();
    });

    batchDeleteBtn.addEventListener('click', function () {
      var ids = selectedIds();
      if (ids.length === 0) return;

      openDeleteModal(ids.length + ' 个分享', async function () {
        var response = await fetch('/admin/pages/batch', {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': dashboardCsrfToken()
          },
          body: JSON.stringify({ ids: ids })
        });
        var data = await readJson(response);

        if (!response.ok || !data.success) {
          throw new Error(data.error || '批量删除失败');
        }

        Toast.success('已删除 ' + data.deleted + ' 个分享');
        setTimeout(function () { window.location.reload(); }, 800);
      }, batchDeleteBtn);
    });
  }

  confirmBtn.addEventListener('click', async function () {
    if (!pendingDelete || confirmBtn.disabled) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = '删除中…';
    cancelBtn.disabled = true;
    modalStatus.textContent = '正在删除，请稍候…';
    modal.setAttribute('aria-busy', 'true');
    modalStatus.focus();

    try {
      await pendingDelete();
    } catch (error) {
      Toast.error(error.message || '删除失败');
      modal.setAttribute('aria-busy', 'false');
      confirmBtn.disabled = false;
      confirmBtn.textContent = '删除';
      cancelBtn.disabled = false;
      modalStatus.textContent = '删除失败，请重试或取消。';
      confirmBtn.focus();
    }
  });

  cancelBtn.addEventListener('click', closeDeleteModal);
  modal.querySelector('.admin-modal-backdrop').addEventListener('click', closeDeleteModal);

  modal.addEventListener('keydown', function (event) {
    if (event.key === 'Tab') {
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
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) {
      event.preventDefault();
      closeDeleteModal();
    }
  });
})();

/*
 * Publish operation identity and owner review (#24 §8, #32).
 */
(function () {
  'use strict';

  var REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  var NAMESPACE_LABELS = {
    'managed-key': '托管密钥',
    'legacy-key': '旧版密钥',
    'publish-session': '网页发布会话',
    'dashboard-session': '后台会话'
  };

  // RFC 4122 UUID v4 (8-4-4-4-12, version 4, IEEE-802 variant), matching
  // #24 L207. crypto.randomUUID is used where available.
  function generateRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var hex = '';
    bytes.forEach(function (byte) { hex += (byte + 0x100).toString(16).slice(1); });
    return hex.slice(0, 8)
      + '-' + hex.slice(8, 12)
      + '-4' + hex.slice(13, 16)
      + '-' + ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20)
      + '-' + hex.slice(20, 32);
  }

  // Every dashboard clone click is one explicit intent: generate the request
  // id at submit time so a lost response can be retried by resubmitting the
  // same form intent (the browser resends the same hidden value only if the
  // id was kept; a fresh click gets a fresh id). Guarded so non-browser
  // harnesses without event delegation still load the rest of admin.js.
  // Clone intents persist {requestId, target} so a LOST clone response has a
  // real retry path: resubmitting the same form intent reuses the id. The
  // server marks completion with a readable, non-sensitive cookie
  // (clone_intent_done=<requestId>); only a COMPLETED intent rotates — an
  // unconfirmed one stays in the field so the retry reaches the server.
  var CLONE_INTENT_STORAGE_KEY = 'quickshare.clone.intent';

  function readCloneIntent() {
    try {
      return JSON.parse(window.sessionStorage.getItem(CLONE_INTENT_STORAGE_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function cloneCompletionCookieFor(requestId) {
    var cookies = String(window.document.cookie || '').split(';');
    for (var i = 0; i < cookies.length; i += 1) {
      var parts = cookies[i].trim().split('=');
      if (parts[0] === 'clone_intent_done' && parts.slice(1).join('=') === requestId) {
        return true;
      }
    }
    return false;
  }

  function reconcileCloneIntents() {
    var intent = readCloneIntent();
    if (!intent) return;
    if (cloneCompletionCookieFor(intent.requestId)) {
      try {
        window.sessionStorage.removeItem(CLONE_INTENT_STORAGE_KEY);
      } catch (error) { /* ignore */ }
      document.querySelectorAll('[data-clone-request-id]').forEach(function (field) {
        var form = field.closest && field.closest('form[data-clone-form]');
        if (form && form.action && form.action.indexOf('/admin/pages/' + intent.targetId + '/clone') !== -1) {
          field.value = '';
        }
      });
    }
    // Unconfirmed intents deliberately KEEP the hidden field value so the
    // next submit retries the SAME clone request id.
  }

  window.QuickShareCloneIntents = {
    state: readCloneIntent,
    reconcile: reconcileCloneIntents,
    persist: function (requestId, targetId) {
      try {
        window.sessionStorage.setItem(CLONE_INTENT_STORAGE_KEY, JSON.stringify({
          requestId: requestId,
          targetId: targetId
        }));
      } catch (error) { /* ignore */ }
    }
  };

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('submit', function (event) {
      var form = event.target;
      if (!form || !form.matches || !form.matches('form[data-clone-form]')) return;
      var field = form.querySelector('[data-clone-request-id]');
      if (!field) return;
      var intent = readCloneIntent();
      var targetMatch = /\/admin\/pages\/([^/]+)\/clone/.exec(form.action || '');
      var targetId = targetMatch ? decodeURIComponent(targetMatch[1]) : null;
      var isCompletedIntent = intent
        && intent.targetId === targetId
        && cloneCompletionCookieFor(intent.requestId);

      // An UNCONFIRMED intent for THIS target is the retry path: reuse its id
      // even when the field rendered empty (e.g. after a failed navigation).
      var isRetryableIntent = intent
        && !isCompletedIntent
        && intent.targetId === targetId
        && REQUEST_ID_PATTERN.test(intent.requestId);

      if (isRetryableIntent) {
        field.value = intent.requestId;
      } else if (!REQUEST_ID_PATTERN.test(field.value) || isCompletedIntent) {
        field.value = generateRequestId();
      }
      if (isCompletedIntent) {
        try {
          window.sessionStorage.removeItem(CLONE_INTENT_STORAGE_KEY);
        } catch (error) { /* ignore */ }
      }
      // Persist BEFORE navigation: if the response is lost, the retry (same
      // form resubmitted, or after BFCache return) reuses this id.
      window.QuickShareCloneIntents.persist(field.value, targetId);
    }, true);

    // Returning through history/BFCache must NOT blindly wipe the intent:
    // reconcile decides — unconfirmed intents keep their id (retry), only
    // completed ones clear the field so the next click is a new clone.
    window.addEventListener('pageshow', function () {
      reconcileCloneIntents();
    });

    reconcileCloneIntents();
  }

  function formatManagementTime(epochMs) {
    try {
      return new Date(Number(epochMs)).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
      });
    } catch (error) {
      return String(epochMs);
    }
  }

  function statusLabel(status) {
    return status === 'succeeded' ? '已提交' : '结果已删除';
  }

  function renderResults(container, requestId, operations) {
    container.hidden = false;
    container.textContent = '';

    if (!operations.length) {
      var empty = document.createElement('p');
      empty.className = 'operations-empty';
      empty.textContent = '未找到该请求标识对应的已提交操作。';
      container.appendChild(empty);
      return;
    }

    var table = document.createElement('table');
    table.className = 'admin-table operations-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
      '<th scope="col">命名空间</th><th scope="col">动作</th><th scope="col">状态</th>' +
      '<th scope="col">结果 Share</th><th scope="col">内容版本</th><th scope="col">访问版本</th>' +
      '<th scope="col">时间</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    operations.forEach(function (operation) {
      var tr = document.createElement('tr');

      var cells = [
        NAMESPACE_LABELS[operation.namespaceKind] || operation.namespaceKind,
        operation.action === 'clone' ? '克隆' : '创建',
        statusLabel(operation.status)
      ];
      cells.forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      var shareCell = document.createElement('td');
      if (operation.shareId) {
        var link = document.createElement('a');
        link.href = '/admin/pages/' + encodeURIComponent(operation.shareId);
        link.textContent = operation.shareId;
        shareCell.appendChild(link);
      } else {
        shareCell.textContent = '—';
      }
      tr.appendChild(shareCell);

      [operation.revision || '—', operation.accessRevision || '—', formatManagementTime(operation.createdAt)]
        .forEach(function (text) {
          var td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    var summary = document.createElement('p');
    summary.className = 'admin-muted';
    summary.textContent = '请求标识 ' + requestId + '：' + operations.length + ' 条记录（仅元信息，无正文与密码）。';
    container.appendChild(summary);
  }

  function initOperationsSearch() {
    var form = document.getElementById('operations-search-form');
    var container = document.getElementById('operations-search-result');
    var input = document.getElementById('operations-request-id');
    if (!form || !container || !input) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var requestId = input.value.trim();

      if (!REQUEST_ID_PATTERN.test(requestId)) {
        container.hidden = false;
        container.textContent = '请求标识必须为 16–128 位字母、数字、短横线或下划线。';
        return;
      }

      fetch('/admin/operations?requestId=' + encodeURIComponent(requestId), {
        headers: { 'Accept': 'application/json' }
      }).then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      }).then(function (result) {
        if (!result.ok) {
          container.hidden = false;
          container.textContent = result.body && result.body.error ? result.body.error : '查询失败，请稍后重试。';
          return;
        }
        renderResults(container, requestId, result.body.operations || []);
      }).catch(function () {
        container.hidden = false;
        container.textContent = '查询失败，请稍后重试。';
      });
    });
  }

  initOperationsSearch();
})();
