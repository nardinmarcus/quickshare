(function () {
  const editBtn = document.getElementById('edit-toggle-btn');
  const revokeBtn = document.getElementById('revoke-access-btn');
  const accessStatus = document.getElementById('access-action-status');
  const editForm = document.getElementById('edit-form');
  const contentTextarea = document.getElementById('content-textarea');
  const cancelBtn = document.getElementById('edit-cancel');
  const saveContentBtn = document.getElementById('edit-save-content');
  const saveAccessBtn = document.getElementById('edit-save-access');
  const clearExpiresBtn = document.getElementById('clear-expires');
  const protectedCheckbox = document.getElementById('edit-protected');
  const protectionHint = document.getElementById('protection-hint');
  const passwordInputWrap = document.getElementById('password-input-wrap');
  const passwordInput = document.getElementById('edit-password');
  const passwordHint = document.getElementById('edit-password-hint');
  const togglePasswordBtn = document.getElementById('toggle-password-visibility');
  const expiresInput = document.getElementById('edit-expires');
  const expiresHint = document.getElementById('edit-expires-hint');
  const titleDisplay = document.getElementById('page-title-display');
  const descriptionDisplayRow = document.getElementById('description-display-row');
  const descriptionDisplay = document.getElementById('description-display');
  const passwordDisplayRow = document.getElementById('password-display-row');
  const expiresDisplayRow = document.getElementById('expires-display-row');
  const statusDisplay = document.getElementById('status-display');
  const pageDataElement = document.getElementById('page-data');
  const renderedPreview = document.getElementById('rendered-preview');
  const themeSelect = document.getElementById('edit-theme');
  const contentRevisionDisplay = document.getElementById('content-revision-display');
  const conflictPanel = document.getElementById('conflict-panel');
  const conflictSummary = document.getElementById('conflict-summary');
  const conflictMeta = document.getElementById('conflict-meta');
  const conflictDiff = document.getElementById('conflict-diff');
  const conflictDiffStatus = document.getElementById('conflict-diff-status');
  const conflictRawPanel = document.getElementById('conflict-raw-panel');
  const conflictRawRemote = document.getElementById('conflict-raw-remote');
  const conflictRawRemoteTitle = document.getElementById('conflict-raw-remote-title');
  const conflictRawLocal = document.getElementById('conflict-raw-local');
  const conflictRawLocalTitle = document.getElementById('conflict-raw-local-title');
  const conflictTakeRemoteBtn = document.getElementById('conflict-take-remote');
  const conflictSaveMineBtn = document.getElementById('conflict-save-mine');
  const adminTime = window.AdminTime;
  const SourceDiff = window.SourceDiff;
  const customPasswordPattern = /^[A-Za-z0-9!@#$%^&*()_+\-=.,?~]{4,12}$/;
  const customPasswordError = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';
  let originalData = {};
  // The textarea value captured when the current form baseline was set. A
  // <textarea> normalizes CRLF/CR to LF in its .value, so an untouched or
  // reverted body must never be re-sent: only an ACTUAL edit transmits
  // htmlContent, keeping the server-side raw bytes byte-identical.
  let baselineTextareaValue = null;
  // The remote state behind the currently displayed conflict, if any.
  let conflictRemote = null;
  let saveKind = 'content';

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function contentIfMatch(data) {
    // Strong HTTP entity-tag: always the double-quoted form.
    return '"content:' + data.id + ':' + data.currentRevision + '"';
  }

  function candidateBody() {
    // The EXACT body bytes a content save would submit. A textarea
    // normalizes CRLF/CR to LF in .value, so an untouched (or reverted) body
    // resolves to the ORIGINAL raw bytes from the page baseline; an actual
    // edit resolves to the browser-normalized edited value. Sending, the
    // conflict comparison and the local raw view ALL resolve through this
    // single helper: what the owner reviews is exactly what will be sent —
    // never a phantom end-of-line rewrite of the real candidate.
    return contentTextarea.value === baselineTextareaValue
      ? originalData.htmlContent
      : contentTextarea.value;
  }

  try {
    originalData = JSON.parse(pageDataElement.textContent || '{}');
  } catch (error) {
    console.error('无法读取分享数据：', error);
  }

  function updateProtectionHint(isProtected) {
    protectionHint.textContent = isProtected
      ? '取消勾选将移除密码保护。'
      : '勾选后将启用密码保护。';
  }

  function updatePasswordInputVisibility() {
    passwordInputWrap.hidden = !protectedCheckbox.checked;
  }

  function resetPasswordVisibility() {
    passwordInput.type = 'password';
    togglePasswordBtn.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    togglePasswordBtn.setAttribute('aria-label', '显示密码');
  }

  function resetRenderedPreview() {
    renderedPreview.removeAttribute('src');
    delete renderedPreview.dataset.loaded;
  }

  function loadRenderedPreview() {
    if (renderedPreview.dataset.loaded) return;

    renderedPreview.src = '/view/' + encodeURIComponent(originalData.id) + '?adminPreview=' + Date.now();
    renderedPreview.dataset.loaded = 'true';
  }

  function hideConflictPanel() {
    conflictRemote = null;
    // Invalidate any queued chunked render before clearing: a comparison
    // whose chunks are still pending must never refill the hidden panel.
    if (SourceDiff && SourceDiff.cancelRender) SourceDiff.cancelRender(conflictDiff);
    conflictPanel.hidden = true;
    conflictDiff.textContent = '';
    conflictMeta.textContent = '';
    conflictDiffStatus.textContent = '';
    conflictRawPanel.hidden = true;
    conflictRawRemote.value = '';
    conflictRawLocal.value = '';
    conflictRawRemoteTitle.textContent = '';
    conflictRawLocalTitle.textContent = '';
  }

  function captureContentBaseline() {
    baselineTextareaValue = contentTextarea.value;
  }

  function resetForm() {
    document.getElementById('edit-title').value = originalData.title || '';
    document.getElementById('edit-description').value = originalData.description || '';
    expiresInput.value = originalData.expiresAt
      ? adminTime.toDateTimeLocal(originalData.expiresAt)
      : '';
    protectedCheckbox.checked = Boolean(originalData.isProtected);
    passwordInput.value = '';
    passwordInput.setAttribute('aria-invalid', 'false');
    passwordHint.textContent = '';
    passwordHint.className = 'field-hint';
    expiresHint.textContent = '';
    expiresHint.className = 'field-hint';
    resetPasswordVisibility();
    contentTextarea.value = originalData.htmlContent || '';
    if (themeSelect) {
      themeSelect.value = originalData.markdownTheme || 'bytedance';
      if (window.ThemeSampler) window.ThemeSampler.updateForSelect(themeSelect);
    }
    updateProtectionHint(Boolean(originalData.isProtected));
    updatePasswordInputVisibility();
    captureContentBaseline();
  }

  function enterEditMode() {
    if (revokeBtn) revokeBtn.disabled = true;
    editBtn.hidden = true;
    editForm.hidden = false;
    contentTextarea.removeAttribute('readonly');
    contentTextarea.classList.add('admin-content-editable');
    updatePasswordInputVisibility();
    document.getElementById('edit-title').focus();
  }

  function exitEditMode() {
    if (revokeBtn) revokeBtn.disabled = false;
    editBtn.hidden = false;
    editForm.hidden = true;
    contentTextarea.setAttribute('readonly', '');
    contentTextarea.classList.remove('admin-content-editable');
    hideConflictPanel();
    resetForm();
    editBtn.focus();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateViewMode(data) {
    const revisionDisplay = document.getElementById('access-revision-display');
    if (revisionDisplay) revisionDisplay.textContent = data.accessRevision;
    if (contentRevisionDisplay) contentRevisionDisplay.textContent = data.currentRevision;
    titleDisplay.textContent = data.title || data.id;

    if (data.description) {
      descriptionDisplayRow.hidden = false;
      descriptionDisplay.textContent = data.description;
    } else {
      descriptionDisplayRow.hidden = true;
      descriptionDisplay.textContent = '';
    }

    if (data.isProtected) {
      statusDisplay.innerHTML = '<span class="admin-status protected">密码保护</span>';
      passwordDisplayRow.hidden = false;
      document.getElementById('password-display').innerHTML = data.password
        ? '<code class="admin-password-value">' + escapeHtml(data.password) + '</code>'
        : '<span class="admin-muted">旧版分享无法查看密码</span>';
    } else {
      statusDisplay.innerHTML = '<span class="admin-status public">公开</span>';
      passwordDisplayRow.hidden = true;
    }

    if (data.expiresAt) {
      const date = new Date(Number(data.expiresAt));
      expiresDisplayRow.hidden = false;
      document.getElementById('expires-display').innerHTML =
        '<time datetime="' + date.toISOString() + '">' +
        adminTime.format(data.expiresAt) + '</time>';
    } else {
      expiresDisplayRow.hidden = true;
      document.getElementById('expires-display').innerHTML =
        '<span class="admin-muted">永不过期</span>';
    }
  }

  function applySavedPage(page) {
    originalData = {
      ...originalData,
      ...page,
      markdownTheme: page.markdownTheme || ''
    };
    updateViewMode(originalData);
    resetRenderedPreview();
  }

  if (revokeBtn) revokeBtn.addEventListener('click', async function () {
    if (revokeBtn.disabled) return;
    revokeBtn.disabled = true;
    editBtn.disabled = true;
    revokeBtn.setAttribute('aria-busy', 'true');
    accessStatus.textContent = '正在撤销…';
    try {
      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ revokeAccess: true, expectedAccessRevision: originalData.accessRevision })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '撤销失败，请稍后重试');
      applySavedPage(data.page);
      resetForm();
      accessStatus.textContent = '已撤销此前的解锁访问；接收者需重新输入密码。公开 Share 仍可直接访问。';
    } catch (error) {
      accessStatus.textContent = error.message || '撤销失败，请稍后重试';
      Toast.error(accessStatus.textContent);
    } finally {
      revokeBtn.disabled = false;
      editBtn.disabled = false;
      revokeBtn.setAttribute('aria-busy', 'false');
    }
  });

  editBtn.addEventListener('click', enterEditMode);
  cancelBtn.addEventListener('click', exitEditMode);

  // Capture the initial (browser-normalized) body baseline for the rendered form.
  captureContentBaseline();

  function setSaving(saving) {
    saveContentBtn.disabled = saving;
    saveAccessBtn.disabled = saving;
    editForm.setAttribute('aria-busy', String(saving));
    saveContentBtn.textContent = saving && saveKind === 'content' ? '保存中…' : '保存内容';
    saveAccessBtn.textContent = saving && saveKind === 'access' ? '保存中…' : '保存访问设置';
  }

  function validateCommonInputs() {
    if (expiresInput.value) {
      const expiresAt = adminTime.parseDateTimeLocal(expiresInput.value);
      if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
        expiresHint.textContent = '过期时间不能早于当前时间';
        expiresHint.className = 'field-hint error';
        Toast.error('请设置有效的过期时间');
        expiresInput.focus();
        return false;
      }
    }
    return true;
  }

  function collectExpiresAt() {
    const expiresAtValue = expiresInput.value;
    const displayedExpiry = originalData.expiresAt ? adminTime.toDateTimeLocal(originalData.expiresAt) : '';
    // datetime-local displays minutes; an untouched control must not round the policy instant.
    return expiresAtValue === displayedExpiry
      ? originalData.expiresAt
      : expiresAtValue ? adminTime.parseDateTimeLocal(expiresAtValue) : null;
  }

  function readCustomPassword() {
    const customPassword = passwordInput.value;
    if (protectedCheckbox.checked && customPassword && !customPasswordPattern.test(customPassword)) {
      passwordHint.textContent = customPasswordError;
      passwordHint.className = 'field-hint error';
      passwordInput.setAttribute('aria-invalid', 'true');
      Toast.error(customPasswordError);
      passwordInput.focus();
      return { error: true };
    }
    return { error: false, value: customPassword };
  }

  async function saveContent(forceBaseline) {
    const ifMatch = forceBaseline || contentIfMatch(originalData);
    setSaving(true);
    try {
      const payload = {
        title: document.getElementById('edit-title').value.trim() || null,
        description: document.getElementById('edit-description').value.trim() || null
      };
      if (themeSelect) payload.markdownTheme = themeSelect.value;
      // Candidate identity is preserved on EVERY content save path. A
      // textarea normalizes CRLF/CR to LF in .value, so an untouched (or
      // reverted) body transmits the ORIGINAL raw bytes from the page
      // baseline — never its LF-normalized form. An actual edit transmits
      // the edited value. "Save my version" therefore submits exactly the
      // candidate the owner reviewed (user metadata + the shown body), never
      // a silent merge that would keep a remote body under a new baseline.
      payload.htmlContent = candidateBody();

      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken(),
          'If-Match': ifMatch
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (response.status === 412 && data.code === 'CONTENT_REVISION_CONFLICT') {
        showConflict(data.current);
        return;
      }
      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存内容失败');
      }

      applySavedPage(data.page);
      hideConflictPanel();
      exitEditMode();
      Toast.success('内容已保存');
    } catch (error) {
      Toast.error(error.message || '保存内容失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveAccess() {
    if (!validateCommonInputs()) return;
    const password = readCustomPassword();
    if (password.error) return;

    setSaving(true);
    try {
      const payload = {
        isProtected: protectedCheckbox.checked,
        expiresAt: collectExpiresAt(),
        expectedAccessRevision: originalData.accessRevision
      };
      if (protectedCheckbox.checked && password.value) payload.password = password.value;

      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存访问设置失败');
      }

      applySavedPage(data.page);
      hideConflictPanel();
      exitEditMode();
      Toast.success('访问设置已保存');
    } catch (error) {
      Toast.error(error.message || '保存访问设置失败');
    } finally {
      setSaving(false);
    }
  }

  function metaFields(remote) {
    const fields = [
      { label: '标题', remoteValue: remote.title, localValue: document.getElementById('edit-title').value.trim() || null },
      { label: '描述', remoteValue: remote.description, localValue: document.getElementById('edit-description').value.trim() || null }
    ];
    if (themeSelect) {
      fields.push({ label: 'Markdown 主题', remoteValue: remote.markdownTheme, localValue: themeSelect.value });
    }
    return fields;
  }

  async function showConflict(remote) {
    if (!remote) {
      Toast.error('内容已在此页面之外被修改，请刷新后重试');
      return;
    }
    conflictRemote = remote;
    conflictPanel.hidden = false;
    // Invalidate any queued render from an earlier comparison before
    // clearing: stale chunks must never refill the new target's diff area.
    if (SourceDiff && SourceDiff.cancelRender) SourceDiff.cancelRender(conflictDiff);
    conflictSummary.textContent = '此 Share 当前已是第 ' + remote.currentRevision + ' 版，你的编辑基于第 '
      + originalData.currentRevision + ' 版。未保存的稿件已保留，请先查看差异，再选择采用远端或保留你的版本。';

    SourceDiff.renderMetaChanges(conflictMeta, metaFields(remote));
    conflictDiff.textContent = '';
    conflictDiffStatus.textContent = '正在比较当前远端与你的稿件…';

    // Both complete sources stay reachable while the conflict is open: the
    // frozen remote snapshot and the EXACT local candidate (raw bytes when
    // untouched, edited value otherwise) — the same resolution a save sends.
    const localCandidate = candidateBody();
    conflictRawRemote.value = remote.htmlContent;
    conflictRawRemoteTitle.textContent = '当前远端 · 第 ' + remote.currentRevision + ' 版快照（只读）';
    conflictRawLocal.value = localCandidate;
    conflictRawLocalTitle.textContent = '本地候选 · 基于第 ' + originalData.currentRevision + ' 版（只读）';
    conflictRawPanel.hidden = false;

    // Compare remote (old) with the retained candidate (new). Any result
    // that belongs to an earlier comparison target is discarded inside
    // SourceDiff.
    let result;
    try {
      result = await SourceDiff.compare(remote.htmlContent, localCandidate);
    } catch (error) {
      // Comparator failure (e.g. worker error): a terminal, clearly
      // unfinished state — distinct from an oversized diff, never a stuck
      // in-flight wording, and both raw sources stay reachable below.
      if (conflictRemote !== remote) return; // stale rejection: the panel moved on
      if (SourceDiff && SourceDiff.cancelRender) SourceDiff.cancelRender(conflictDiff);
      conflictDiff.textContent = '';
      conflictDiffStatus.textContent = '差异比较失败，未完成比较。下方已提供双方完整只读原稿。';
      return;
    }
    if (conflictRemote !== remote) return;

    if (result.status === 'ok') {
      SourceDiff.renderParts(conflictDiff, result.parts, {
        truncationNotice: '差异行数过多，仅显示前 ' + (SourceDiff.MAX_RENDERED_ROWS || 2000) + ' 行；完整原稿见下方两侧只读原稿。'
      });
      const changed = result.parts.some(part => part.added || part.removed);
      conflictDiffStatus.textContent = changed
        ? '以下为正文行级差异（当前远端 → 你的稿件）：'
        : '正文没有行级差异；请检查上方标题、描述或主题的取值变化。';
    } else {
      // Timeout/worker failure: never show this as "no differences"; both
      // complete raw sources remain visible below.
      if (SourceDiff && SourceDiff.cancelRender) SourceDiff.cancelRender(conflictDiff);
      conflictDiff.textContent = '';
      conflictDiffStatus.textContent = '差异过大，未完成比较。下方已提供双方完整只读原稿。';
    }
  }

  conflictTakeRemoteBtn.addEventListener('click', function () {
    if (!conflictRemote) return;
    originalData = {
      ...originalData,
      title: conflictRemote.title,
      description: conflictRemote.description,
      htmlContent: conflictRemote.htmlContent,
      markdownTheme: conflictRemote.markdownTheme || '',
      currentRevision: conflictRemote.currentRevision
    };
    hideConflictPanel();
    resetForm();
    updateViewMode(originalData);
    resetRenderedPreview();
    Toast.success('已采用当前远端内容，你的未保存修改已丢弃');
  });

  conflictSaveMineBtn.addEventListener('click', function () {
    if (!conflictRemote) return;
    // Explicit overwrite after the owner reviewed the difference: the fresh
    // baseline comes from the conflict payload, never fetched silently.
    saveContent('"content:' + originalData.id + ':' + conflictRemote.currentRevision + '"');
  });

  saveContentBtn.addEventListener('click', function () { saveKind = 'content'; });
  saveAccessBtn.addEventListener('click', function () { saveKind = 'access'; });

  editForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (saveContentBtn.disabled) return;
    if (saveKind === 'access') {
      await saveAccess();
      return;
    }
    // Content saves never submit access fields, so access-only validation
    // must not block a content save.
    await saveContent();
  });

  clearExpiresBtn.addEventListener('click', function () {
    expiresInput.value = '';
    expiresHint.textContent = '';
    expiresHint.className = 'field-hint';
    expiresInput.focus();
  });

  protectedCheckbox.addEventListener('change', function () {
    if (!protectedCheckbox.checked) {
      passwordInput.value = '';
      passwordInput.setAttribute('aria-invalid', 'false');
      passwordHint.textContent = '';
      passwordHint.className = 'field-hint';
      resetPasswordVisibility();
    }

    updateProtectionHint(protectedCheckbox.checked);
    updatePasswordInputVisibility();
  });

  passwordInput.addEventListener('input', function () {
    const password = passwordInput.value;

    if (!password) {
      passwordHint.textContent = '';
      passwordHint.className = 'field-hint';
      passwordInput.setAttribute('aria-invalid', 'false');
    } else if (!customPasswordPattern.test(password)) {
      passwordHint.textContent = customPasswordError;
      passwordHint.className = 'field-hint error';
      passwordInput.setAttribute('aria-invalid', 'true');
    } else {
      passwordHint.textContent = '密码格式有效';
      passwordHint.className = 'field-hint valid';
      passwordInput.setAttribute('aria-invalid', 'false');
    }
  });

  expiresInput.addEventListener('change', function () {
    const expiresAt = expiresInput.value
      ? adminTime.parseDateTimeLocal(expiresInput.value)
      : null;

    if (expiresInput.value && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
      expiresHint.textContent = '过期时间不能早于当前时间';
      expiresHint.className = 'field-hint error';
    } else {
      expiresHint.textContent = '';
      expiresHint.className = 'field-hint';
    }
  });

  togglePasswordBtn.addEventListener('click', function () {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    togglePasswordBtn.innerHTML = isHidden
      ? '<i class="fas fa-eye-slash" aria-hidden="true"></i>'
      : '<i class="fas fa-eye" aria-hidden="true"></i>';
    togglePasswordBtn.setAttribute('aria-label', isHidden ? '隐藏密码' : '显示密码');
  });

  const tabs = Array.from(document.querySelectorAll('.admin-tab'));

  function activateTab(tab, shouldFocus) {
    tabs.forEach(function (item) {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.setAttribute('tabindex', selected ? '0' : '-1');

      const panel = document.getElementById(item.getAttribute('aria-controls'));
      panel.classList.toggle('active', selected);
      panel.hidden = !selected;
    });

    if (shouldFocus) tab.focus();

    if (tab.dataset.tab === 'rendered') {
      loadRenderedPreview();
    }
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      activateTab(tab, false);
    });

    tab.addEventListener('keydown', function (event) {
      let nextIndex = index;

      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });
})();
