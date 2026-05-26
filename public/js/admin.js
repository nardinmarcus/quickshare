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
        headers: { 'Accept': 'application/json' }
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
