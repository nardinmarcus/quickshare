(function () {
  document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('passwordForm');
    const passwordInput = document.getElementById('page-password');
    const submitButton = document.getElementById('password-submit');
    const errorMessage = document.getElementById('password-error');
    let isSubmitting = false;

    if (!form || !passwordInput || !submitButton || !errorMessage) {
      return;
    }

    passwordInput.addEventListener('input', function () {
      passwordInput.setAttribute('aria-invalid', 'false');
      errorMessage.textContent = '';
    });

    form.addEventListener('submit', async function (event) {
      event.preventDefault();

      if (isSubmitting) {
        return;
      }

      if (!passwordInput.value) {
        errorMessage.textContent = '请输入密码';
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.focus();
        return;
      }

      isSubmitting = true;
      form.setAttribute('aria-busy', 'true');
      submitButton.disabled = true;
      submitButton.textContent = '验证中...';
      errorMessage.textContent = '';

      try {
        const response = await fetch('/view/' + encodeURIComponent(form.dataset.pageId) + '/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password: passwordInput.value })
        });
        const data = await response.json();

        if (response.ok && data.valid) {
          window.location.href = data.redirectUrl || ('/view/' + encodeURIComponent(form.dataset.pageId));
          return;
        }

        errorMessage.textContent = data.error || '密码错误，请重试';
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.focus();
        passwordInput.select();
      } catch (error) {
        errorMessage.textContent = '网络异常，请稍后重试';
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.focus();
      } finally {
        isSubmitting = false;
        form.setAttribute('aria-busy', 'false');
        submitButton.disabled = false;
        submitButton.textContent = '解锁并查看';
      }
    });
  });
})();
