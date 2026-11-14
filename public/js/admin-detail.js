(function () {
  const editBtn = document.getElementById('edit-toggle-btn');
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
  const revisionDisplay = document.getElementById('content-revision-display');
  const pageDataElement = document.getElementById('page-data');
  const renderedPreview = document.getElementById('rendered-preview');
  const themeSelect = document.getElementById('edit-theme');
  const conflictSection = document.getElementById('content-conflict');
  const conflictMeta = document.getElementById('conflict-meta');
  const conflictMetaBody = document.getElementById('conflict-meta-body');
  const conflictDiffStatus = document.getElementById('conflict-diff-status');
  const conflictDiff = document.getElementById('conflict-diff');
  const conflictRemoteFull = document.getElementById('conflict-remote-full');
  const conflictCandidateFull = document.getElementById('conflict-candidate-full');
  const conflictLoadRemoteBtn = document.getElementById('conflict-load-remote');
  const conflictSaveMineBtn = document.getElementById('conflict-save-mine');
  const adminTime = window.AdminTime;
  const customPasswordPattern = /^[A-Za-z0-9!@#$%^&*()_+\-=.,?~]{4,12}$/;
  const customPasswordError = '自定义密码必须为 4–12 位，仅可包含英文字母、数字及 !@#$%^&*()_+-=.,?~';
  let originalData = {};
  // The preserved candidate and remote snapshot of an unresolved content
  // conflict (T06). The candidate is never overwritten by remote data;
  // only an explicit owner choice resolves the conflict.
  let conflictState = null;
  // Monotonic render token for the conflict comparison (T07): every
  // hide/reset/new comparison bumps it, which supersedes the pending
  // SourceDiff run and stops any chunked rendering still in flight.
  let diffRenderSeq = 0;

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
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

  function updateRevisionDisplay() {
    if (!revisionDisplay) return;

    revisionDisplay.textContent = '';

    if (originalData.currentRevision) {
      const label = document.createElement('span');
      label.textContent = 'Revision ' + originalData.currentRevision;
      const etag = document.createElement('code');
      etag.className = 'admin-etag-value';
      etag.textContent = originalData.contentEtag || '';
      revisionDisplay.append(label, etag);
    } else {
      const label = document.createElement('span');
      label.className = 'admin-muted';
      label.textContent = '尚未建立基线版本';
      revisionDisplay.append(label);
    }
  }

  function resetForm() {
    hideContentConflict();
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
  }

  function enterEditMode() {
    editBtn.hidden = true;
    editForm.hidden = false;
    contentTextarea.removeAttribute('readonly');
    contentTextarea.classList.add('admin-content-editable');
    updatePasswordInputVisibility();
    document.getElementById('edit-title').focus();
  }

  function exitEditMode() {
    editBtn.hidden = false;
    editForm.hidden = true;
    contentTextarea.setAttribute('readonly', '');
    contentTextarea.classList.remove('admin-content-editable');
    resetForm();
    editBtn.focus();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateViewMode(data) {
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

  function setSaving(busy) {
    editForm.setAttribute('aria-busy', String(busy));
    saveContentBtn.disabled = busy;
    saveAccessBtn.disabled = busy;
  }

  function mergeSavedPage(page) {
    originalData = {
      ...originalData,
      ...page,
      markdownTheme: page.markdownTheme || ''
    };
    updateRevisionDisplay();
  }

  // --- Save operation intent (T09) ------------------------------------
  //
  // The page keeps one pending save intent: { requestId, intentKey },
  // where the key fingerprints the candidate draft AND the baseline ETag
  // it is saved against. Resubmitting the same draft against the same
  // baseline — a repeated click that escaped the disabled buttons, or an
  // explicit retry after the response was lost — reuses the requestId,
  // so the server replays the committed result instead of minting a
  // second Revision. Editing the draft, or explicitly re-saving onto a
  // newer baseline after a conflict, is a new intent with a fresh id.
  // The intent survives a page reload through sessionStorage; an error
  // status never rotates it silently and never adopts a new baseline.
  const saveIntentStorageKey = 'quickshare-admin-save-intent:' + (originalData.id || '');
  let saveIntent = null;

  try {
    const stored = window.sessionStorage.getItem(saveIntentStorageKey);
    if (stored) {
      saveIntent = JSON.parse(stored);
    }
  } catch (error) {
    saveIntent = null;
  }

  function persistSaveIntent() {
    try {
      if (saveIntent) {
        window.sessionStorage.setItem(saveIntentStorageKey, JSON.stringify(saveIntent));
      } else {
        window.sessionStorage.removeItem(saveIntentStorageKey);
      }
    } catch (error) {
      // Storage unavailable: the in-memory intent still applies.
    }
  }

  function saveIntentKeyFor(candidate, etag) {
    const fingerprint = window.PublishIntent
      ? window.PublishIntent.draftKeyFor({
        htmlContent: candidate.htmlContent || '',
        codeType: originalData.codeType || '',
        title: candidate.title == null ? '' : String(candidate.title),
        description: candidate.description == null ? '' : String(candidate.description),
        markdownTheme: candidate.markdownTheme || ''
      })
      : 'draft-unavailable';
    return fingerprint + '|' + (etag || '');
  }

  function requestIdForSave(candidate, etag) {
    const intentKey = saveIntentKeyFor(candidate, etag);

    if (saveIntent && saveIntent.intentKey === intentKey && saveIntent.requestId) {
      return saveIntent.requestId;
    }

    saveIntent = {
      requestId: window.PublishIntent
        ? window.PublishIntent.generateRequestId()
        : 'save-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      intentKey
    };
    persistSaveIntent();
    return saveIntent.requestId;
  }

  function clearSaveIntent() {
    saveIntent = null;
    persistSaveIntent();
  }

  function finishSuccessfulSave(page, message) {
    mergeSavedPage(page);
    updateViewMode(page);
    resetRenderedPreview();
    if (document.getElementById('tab-rendered').getAttribute('aria-selected') === 'true') {
      loadRenderedPreview();
    }
    exitEditMode();
    Toast.success(message);
  }

  // --- Content candidate identity (CRLF preservation) -------------------
  //
  // A textarea reports its value with newlines normalized to LF, so an
  // untouched body whose stored bytes use CRLF would look "changed" if
  // the textarea value were submitted verbatim — minting a spurious
  // Revision for a no-op save and misrepresenting the candidate in a
  // conflict. When the textarea still holds the baseline modulo newline
  // representation, the candidate IS the stored raw bytes from the page
  // data; only a real edit submits the textarea value.
  function normalizeNewlines(text) {
    return String(text || '').replace(/\r\n|\r/g, '\n');
  }

  function candidateHtmlContent() {
    const baselineBody = originalData.htmlContent || '';
    const textareaValue = contentTextarea.value;

    if (normalizeNewlines(textareaValue) === normalizeNewlines(baselineBody)) {
      return baselineBody;
    }

    return textareaValue;
  }

  function readContentCandidate() {
    const candidate = {
      title: document.getElementById('edit-title').value.trim() || null,
      description: document.getElementById('edit-description').value.trim() || null,
      htmlContent: candidateHtmlContent()
    };
    if (themeSelect) candidate.markdownTheme = themeSelect.value;
    return candidate;
  }

  // --- Content conflict + Worker diff -----------------------------------

  function discardDiffRun() {
    diffRenderSeq += 1;

    if (window.SourceDiff) {
      window.SourceDiff.cancel();
    }
  }

  function hideContentConflict() {
    conflictState = null;
    discardDiffRun();

    if (conflictSection) {
      conflictSection.hidden = true;
    }
    if (conflictDiff) {
      conflictDiff.textContent = '';
    }
    if (conflictDiffStatus) {
      conflictDiffStatus.textContent = '';
    }
  }

  function showDiffTooLarge() {
    conflictDiff.textContent = '';
    conflictDiffStatus.textContent = '差异过大，未完成比较。可分别查看远端最新版与我的稿件的完整正文。';
  }

  function renderConflictDiff(parts) {
    // Shared chunked renderer (T07): chunk appends re-check the render
    // token, so hiding or resetting this section mid-render stops the
    // old chunks instead of painting them into the next state.
    const seq = diffRenderSeq;
    const hasChanges = window.SourceDiff.renderParts(
      conflictDiff,
      parts,
      () => seq === diffRenderSeq
    );

    if (!hasChanges) {
      conflictDiffStatus.textContent = '正文内容没有差异（差异仅在标题、简介或主题字段）。';
      return;
    }

    conflictDiffStatus.textContent = '红色为远端最新版中的行，绿色为我的稿件中的行。';
  }

  function runConflictDiff(before, after) {
    discardDiffRun();
    const seq = diffRenderSeq;

    conflictDiff.textContent = '';
    conflictDiffStatus.textContent = '正在比较差异…';

    if (!window.SourceDiff) {
      showDiffTooLarge();
      return;
    }

    // The shared SourceDiff consumer owns the Worker lifecycle, the
    // 1000ms algorithm budget and the 2000ms outer deadline (parent
    // spec §9). A superseded run resolves as 'superseded' and is
    // ignored here; a Worker failure rejects and lands in the same
    // truthful unfinished state as an over-budget comparison — with
    // both complete originals available below — never in a permanent
    // loading label and never as "no differences".
    window.SourceDiff.compare(before, after).then(function (result) {
      if (seq !== diffRenderSeq) return;

      if (result.status === 'ok') {
        renderConflictDiff(result.parts);
        return;
      }

      if (result.status === 'superseded') {
        return;
      }

      showDiffTooLarge();
    }).catch(function () {
      if (seq !== diffRenderSeq) return;

      showDiffTooLarge();
    });
  }

  function renderConflictMeta(remote, candidate) {
    conflictMetaBody.textContent = '';

    const rows = [
      ['标题', remote.title, candidate.title],
      ['简介', remote.description, candidate.description]
    ];

    if (candidate.markdownTheme !== undefined || remote.markdownTheme != null) {
      rows.push(['Markdown 主题', remote.markdownTheme, candidate.markdownTheme]);
    }

    let visible = 0;

    rows.forEach(function ([label, remoteValue, candidateValue]) {
      const remoteText = remoteValue == null || remoteValue === '' ? '（空）' : String(remoteValue);
      const candidateText = candidateValue == null || candidateValue === '' ? '（空）' : String(candidateValue);
      const row = document.createElement('tr');

      if (remoteText !== candidateText) {
        row.className = 'conflict-meta-changed';
      }

      [label, remoteText, candidateText].forEach(function (text) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.appendChild(cell);
      });

      conflictMetaBody.appendChild(row);
      visible += 1;
    });

    conflictMeta.hidden = visible === 0;
  }

  function showContentConflict(data, candidate) {
    conflictState = {
      remote: data.current,
      candidate,
      contentRevision: data.contentRevision,
      contentEtag: data.contentEtag
    };

    conflictSection.hidden = false;
    renderConflictMeta(data.current, candidate);
    conflictRemoteFull.textContent = data.current.htmlContent || '';
    conflictCandidateFull.textContent = candidate.htmlContent || '';
    runConflictDiff(data.current.htmlContent || '', candidate.htmlContent || '');
    conflictSection.scrollIntoView({ block: 'nearest' });
  }

  // --- Saves --------------------------------------------------------------

  async function saveContent(candidate, etagOverride) {
    setSaving(true);
    const etag = etagOverride || originalData.contentEtag || '';
    const requestId = requestIdForSave(candidate, etag);

    try {
      const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken(),
          'If-Match': etag,
          'Idempotency-Key': requestId
        },
        body: JSON.stringify(candidate)
      });
      const data = await response.json();

      if (response.status === 409 && data.code === 'idempotency_conflict') {
        // The identifier was already committed for a different request:
        // drop the intent so the next explicit save starts a fresh
        // operation. The draft and the baseline are left untouched —
        // nothing was saved by this request.
        clearSaveIntent();
        Toast.error('该保存操作标识已用于其他请求，操作标识已重置，请检查后重新保存');
        return;
      }

      if (response.status === 412 && data.code === 'content_conflict' && data.current) {
        // The candidate is preserved exactly as submitted (including its
        // raw bytes); nothing in the form is overwritten with remote
        // data, and no new baseline is adopted silently.
        showContentConflict(data, candidate);
        Toast.error('内容已被更新，你的稿件已保留，请查看差异');
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存内容失败');
      }

      clearSaveIntent();
      hideContentConflict();

      if (data.replayed) {
        // This response is the recorded result of this same save: the
        // candidate IS the committed content (the server replayed, it
        // did not re-apply anything and created no second Revision), so
        // only the version baseline advances to the recorded result.
        const replayedPage = {
          ...originalData,
          title: candidate.title,
          description: candidate.description,
          htmlContent: candidate.htmlContent,
          markdownTheme: candidate.markdownTheme !== undefined
            ? candidate.markdownTheme
            : originalData.markdownTheme,
          currentRevision: data.contentRevision,
          contentEtag: data.contentEtag,
          accessRevision: data.accessRevision || originalData.accessRevision
        };
        finishSuccessfulSave(
          replayedPage,
          data.contentChanged ? '内容已保存（此前提交已生效）' : '内容没有变化（此前提交已生效）'
        );
        return;
      }

      finishSuccessfulSave(
        data.page,
        data.contentChanged ? '内容已保存' : '内容没有变化'
      );
    } catch (error) {
      // A network failure leaves the outcome unknown: the intent (and
      // the draft) are kept, so an explicit retry of the same draft
      // replays the committed result instead of creating a second
      // version. Nothing is ever retried automatically.
      Toast.error(error.message || '保存内容失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveAccess() {
    const expiresAtValue = expiresInput.value;
    const expiresAt = expiresAtValue
      ? adminTime.parseDateTimeLocal(expiresAtValue)
      : null;
    const customPassword = passwordInput.value;

    if (protectedCheckbox.checked && customPassword && !customPasswordPattern.test(customPassword)) {
      passwordHint.textContent = customPasswordError;
      passwordHint.className = 'field-hint error';
      passwordInput.setAttribute('aria-invalid', 'true');
      Toast.error(customPasswordError);
      passwordInput.focus();
      return;
    }

    if (expiresAtValue && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
      expiresHint.textContent = '过期时间不能早于当前时间';
      expiresHint.className = 'field-hint error';
      Toast.error('请设置有效的过期时间');
      expiresInput.focus();
      return;
    }

    const payload = {
      isProtected: protectedCheckbox.checked,
      expiresAt,
      expectedAccessRevision: originalData.accessRevision
    };
    if (protectedCheckbox.checked && customPassword) payload.password = customPassword;

    setSaving(true);

    try {
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

      if (response.status === 412 && data.accessRevision) {
        originalData = { ...originalData, accessRevision: data.accessRevision };
        Toast.error('访问策略已被更新，已同步最新版本，请检查后重新保存');
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存访问设置失败');
      }

      finishSuccessfulSave(data.page, '访问设置已保存');
    } catch (error) {
      Toast.error(error.message || '保存访问设置失败');
    } finally {
      setSaving(false);
    }
  }

  editBtn.addEventListener('click', enterEditMode);
  cancelBtn.addEventListener('click', exitEditMode);

  const revokeAccessBtn = document.getElementById('revoke-access-btn');

  if (revokeAccessBtn) {
    revokeAccessBtn.addEventListener('click', async function () {
      revokeAccessBtn.disabled = true;

      try {
        const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id) + '/revoke-access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': csrfToken()
          },
          body: JSON.stringify({ expectedAccessRevision: originalData.accessRevision })
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || '撤销访问失败');
        }

        originalData = { ...originalData, accessRevision: data.accessRevision };
        Toast.success('已撤销所有已解锁访问，访客需要重新输入密码');
      } catch (error) {
        Toast.error(error.message || '撤销访问失败');
      } finally {
        revokeAccessBtn.disabled = false;
      }
    });
  }

  // --- Publish-state toggle (T11) -------------------------------------
  //
  // Unpublish / republish runs the same intent discipline as the save:
  // one pending intent { requestId, intentKey } in sessionStorage, where
  // the key binds the target state and the access-revision baseline the
  // request is judged against. A retry after a lost response reuses the
  // requestId and replays the recorded result; a moved baseline (a 412
  // resyncs originalData.accessRevision) makes the next click a fresh
  // intent. A confirmed result retires the intent.
  const publishToggleBtn = document.getElementById('publish-toggle-btn');
  const publishToggleLabel = document.getElementById('publish-toggle-label');
  const publishToggleIcon = document.getElementById('publish-toggle-icon');
  const publishedDisplay = document.getElementById('published-display');
  const publishIntentStorageKey = 'quickshare-admin-publish-intent:' + (originalData.id || '');
  let publishIntent = null;

  try {
    const storedPublishIntent = window.sessionStorage.getItem(publishIntentStorageKey);
    if (storedPublishIntent) {
      publishIntent = JSON.parse(storedPublishIntent);
    }
  } catch (error) {
    publishIntent = null;
  }

  function persistPublishIntent() {
    try {
      if (publishIntent) {
        window.sessionStorage.setItem(publishIntentStorageKey, JSON.stringify(publishIntent));
      } else {
        window.sessionStorage.removeItem(publishIntentStorageKey);
      }
    } catch (error) {
      // Storage unavailable: the in-memory intent still applies.
    }
  }

  function publishIntentKeyFor(targetPublished) {
    return 'publish:' + (targetPublished ? 'true' : 'false')
      + ':access:' + (originalData.accessRevision || '');
  }

  function requestIdForPublish(targetPublished) {
    const intentKey = publishIntentKeyFor(targetPublished);

    if (publishIntent && publishIntent.intentKey === intentKey && publishIntent.requestId) {
      return publishIntent.requestId;
    }

    publishIntent = {
      requestId: window.PublishIntent
        ? window.PublishIntent.generateRequestId()
        : 'publish-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      intentKey
    };
    persistPublishIntent();
    return publishIntent.requestId;
  }

  function clearPublishIntent() {
    publishIntent = null;
    persistPublishIntent();
  }

  function updatePublishedDisplay() {
    if (publishToggleBtn) {
      publishToggleBtn.setAttribute('aria-pressed', originalData.published ? 'true' : 'false');
    }

    if (publishToggleLabel) {
      publishToggleLabel.textContent = originalData.published ? '下架' : '重新发布';
    }

    if (publishToggleIcon) {
      publishToggleIcon.className = 'fas ' + (originalData.published ? 'fa-eye-slash' : 'fa-eye');
    }

    if (publishedDisplay) {
      publishedDisplay.textContent = '';
      const badge = document.createElement('span');
      badge.className = 'admin-status ' + (originalData.published ? 'public' : 'protected');
      badge.textContent = originalData.published ? '已发布' : '已下架';
      publishedDisplay.append(badge);
    }
  }

  if (publishToggleBtn) {
    publishToggleBtn.addEventListener('click', async function () {
      const targetPublished = !originalData.published;
      const requestId = requestIdForPublish(targetPublished);
      publishToggleBtn.disabled = true;

      try {
        const response = await fetch('/admin/pages/' + encodeURIComponent(originalData.id) + '/publish-state', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': csrfToken()
          },
          body: JSON.stringify({
            published: targetPublished,
            expectedAccessRevision: originalData.accessRevision,
            requestId
          })
        });
        const data = await response.json();

        if (response.status === 412 && data.accessRevision) {
          originalData = { ...originalData, accessRevision: data.accessRevision };
          Toast.error('访问策略已被更新，已同步最新版本，请检查后重试');
          return;
        }

        if (!response.ok || !data.success) {
          throw new Error(data.error || '更新发布状态失败');
        }

        clearPublishIntent();
        originalData = {
          ...originalData,
          published: data.published === true,
          accessRevision: data.accessRevision || originalData.accessRevision
        };
        updatePublishedDisplay();
        // The rendered preview loads the public URL; after a state
        // change it must not keep showing the pre-change document.
        resetRenderedPreview();

        if (data.unchanged) {
          Toast.success('已是该状态，未做变更');
        } else if (data.published) {
          Toast.success('已重新发布，公开链接恢复访问；此前解锁的访客需要重新输入密码');
        } else {
          Toast.success('已下架，公开链接将返回 404；密码、有效期与历史版本保持不变');
        }
      } catch (error) {
        Toast.error(error.message || '更新发布状态失败');
      } finally {
        publishToggleBtn.disabled = false;
      }
    });
  }

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

  if (conflictLoadRemoteBtn) {
    conflictLoadRemoteBtn.addEventListener('click', function () {
      if (!conflictState) return;

      const remote = conflictState.remote;

      // Explicit owner choice: the preserved candidate is discarded and
      // the editor restarts from the current remote snapshot and its
      // ETag. Nothing here merges the two versions.
      originalData = {
        ...originalData,
        htmlContent: remote.htmlContent,
        title: remote.title,
        description: remote.description,
        markdownTheme: remote.markdownTheme || '',
        currentRevision: conflictState.contentRevision,
        contentEtag: conflictState.contentEtag
      };
      document.getElementById('edit-title').value = remote.title || '';
      document.getElementById('edit-description').value = remote.description || '';
      contentTextarea.value = remote.htmlContent || '';
      if (themeSelect) {
        themeSelect.value = remote.markdownTheme || 'bytedance';
        if (window.ThemeSampler) window.ThemeSampler.updateForSelect(themeSelect);
      }
      updateRevisionDisplay();
      hideContentConflict();
      Toast.success('已加载远端最新版，我的未保存稿已被替换');
    });
  }

  if (conflictSaveMineBtn) {
    conflictSaveMineBtn.addEventListener('click', async function () {
      if (!conflictState) return;

      // Explicit owner choice: save the preserved candidate — the exact
      // bytes that conflicted — on top of the current remote Revision,
      // using the fresh ETag from the conflict response as the new
      // precondition. The candidate is not rebuilt from the form, so its
      // identity (including CRLF bytes) is exactly what was compared.
      await saveContent(conflictState.candidate, conflictState.contentEtag);
    });
  }

  // A history restore (T09) advances the current Revision behind this
  // page's back: adopt the new baseline so the revision display and any
  // later save use the restored version's ETag. An open draft is never
  // overwritten — only the version it will be saved against moves.
  window.addEventListener('quickshare:revision-changed', function (event) {
    const detail = event.detail || {};

    if (detail.contentRevision) {
      originalData = {
        ...originalData,
        currentRevision: detail.contentRevision,
        contentEtag: detail.contentEtag || originalData.contentEtag
      };
      updateRevisionDisplay();
    }
  });

  editForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    // Content and access settings save separately (T06): each submit
    // button carries its family, and each family sends only its own
    // fields with its own precondition (content If-Match for content,
    // expectedAccessRevision for access settings). The server still
    // accepts a combined save and then requires both preconditions.
    const family = (event.submitter && event.submitter.dataset.saveFamily) || 'content';

    if (family === 'access') {
      await saveAccess();
    } else {
      await saveContent(readContentCandidate());
    }
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
