(function initFavoriteControls() {
  var controls = document.querySelectorAll('[data-favorite-toggle]');

  if (!controls.length) return;

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function renderState(control, isFavorite) {
    var title = control.dataset.pageTitle || control.dataset.pageId;
    var icon = control.querySelector('.admin-favorite-icon');
    var label = control.querySelector('.admin-favorite-label');

    control.dataset.isFavorite = String(isFavorite);
    control.setAttribute('aria-pressed', String(isFavorite));
    control.setAttribute('aria-label', isFavorite ? '取消收藏 ' + title : '收藏分享 ' + title);
    icon.classList.toggle('fas', isFavorite);
    icon.classList.toggle('far', !isFavorite);
    label.textContent = isFavorite ? '取消收藏' : '收藏';
  }

  async function toggleFavorite(control) {
    if (control.getAttribute('aria-busy') === 'true') return;

    var targetState = control.dataset.isFavorite !== 'true';
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');

    try {
      var response = await fetch('/admin/pages/' + encodeURIComponent(control.dataset.pageId) + '/favorite', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ isFavorite: targetState })
      });
      var data = await response.json();

      if (!response.ok || !data.success || typeof data.isFavorite !== 'boolean') {
        throw new Error(data.error || '更新收藏状态失败');
      }

      renderState(control, data.isFavorite);
      Toast.success(data.isFavorite ? '已收藏' : '已取消收藏');
      if (!data.isFavorite && control.dataset.refreshUrl) {
        window.location.assign(control.dataset.refreshUrl);
      }
    } catch (error) {
      Toast.error(error.message || '更新收藏状态失败');
    } finally {
      control.disabled = false;
      control.setAttribute('aria-busy', 'false');
    }
  }

  controls.forEach(function (control) {
    control.addEventListener('click', function () {
      toggleFavorite(control);
    });
  });
})();
