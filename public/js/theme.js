(function() {
  const root = document.documentElement;

  // 界面只有一套视觉，明暗跟随系统 prefers-color-scheme
  function applyScheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }

  applyScheme();

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
    root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    document.dispatchEvent(new CustomEvent('themeChange', {
      detail: { theme: e.matches ? 'dark' : 'light' }
    }));
  });
})();
