function dashboardCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

(function () {
  const modal = document.getElementById('delete-modal');
  const modalTarget = document.getElementById('delete-modal-target');
  const confirmBtn = document.getElementById('delete-modal-confirm');
  const cancelBtn = document.getElementById('delete-modal-cancel');
  let currentPageId = null;

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    currentPageId = null;
  }

  document.querySelectorAll('.admin-delete-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      currentPageId = btn.dataset.pageId;
      modalTarget.textContent = btn.dataset.pageTitle || currentPageId;
      openModal();
    });
  });

  cancelBtn.addEventListener('click', closeModal);

  modal.querySelector('.admin-modal-backdrop').addEventListener('click', closeModal);

  confirmBtn.addEventListener('click', async function () {
    if (!currentPageId) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting...';

    try {
      const response = await fetch('/admin/pages/' + encodeURIComponent(currentPageId), {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'X-CSRF-Token': dashboardCsrfToken()
        }
      });

      const data = await response.json();

      if (data.success) {
        Toast.success('Page deleted');
        setTimeout(function () { window.location.reload(); }, 800);
      } else {
        Toast.error(data.error || 'Failed to delete page');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete';
      }
    } catch (err) {
      Toast.error('Network error: ' + err.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete';
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) {
      closeModal();
    }
  });

  // Jump to page
  var jumpInput = document.getElementById('jump-page-input');
  var jumpBtn = document.getElementById('jump-page-btn');
  if (jumpInput && jumpBtn) {
    function doJump() {
      var p = parseInt(jumpInput.value, 10);
      if (!Number.isFinite(p) || p < 1) return;
      var maxPage = parseInt(jumpInput.max, 10) || 1;
      if (p > maxPage) p = maxPage;
      var params = new URLSearchParams(window.location.search);
      params.set('page', p);
      window.location.href = '/admin/pages?' + params.toString();
    }
    jumpBtn.addEventListener('click', doJump);
    jumpInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doJump();
    });
  }

  // Date range filter
  var dateFromInput = document.getElementById('filter-date-from');
  var dateToInput = document.getElementById('filter-date-to');
  var dateFilterBtn = document.getElementById('date-filter-btn');
  if (dateFilterBtn && dateFromInput && dateToInput) {
    dateFilterBtn.addEventListener('click', function () {
      var params = new URLSearchParams(window.location.search);
      if (dateFromInput.value) {
        params.set('dateFrom', dateFromInput.value);
      } else {
        params.delete('dateFrom');
      }
      if (dateToInput.value) {
        params.set('dateTo', dateToInput.value);
      } else {
        params.delete('dateTo');
      }
      params.delete('page');
      window.location.href = '/admin/pages?' + params.toString();
    });
  }
})();

// ===== Toast 通知系统 =====
window.Toast = {
  container: null,

  init: function () {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(this.container);
  },

  show: function (message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    this.init();

    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;

    var icons = { success: 'fa-check', error: 'fa-times', info: 'fa-info' };

    var contentSpan = document.createElement('span');
    contentSpan.className = 'toast-content';
    contentSpan.textContent = message;

    toast.innerHTML =
      '<span class="toast-icon"><i class="fas ' + icons[type] + '" aria-hidden="true"></i></span>';
    toast.appendChild(contentSpan);
    toast.innerHTML +=
      '<button class="toast-close" aria-label="Close notification"><i class="fas fa-times" aria-hidden="true"></i></button>' +
      '<div class="toast-progress" style="width:100%"></div>';

    this.container.appendChild(toast);

    requestAnimationFrame(function () { toast.classList.add('show'); });

    var progress = toast.querySelector('.toast-progress');
    var startTime = Date.now();
    var timer = setInterval(function () {
      var elapsed = Date.now() - startTime;
      var remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      progress.style.width = remaining + '%';
      if (remaining <= 0) clearInterval(timer);
    }, 50);

    var self = this;
    var autoClose = setTimeout(function () { self.dismiss(toast, timer); }, duration);

    toast.querySelector('.toast-close').addEventListener('click', function () {
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

// ===== Batch Operations =====
(function () {
  var selectAll = document.getElementById('select-all');
  var toolbar = document.getElementById('batch-toolbar');
  var countSpan = document.getElementById('batch-count');
  var deleteBtn = document.getElementById('batch-delete-btn');
  var cancelBtn = document.getElementById('batch-cancel-btn');
  var checkboxes = document.querySelectorAll('.row-checkbox');

  if (!selectAll || !toolbar || checkboxes.length === 0) return;

  function selectedIds() {
    var ids = [];
    checkboxes.forEach(function (cb) { if (cb.checked) ids.push(cb.dataset.id); });
    return ids;
  }

  function updateToolbar() {
    var ids = selectedIds();
    countSpan.textContent = ids.length + ' selected';
    deleteBtn.disabled = ids.length === 0;
    toolbar.hidden = ids.length === 0;
  }

  selectAll.addEventListener('change', function () {
    checkboxes.forEach(function (cb) { cb.checked = selectAll.checked; });
    updateToolbar();
  });

  checkboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      selectAll.checked = Array.from(checkboxes).every(function (c) { return c.checked; });
      updateToolbar();
    });
  });

  cancelBtn.addEventListener('click', function () {
    selectAll.checked = false;
    checkboxes.forEach(function (cb) { cb.checked = false; });
    updateToolbar();
  });

  deleteBtn.addEventListener('click', async function () {
    var ids = selectedIds();
    if (ids.length === 0) return;

    var targetText = ids.length + ' pages';
    var modalTarget = document.getElementById('delete-modal-target');
    var origText = modalTarget.textContent;
    modalTarget.textContent = targetText;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    var confirmBtn = document.getElementById('delete-modal-confirm');
    var origConfirm = confirmBtn.textContent;

    function cleanup() {
      modal.hidden = true;
      document.body.style.overflow = '';
      modalTarget.textContent = origText;
      confirmBtn.disabled = false;
      confirmBtn.textContent = origConfirm;
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    }

    confirmBtn.addEventListener('click', async function handler() {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting...';

      try {
        var response = await fetch('/admin/pages/batch', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-Token': dashboardCsrfToken()
          },
          body: JSON.stringify({ ids: ids })
        });
        var data = await response.json();
        if (data.success) {
          Toast.success(data.deleted + ' pages deleted');
          setTimeout(function () { window.location.reload(); }, 800);
        } else {
          Toast.error(data.error || 'Failed to delete pages');
          cleanup();
        }
      } catch (err) {
        Toast.error('Network error: ' + err.message);
        cleanup();
      }
    });

    document.getElementById('delete-modal-cancel').addEventListener('click', cleanup);
  });
})();
