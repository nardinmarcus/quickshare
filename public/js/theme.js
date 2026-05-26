(function() {
  const root = document.documentElement;
  const currentTheme = root.getAttribute('data-theme') || 'default';

  // Custom themes (hacker, cyberpunk) are locked by server — do nothing
  if (currentTheme !== 'default') {
    return;
  }

  // Default theme: follow system prefers-color-scheme
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
