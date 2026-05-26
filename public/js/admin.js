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
        window.location.reload();
      } else {
        alert(data.error || 'Failed to delete page');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete';
      }
    } catch (err) {
      alert('Network error: ' + err.message);
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
