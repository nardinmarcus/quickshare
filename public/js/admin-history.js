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
