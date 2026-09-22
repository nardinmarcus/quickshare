// Owner history client (#31). Dashboard-only surface on top of the read-only
// history endpoints. Contract:
// - Every async flow carries a monotonic token; a slower stale HTTP response
//   or stale Worker result NEVER overwrites the current target's state.
// - Body diffs run through the official vendored jsdiff worker (SourceDiff);
//   an unfinished comparison is reported as unfinished, never as "no diff".
// - Meta comparisons are labelled with the SELECTED REVISIONS (版本 A/B),
//   never with the #30 conflict wording ("当前远端/我的修改").
// - Previews target the dedicated sandboxed admin endpoint; no public
//   analytics, no view counting, no same-origin grant for embedded content.
(function () {
  const dataElement = document.getElementById('history-data');
  let share = {};
  try {
    share = JSON.parse(dataElement ? dataElement.textContent || '{}' : '{}');
  } catch (error) {
    console.error('无法读取历史数据：', error);
  }

  // ---- Owner restore (#33): confirm dialog, idempotent restore intent ----
  const PublishingRequest = window.QuickSharePublishingRequest;
  const RESTORE_KIND = 'restore';
  const restoreDialog = document.getElementById('restore-dialog');
  const restoreSummary = document.getElementById('restore-summary');
  const restoreStatus = document.getElementById('restore-status');
  const restoreConfirmBtn = document.getElementById('restore-confirm');
  const restoreCancelBtn = document.getElementById('restore-cancel');
  const restoreDiscardBtn = document.getElementById('restore-discard');
  let restoreSourceRevision = null;
  let restoreBusy = false;

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function contentIfMatch() {
    // Strong HTTP entity-tag, quoted form; identifies the CURRENT content
    // the restore's version condition is checked against.
    return '"content:' + share.id + ':' + share.currentRevision + '"';
  }

  function restoreDraftKey() {
    return JSON.stringify([RESTORE_KIND, share.id, share.currentRevision, restoreSourceRevision]);
  }

  function setRestoreBusy(busy) {
    restoreBusy = busy;
    if (restoreConfirmBtn) {
      restoreConfirmBtn.disabled = busy;
      restoreConfirmBtn.textContent = busy ? '正在恢复…' : '确认恢复';
      restoreConfirmBtn.setAttribute('aria-busy', String(busy));
    }
    if (restoreCancelBtn) restoreCancelBtn.disabled = busy;
    if (restoreDiscardBtn) restoreDiscardBtn.disabled = busy;
  }

  function setRestoreStatus(text) {
    if (restoreDiscardBtn) restoreDiscardBtn.hidden = !(PublishingRequest && PublishingRequest.readDashboardIntent(RESTORE_KIND, share.id));
    if (restoreStatus) {
      restoreStatus.textContent = text || '';
      restoreStatus.hidden = !text;
    }
  }

  function refreshRestorePendingStatus() {
    if (!PublishingRequest || !restoreSourceRevision) return;
    const intent = PublishingRequest.readDashboardIntent(RESTORE_KIND, share.id);
    if (!intent) return;
    setRestoreStatus(PublishingRequest.dashboardIntentStatusMessage(intent, restoreDraftKey(), '恢复'));
  }

  function openRestoreDialog(revision) {
    if (restoreBusy) return;
    restoreSourceRevision = revision;
    if (restoreSummary) {
      restoreSummary.textContent = '将把版本 ' + revision + ' 的完整快照恢复为新的当前版本。当前版本为 '
        + share.currentRevision + '。内容不同时写入新版本并记录来源，相同时不新增版本；访问策略不变。';
    }
    setRestoreStatus('');
    refreshRestorePendingStatus();
    if (restoreDialog) {
      restoreDialog.hidden = false;
      if (restoreConfirmBtn) restoreConfirmBtn.focus();
    }
  }

  function closeRestoreDialog() {
    restoreSourceRevision = null;
    setRestoreBusy(false);
    setRestoreStatus('');
    if (restoreDialog) restoreDialog.hidden = true;
  }

  async function confirmRestore() {
    if (restoreBusy || !restoreSourceRevision) return;
    const sourceRevision = restoreSourceRevision;
    setRestoreBusy(true);
    let claimedRequestId = null;
    try {
      if (PublishingRequest) {
        const claim = PublishingRequest.claimDashboardIntentId({
          kind: RESTORE_KIND,
          shareId: share.id,
          draftKey: restoreDraftKey(),
          summary: { sourceRevision: String(sourceRevision) }
        });
        if (claim.mode === 'blocked') {
          setRestoreStatus('存在属于其他后台会话的未确认恢复，本次提交已被阻止；可在管理后台按请求标识核对。');
          setRestoreBusy(false);
          return;
        }
        if (PublishingRequest.consumeDashboardReplaced(RESTORE_KIND, share.id)) {
          setRestoreStatus('当前版本已变化：将以新请求提交本次恢复');
        }
        claimedRequestId = claim.requestId;
      }

      const response = await fetch('/admin/pages/' + encodeURIComponent(share.id) + '/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken(),
          'If-Match': contentIfMatch(),
          ...(claimedRequestId ? { 'Idempotency-Key': claimedRequestId } : {})
        },
        body: JSON.stringify({ revision: sourceRevision })
      });
      const data = await response.json().catch(() => null);

      if (response.status === 412 && data && data.code === 'CONTENT_REVISION_CONFLICT') {
        // A refusal never upgrades the user's authorized baseline or loses
        // the identity of a possibly committed earlier attempt.
        setRestoreBusy(false);
        const remoteRevision = data.current && data.current.currentRevision;
        setRestoreStatus('当前版本已变为第 ' + (remoteRevision || '未知')
          + ' 版，本次恢复未执行也未产生新版本；原基线与请求标识已保留。请主动刷新并核对来源与最新版本后重新选择恢复。');
        return;
      }

      if (response.status === 409 && data && data.code === 'REQUEST_ID_CONFLICT') {
        setRestoreStatus('该请求标识已绑定不同内容：请刷新页面或放弃原请求后重试。原请求不会被自动替换。');
        setRestoreBusy(false);
        return;
      }

      if (!response.ok || !data || !data.success || !data.page) {
        // HTTP errors (including 5xx) or unreadable responses do not prove
        // an earlier attempt was uncommitted. Only confirmed success clears.
        setRestoreBusy(false);
        setRestoreStatus((data && data.error) || '恢复失败，请稍后重试');
        return;
      }

      if (PublishingRequest) PublishingRequest.confirmDashboardCompleted(RESTORE_KIND, share.id);
      const confirmedReplay = Boolean(data.replayed);
      if (data.changed === false && !confirmedReplay) {
        setRestoreBusy(false);
        setRestoreStatus('来源与当前内容相同，未产生新版本；本次恢复已确认完成。');
        return;
      }
      Toast.success(data.changed === false
        ? '来源与当前内容相同，未产生新版本'
        : (confirmedReplay
          ? '已确认上次恢复的结果（结果版本第 ' + data.page.currentRevision + ' 版），页面即将刷新'
          : '恢复成功：已写入新当前版本 ' + data.page.currentRevision));
      closeRestoreDialog();
      // The server-rendered list and current-revision display are stale the
      // moment a restore commits; reload for an honest view.
      window.location.reload();
    } catch (error) {
      setRestoreBusy(false);
      if (claimedRequestId) {
        // No response: outcome unknown. The intent and its ORIGINAL id stay;
        // the next confirm retries the same request.
        setRestoreStatus('网络失败，恢复结果未知：原请求标识已保留，再次确认将以原请求重试并确认原结果。');
      } else {
        setRestoreStatus((error && error.message) || '恢复失败，请稍后重试');
      }
    }
  }

  if (restoreDiscardBtn) restoreDiscardBtn.addEventListener('click', function () {
    if (restoreBusy || !PublishingRequest) return;
    if (!window.confirm('放弃待确认请求不会撤销服务器上可能已完成的恢复。请先按请求标识核对；继续后将以新请求提交。')) return;
    PublishingRequest.discardDashboardIntent(RESTORE_KIND, share.id);
    setRestoreStatus('已放弃原请求标识；来源与当前基线未变，下次确认将作为新请求。');
  });

  if (restoreConfirmBtn) {
    restoreConfirmBtn.addEventListener('click', function () {
      return confirmRestore();
    });
  }
  if (restoreCancelBtn) {
    restoreCancelBtn.addEventListener('click', function () {
      if (!restoreBusy) closeRestoreDialog();
    });
  }

  const table = document.getElementById('history-table');
  const selectA = document.getElementById('compare-select-a');
  const selectB = document.getElementById('compare-select-b');
  const compareRunBtn = document.getElementById('compare-run');
  const compareStatus = document.getElementById('compare-status');
  const compareSourceActions = document.getElementById('compare-source-actions');
  const compareRawABtn = document.getElementById('compare-raw-a');
  const compareRawBBtn = document.getElementById('compare-raw-b');
  const comparePreviewABtn = document.getElementById('compare-preview-a');
  const comparePreviewBBtn = document.getElementById('compare-preview-b');
  const compareMetaSummary = document.getElementById('compare-meta-summary');
  const compareMeta = document.getElementById('compare-meta');
  const compareDiff = document.getElementById('compare-diff');
  const rawPanel = document.getElementById('history-raw-panel');
  const rawTitle = document.getElementById('history-raw-title');
  const rawView = document.getElementById('history-raw-view');
  const previewEmpty = document.getElementById('history-preview-empty');
  const previewFrame = document.getElementById('history-preview-frame');
  const previewOpen = document.getElementById('history-preview-open');

  const SourceDiff = window.SourceDiff;
  let compareToken = 0;
  let rawToken = 0;
  let desiredPreviewRevision = null;
  // The compared pair, kept as exact decimal STRINGS (never Number): raw and
  // preview actions for both sides must work for ANY compared version,
  // including ones outside the current page and above 2^53.
  let comparedA = null;
  let comparedB = null;

  function revisionUrl(revision) {
    return '/admin/pages/' + encodeURIComponent(share.id) + '/revisions/' + encodeURIComponent(revision);
  }

  function previewUrl(revision) {
    return revisionUrl(revision) + '/preview';
  }

  async function fetchRevision(revision) {
    const response = await fetch(revisionUrl(revision), { headers: { Accept: 'application/json' } });
    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }
    if (!response.ok || !data.success) {
      const error = new Error(data.error || '读取版本失败，请稍后重试');
      error.status = response.status;
      error.revision = revision;
      throw error;
    }
    return data.revision;
  }

  function formatValue(value) {
    return value === null || value === undefined || value === '' ? '（空）' : value;
  }

  function metaSummaryFields(left, right) {
    const fields = [
      { label: '标题', key: 'title' },
      { label: '描述', key: 'description' }
    ];
    if (share.codeType === 'markdown') {
      fields.push({ label: 'Markdown 主题', key: 'markdownTheme' });
    }
    return fields.map(function (field) {
      return {
        label: field.label,
        left: '版本 ' + left.revision + '：' + formatValue(left[field.key]),
        right: '版本 ' + right.revision + '：' + formatValue(right[field.key])
      };
    });
  }

  function renderMetaSummary(left, right) {
    compareMetaSummary.textContent = '';
    metaSummaryFields(left, right).forEach(function (field) {
      const row = document.createElement('div');
      row.className = 'history-meta-summary-row';
      const name = document.createElement('span');
      name.className = 'conflict-meta-name';
      name.textContent = field.label;
      const leftValue = document.createElement('span');
      leftValue.textContent = field.left;
      const rightValue = document.createElement('span');
      rightValue.textContent = field.right;
      row.appendChild(name);
      row.appendChild(leftValue);
      row.appendChild(rightValue);
      compareMetaSummary.appendChild(row);
    });
    compareMetaSummary.hidden = false;
  }

  function metaComparisonFields(left, right) {
    const fields = [
      { label: '标题', remoteValue: left.title, localValue: right.title },
      { label: '描述', remoteValue: left.description, localValue: right.description }
    ];
    if (share.codeType === 'markdown') {
      fields.push({ label: 'Markdown 主题', remoteValue: left.markdownTheme, localValue: right.markdownTheme });
    }
    return fields;
  }

  function resetComparisonView() {
    if (SourceDiff && SourceDiff.cancelRender) SourceDiff.cancelRender(compareDiff);
    compareDiff.textContent = '';
    compareMeta.hidden = true;
    compareMeta.textContent = '';
  }

  async function loadRaw(revision) {
    const token = ++rawToken;
    rawPanel.hidden = false;
    rawTitle.textContent = '版本 ' + revision + ' 原稿加载中…';
    rawView.value = '';
    try {
      const revisionData = await fetchRevision(revision);
      if (token !== rawToken) return; // stale load: discard
      rawTitle.textContent = '版本 ' + revision + ' 原稿（只读）';
      rawView.value = revisionData.htmlContent;
    } catch (error) {
      if (token !== rawToken) return;
      rawTitle.textContent = '版本 ' + revision + ' 原稿读取失败：' + (error.message || '请稍后重试');
    }
  }

  function openPreview(revision) {
    desiredPreviewRevision = revision;
    previewEmpty.hidden = true;
    previewFrame.hidden = false;
    previewOpen.hidden = false;
    previewOpen.href = previewUrl(revision);
    previewFrame.dataset.expectedRevision = revision;
    previewFrame.src = previewUrl(revision);
  }

  // A slow older preview document must never displace the current selection.
  previewFrame.addEventListener('load', function () {
    if (previewFrame.dataset.expectedRevision !== desiredPreviewRevision && desiredPreviewRevision) {
      previewFrame.dataset.expectedRevision = desiredPreviewRevision;
      previewFrame.src = previewUrl(desiredPreviewRevision);
    }
  });

  async function runCompare() {
    const older = selectA ? selectA.value : '';
    const newer = selectB ? selectB.value : '';
    resetComparisonView();
    compareMetaSummary.hidden = true;
    compareMetaSummary.textContent = '';
    rawPanel.hidden = true;
    rawTitle.textContent = '';
    rawView.value = '';

    if (!older || !newer) {
      compareStatus.textContent = '请选择两个要比较的版本。';
      return;
    }
    if (older === newer) {
      compareStatus.textContent = '请选择两个不同的版本。';
      return;
    }

    const token = ++compareToken;
    compareSourceActions.hidden = true;
    compareStatus.textContent = '正在加载版本 ' + older + ' 与版本 ' + newer + '…';

    try {
      const left = await fetchRevision(older);
      if (token !== compareToken) return;
      const right = await fetchRevision(newer);
      if (token !== compareToken) return;
      comparedA = left;
      comparedB = right;
      compareSourceActions.hidden = false;

      // Both sides are identified by their SELECTED revision numbers.
      renderMetaSummary(left, right);
      if (SourceDiff && SourceDiff.renderMetaChanges) {
        SourceDiff.renderMetaChanges(compareMeta, metaComparisonFields(left, right), {
          previousLabel: '版本 ' + older,
          currentLabel: '版本 ' + newer
        });
      }
      compareStatus.textContent = '正在比较版本 ' + older + ' → 版本 ' + newer + ' 的正文…';

      let result;
      try {
        result = await SourceDiff.compare(left.htmlContent, right.htmlContent);
      } catch (error) {
        // Comparator failure: a distinct terminal unfinished state — never
        // mislabelled as an oversized diff, raw sources stay reachable.
        if (token !== compareToken) return; // stale rejection: discard
        resetComparisonView();
        compareStatus.textContent = '差异比较失败，未完成比较。可用下方原稿视图或列表「原稿」按钮分别查看两个版本的完整内容。';
        await loadRaw(older);
        return;
      }
      if (token !== compareToken) return; // stale worker result: discard

      if (result.status === 'ok') {
        SourceDiff.renderParts(compareDiff, result.parts);
        const changed = result.parts.some(function (part) { return part.added || part.removed; });
        compareStatus.textContent = changed
          ? '以下为版本 ' + older + ' → 版本 ' + newer + ' 的正文行级差异（保留空白与换行）：'
          : '正文没有行级差异；上方列出了两个版本的标题、描述与主题取值。';
      } else {
        // Timeout/worker failure: an unfinished comparison is NEVER displayed
        // as "no differences". Both complete sources stay reachable.
        resetComparisonView();
        compareStatus.textContent = '差异过大，未完成比较。可用下方原稿视图或列表「原稿」按钮分别查看两个版本的完整内容。';
        await loadRaw(older);
      }
    } catch (error) {
      if (token !== compareToken) return;
      if (error.status === 404) {
        compareStatus.textContent = '版本 ' + error.revision + ' 不存在或已不在历史中，请核对版本号。';
      } else if (error.status === 400) {
        compareStatus.textContent = '版本 ' + error.revision + ' 不是有效的版本号：仅接受正整数十进制。';
      } else {
        compareStatus.textContent = error.message || '读取版本失败，请稍后重试';
      }
    }
  }

  if (table) {
    table.addEventListener('click', async function (event) {
      const control = event.target && event.target.closest ? event.target.closest('[data-history-action]') : null;
      if (!control) return;
      const revision = control.getAttribute('data-revision');
      if (!revision) return;
      if (control.getAttribute('data-history-action') === 'preview') {
        openPreview(revision);
      } else if (control.getAttribute('data-history-action') === 'raw') {
        await loadRaw(revision);
      } else if (control.getAttribute('data-history-action') === 'restore') {
        openRestoreDialog(revision);
      }
    });
  }

  if (compareRunBtn) {
    compareRunBtn.addEventListener('click', function () {
      return runCompare();
    });
  }

  // Full raw sources and previews for BOTH compared versions — reachable
  // even when the versions are not on the current history page.
  if (compareRawABtn) {
    compareRawABtn.addEventListener('click', function () {
      if (comparedA) return loadRaw(comparedA.revision);
    });
  }
  if (compareRawBBtn) {
    compareRawBBtn.addEventListener('click', function () {
      if (comparedB) return loadRaw(comparedB.revision);
    });
  }
  if (comparePreviewABtn) {
    comparePreviewABtn.addEventListener('click', function () {
      if (comparedA) openPreview(comparedA.revision);
    });
  }
  if (comparePreviewBBtn) {
    comparePreviewBBtn.addEventListener('click', function () {
      if (comparedB) openPreview(comparedB.revision);
    });
  }
})();
