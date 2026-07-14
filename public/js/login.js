(function () {
  document.addEventListener('DOMContentLoaded', function () {
    const passwordInput = document.getElementById('password-input');
    const toggleButton = document.getElementById('toggle-password');

    if (!passwordInput || !toggleButton) {
      return;
    }

    toggleButton.addEventListener('click', function () {
      const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      passwordInput.setAttribute('type', type);
      toggleButton.querySelector('i').className =
        type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
      toggleButton.setAttribute('aria-label', type === 'password' ? '显示密码' : '隐藏密码');
    });
  });
})();
