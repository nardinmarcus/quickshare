// 分享列表的界面偏好与弹出菜单：行高记在本机，菜单一次只开一个。
(function () {
  if (typeof document === 'undefined') return;

  var DENSITY_KEY = 'quickshare:admin-list-density';
  var list = document.getElementById('share-list');
  var densityButtons = Array.prototype.slice.call(document.querySelectorAll('[data-density-option]'));

  function readDensity() {
    try {
      return window.localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
    } catch (error) {
      return 'comfortable';
    }
  }

  function applyDensity(density) {
    if (list) list.dataset.density = density;
    densityButtons.forEach(function (button) {
      button.setAttribute('aria-pressed', button.dataset.densityOption === density ? 'true' : 'false');
    });
  }

  densityButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var density = button.dataset.densityOption;
      try { window.localStorage.setItem(DENSITY_KEY, density); } catch (error) { /* storage unavailable */ }
      applyDensity(density);
    });
  });

  applyDensity(readDensity());

  var menus = Array.prototype.slice.call(document.querySelectorAll('details[data-menu]'));

  function closeMenus(except) {
    menus.forEach(function (menu) {
      if (menu !== except) menu.open = false;
    });
  }

  menus.forEach(function (menu) {
    menu.addEventListener('toggle', function () {
      if (menu.open) closeMenus(menu);
    });
  });

  document.addEventListener('click', function (event) {
    var inside = event.target.closest && event.target.closest('details[data-menu]');
    closeMenus(inside || null);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    menus.forEach(function (menu) {
      if (!menu.open) return;
      menu.open = false;
      var summary = menu.querySelector('summary');
      if (summary) summary.focus();
    });
  });
})();
