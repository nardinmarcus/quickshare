(function () {
  const baselineHref = '/css/markdown-theme-baseline.css';
  const fallbackSignatureHref = '/css/markdown-bytedance.css';
  const trustedSignaturePattern = /^\/css\/markdown-[a-z]+\.css$/;
  const stylesheetCache = new Map();
  const renderVersions = new WeakMap();
  const compactStyles = `
    :root { --theme-reading-padding: 14px; }
    html, body { min-height: 0; }
    body { overflow-x: hidden; }
    .markdown-body.theme-sampler-body {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 8px;
      width: 100%;
      max-width: none;
      padding: 10px;
      overflow: hidden;
      font-size: 11px;
      line-height: 1.3;
    }
    .theme-sampler-intro,
    .theme-sampler-body table {
      grid-column: 1 / -1;
    }
    .theme-sampler-intro {
      display: grid;
      gap: 4px;
    }
    .markdown-body.theme-sampler-body :where(h1, p, blockquote, pre, table) {
      margin: 0;
    }
    .theme-sampler-body h1 {
      max-width: 100%;
      padding: 4px 8px;
      font-size: 17px;
      line-height: 1.15;
      text-align: left;
    }
    .theme-sampler-body blockquote { padding: 5px 8px; }
    .theme-sampler-body pre {
      min-width: 0;
      padding: 6px;
      overflow: hidden;
      font-size: 10px;
      white-space: pre-wrap;
    }
    .theme-sampler-body table { width: 100%; }
    .theme-sampler-body :where(th, td) { padding: 3px 5px; }
  `;

  function trustedSignatureHref(option) {
    const candidate = option && option.dataset.signatureHref;
    return trustedSignaturePattern.test(candidate || '') ? candidate : fallbackSignatureHref;
  }

  function samplerDocument(content, signatureHref) {
    return `<!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="stylesheet" href="${baselineHref}">
          <link rel="stylesheet" href="${signatureHref}">
          <style>${compactStyles}</style>
        </head>
        <body>${content}</body>
      </html>`;
  }

  function loadStylesheet(href) {
    if (stylesheetCache.has(href)) return stylesheetCache.get(href);

    const request = fetch(href, { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error(`Stylesheet request failed: ${response.status}`);
        return response.text();
      })
      .catch(error => {
        stylesheetCache.delete(href);
        throw error;
      });
    stylesheetCache.set(href, request);
    return request;
  }

  function showUnavailable(frame, status) {
    if (frame) frame.hidden = true;
    if (status) {
      status.textContent = '样例暂不可用';
      status.hidden = false;
    }
  }

  async function update(root) {
    if (!root) return;

    const renderVersion = (renderVersions.get(root) || 0) + 1;
    renderVersions.set(root, renderVersion);

    const select = document.getElementById(root.dataset.selectId);
    const frame = root.querySelector('[data-theme-sampler-frame]');
    const template = root.querySelector('[data-theme-sampler-template]');
    const status = root.querySelector('[data-theme-sampler-status]');
    const option = select && select.selectedOptions[0];

    if (!select || !frame || !template || !option) {
      showUnavailable(frame, status);
      return;
    }

    const label = option.dataset.themeLabel || option.textContent.trim();
    const accessibleName = `${label}主题样例`;
    root.setAttribute('aria-label', accessibleName);
    frame.title = accessibleName;

    try {
      const signatureHref = trustedSignatureHref(option);
      frame.srcdoc = samplerDocument(template.innerHTML.trim(), signatureHref);
      frame.hidden = false;
      if (status) status.hidden = true;

      await Promise.all([
        loadStylesheet(baselineHref),
        loadStylesheet(signatureHref)
      ]);
      if (renderVersions.get(root) !== renderVersion) return;
    } catch (error) {
      if (renderVersions.get(root) !== renderVersion) return;
      showUnavailable(frame, status);
    }
  }

  function bind(root) {
    const select = root && document.getElementById(root.dataset.selectId);
    if (!select) return;

    select.addEventListener('change', function () { update(root); });
    update(root);
  }

  function updateForSelect(select) {
    if (!select) return;
    const root = Array.from(document.querySelectorAll('[data-theme-sampler]'))
      .find(candidate => candidate.dataset.selectId === select.id);
    return update(root);
  }

  Array.from(document.querySelectorAll('[data-theme-sampler]')).forEach(bind);
  window.ThemeSampler = { updateForSelect };
})();
