(function () {
  const baselineHref = '/css/markdown-theme-baseline.css';
  const fallbackSignatureHref = '/css/markdown-bytedance.css';
  const trustedSignaturePattern = /^\/css\/markdown-[a-z]+\.css$/;
  const compactStyles = `
    :root { --theme-reading-padding: 14px; }
    html, body { min-height: 0; }
    body { overflow-x: hidden; }
    .markdown-body.theme-sampler-body {
      width: 100%;
      max-width: none;
      padding: 14px;
      font-size: 12px;
      line-height: 1.45;
    }
    .theme-sampler-body :where(h1, h2, p, ul, blockquote, pre, table, figure, hr) {
      margin-top: 0;
      margin-bottom: 8px;
    }
    .theme-sampler-body h1 {
      max-width: 100%;
      margin: 0 0 10px;
      padding: 8px 12px;
      font-size: 20px;
      line-height: 1.2;
      text-align: left;
    }
    .theme-sampler-body h2 {
      max-width: 100%;
      margin: 0 0 7px;
      padding: 5px 8px;
      font-size: 15px;
      line-height: 1.25;
    }
    .theme-sampler-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .theme-sampler-body :where(ul, ol) { padding-left: 20px; }
    .theme-sampler-body blockquote { padding: 7px 9px 7px 14px; }
    .theme-sampler-body pre { padding: 8px; font-size: 11px; }
    .theme-sampler-body table { width: 100%; }
    .theme-sampler-body :where(th, td) { padding: 5px 7px; }
    .theme-sampler-assets {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      align-items: start;
    }
    .theme-sampler-image { display: grid; gap: 3px; }
    .theme-sampler-image svg { width: 100%; height: 54px; }
    .theme-sampler-image figcaption { color: var(--theme-muted); font-size: 11px; }
    .theme-sampler-diagram {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      padding: 8px;
      overflow: hidden;
      color: var(--theme-diagram-text);
      background: var(--theme-diagram-surface);
      border: 1px solid var(--theme-border);
      border-radius: 8px;
    }
    .theme-sampler-diagram span {
      padding: 6px;
      text-align: center;
      background: var(--theme-diagram-node-surface);
      border: 1px solid var(--theme-diagram-node-border);
      border-radius: 6px;
    }
    .theme-sampler-diagram i { height: 2px; background: var(--theme-diagram-line); }
    @media (max-width: 420px) {
      .theme-sampler-diagram { grid-template-columns: minmax(0, 1fr); }
      .theme-sampler-diagram i { width: 2px; height: 14px; margin-inline: auto; }
    }
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

  function update(root) {
    if (!root) return;

    const select = document.getElementById(root.dataset.selectId);
    const frame = root.querySelector('[data-theme-sampler-frame]');
    const template = root.querySelector('[data-theme-sampler-template]');
    const option = select && select.selectedOptions[0];

    if (!select || !frame || !template || !option) return;

    const label = option.dataset.themeLabel || option.textContent.trim();
    const accessibleName = `${label}主题样例`;
    root.setAttribute('aria-label', accessibleName);
    frame.title = accessibleName;
    frame.srcdoc = samplerDocument(template.innerHTML.trim(), trustedSignatureHref(option));
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
    update(root);
  }

  Array.from(document.querySelectorAll('[data-theme-sampler]')).forEach(bind);
  window.ThemeSampler = { updateForSelect };
})();
