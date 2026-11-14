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

// --- Clone intents (T08) ---------------------------------------------------
// Every clone form carries a persisted per-target request identifier in
// a hidden requestId field. The intent is stored before submitting, so
// if a clone's outcome is unknown (network failure, closed tab), 
// resubmitting the same form replays the original clone instead of
// minting another copy. The server confirms completion via the
// clone_intent_done cookie — set on fresh AND replay responses alike —
// and a matching cookie retires the stored intent, including after
// back-navigation restores the page from cache (pageshow), which is the
// path where a completed intent would otherwise be resubmitted.
(function initCloneIntents() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;

  function startCloneIntents() {
  var forms = Array.prototype.slice.call(document.querySelectorAll('form[action*="/clone"]'));
  if (!forms.length) return;

  function storageKey(targetId) { return 'qs.cloneIntent.' + targetId; }

  function readIntent(targetId) {
    try { return window.localStorage.getItem(storageKey(targetId)) || null; } catch (error) { return null; }
  }

  function writeIntent(targetId, requestId) {
    try { window.localStorage.setItem(storageKey(targetId), requestId); } catch (error) { /* storage unavailable */ }
  }

  function clearIntent(targetId) {
    try { window.localStorage.removeItem(storageKey(targetId)); } catch (error) { /* storage unavailable */ }
  }

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'clone-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function targetIdOf(form) {
    var match = /\/admin\/pages\/([^/]+)\/clone/.exec(form.getAttribute('action') || '');
    return match ? decodeURIComponent(match[1]) : null;
  }

  function retireConfirmedIntents() {
    var marker = document.cookie.split(';').map(function (part) { return part.trim(); })
      .find(function (part) { return part.indexOf('clone_intent_done=') === 0 });
    if (!marker) return;

    var doneId = decodeURIComponent(marker.slice('clone_intent_done='.length));
    forms.forEach(function (form) {
      var targetId = targetIdOf(form);
      if (targetId && readIntent(targetId) === doneId) {
        clearIntent(targetId);
      }
    });
    // The completion is consumed; expire the marker so it cannot retire
    // an unrelated future intent that happens to reuse the value.
    document.cookie = 'clone_intent_done=; Max-Age=0; path=/';
  }

  function refreshIntentFields() {
    forms.forEach(function (form) {
      var targetId = targetIdOf(form);
      if (!targetId) return;

      var intent = readIntent(targetId);
      if (!intent) {
        intent = newRequestId();
        writeIntent(targetId, intent);
      }

      var field = form.querySelector('input[name="requestId"]');
      if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'requestId';
        form.appendChild(field);
      }
      field.value = intent;
    });
  }

  retireConfirmedIntents();
  refreshIntentFields();
  window.addEventListener('pageshow', function () {
    retireConfirmedIntents();
    refreshIntentFields();
  });
  }

  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', startCloneIntents);
  } else {
    startCloneIntents();
  }
})();

// --- Publish-state toggles (T11) -------------------------------------------
// Each list row's unpublish/republish button submits the target state
// with the row's access-revision precondition and a per-intent request
// identifier. The intent ({ requestId, intentKey }) is kept in
// sessionStorage keyed by Share, where the intent key binds the target
// state and the access-revision baseline: if a response is lost, the
// next click replays the same identifier and the server returns the
// recorded result instead of re-judging a now-stale precondition. A
// changed baseline (the server reports a newer revision, or the row was
// re-rendered) mints a fresh intent. A confirmed result retires it.
(function initPublishToggles() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;

  function startPublishToggles() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-publish-toggle]'));
    if (!buttons.length) return;

    function storageKey(pageId) { return 'quickshare-admin-publish-intent:' + pageId; }

    function readIntent(pageId) {
      try {
        var raw = window.sessionStorage.getItem(storageKey(pageId));
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    }

    function writeIntent(pageId, intent) {
      try { window.sessionStorage.setItem(storageKey(pageId), JSON.stringify(intent)); } catch (error) { /* storage unavailable */ }
    }

    function clearIntent(pageId) {
      try { window.sessionStorage.removeItem(storageKey(pageId)); } catch (error) { /* storage unavailable */ }
    }

    function newRequestId() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      return 'publish-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    async function readJson(response) {
      try { return await response.json(); } catch (error) { return {}; }
    }

    buttons.forEach(function (button) {
      button.addEventListener('click', async function () {
        var pageId = button.dataset.pageId;
        var targetPublished = button.dataset.published !== 'true';
        var accessRevision = button.dataset.accessRevision || '';
        var intentKey = 'publish:' + (targetPublished ? 'true' : 'false') + ':access:' + accessRevision;
        var intent = readIntent(pageId);

        if (!intent || intent.intentKey !== intentKey || !intent.requestId) {
          intent = { requestId: newRequestId(), intentKey: intentKey };
          writeIntent(pageId, intent);
        }

        button.disabled = true;

        try {
          var response = await fetch('/admin/pages/' + encodeURIComponent(pageId) + '/publish-state', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-CSRF-Token': dashboardCsrfToken()
            },
            body: JSON.stringify({
              published: targetPublished,
              expectedAccessRevision: accessRevision,
              requestId: intent.requestId
            })
          });
          var data = await readJson(response);

          if (response.status === 412) {
            clearIntent(pageId);
            Toast.error('访问策略已被更新，正在刷新最新状态');
            setTimeout(function () { window.location.reload(); }, 800);
            return;
          }

          if (!response.ok || !data.success) {
            throw new Error(data.error || '更新发布状态失败');
          }

          clearIntent(pageId);

          if (data.unchanged) {
            Toast.success('已是该状态，未做变更');
          } else if (data.published) {
            Toast.success('已重新发布，公开链接恢复访问');
          } else {
            Toast.success('已下架，公开链接将返回 404');
          }

          setTimeout(function () { window.location.reload(); }, 800);
        } catch (error) {
          Toast.error(error.message || '更新发布状态失败');
          button.disabled = false;
        }
      });
    });
  }

  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', startPublishToggles);
  } else {
    startPublishToggles();
  }
})();
