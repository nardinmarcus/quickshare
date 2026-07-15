(function () {
  const endpoint = document.currentScript?.dataset.viewEventUrl;
  let reported = false;

  if (!endpoint) {
    return;
  }

  function reportView() {
    if (reported) {
      return;
    }

    reported = true;

    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(endpoint)) {
      return;
    }

    fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportView, { once: true });
  } else {
    reportView();
  }
})();
