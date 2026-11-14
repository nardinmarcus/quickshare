(function () {
  // Admin Share history browser (T07, issue #31; parent spec #24 §9).
  //
  // Read-only browsing of a Share's content Revisions: a paginated,
  // metadata-only list (newest first), single-Revision raw source,
  // sandboxed preview, and a two-Revision comparison that reuses the
  // shared SourceDiff mechanism (vendored jsdiff in a Worker, same
  // budgets and unfinished-state semantics as the conflict view).
  // Any two Revisions can be compared — the selection is kept as
  // Revision numbers, not page rows, so it survives pagination.
  //
  // Every asynchronous surface carries a sequence guard: switching the
  // list page, the source target, the preview target or the comparison
  // target discards the previous run's late results instead of painting
  // them over the newer target. There is deliberately no restore or
  // purge control here — this ticket ships browsing only.

  const section = document.getElementById('history-section');
  if (!section) return;

  const statusEl = document.getElementById('history-status');
  const retryBtn = document.getElementById('history-retry');
  const listEl = document.getElementById('history-list');
  const pagerEl = document.getElementById('history-pager');
  const prevBtn = document.getElementById('history-prev');
  const nextBtn = document.getElementById('history-next');
  const pageInfoEl = document.getElementById('history-page-info');
  const compareBar = document.getElementById('history-compare-bar');
  const compareSelectionEl = document.getElementById('history-compare-selection');
  const compareRunBtn = document.getElementById('history-compare-run');
  const compareClearBtn = document.getElementById('history-compare-clear');
  const compareResult = document.getElementById('history-compare-result');
  const compareTitle = document.getElementById('history-compare-title');
  const compareMeta = document.getElementById('history-compare-meta');
  const compareMetaBody = document.getElementById('history-compare-meta-body');
  const compareStatus = document.getElementById('history-compare-status');
  const compareDiff = document.getElementById('history-compare-diff');
  const compareBeforeFull = document.getElementById('history-compare-before-full');
  const compareAfterFull = document.getElementById('history-compare-after-full');
  const sourcePanel = document.getElementById('history-source');
  const sourceTitle = document.getElementById('history-source-title');
  const sourceStatus = document.getElementById('history-source-status');
  const sourceBody = document.getElementById('history-source-body');
  const sourceCloseBtn = document.getElementById('history-source-close');
  const previewPanel = document.getElementById('history-preview');
  const previewTitle = document.getElementById('history-preview-title');
  const previewFrame = document.getElementById('history-preview-frame');
  const previewCloseBtn = document.getElementById('history-preview-close');
  const pageDataElement = document.getElementById('page-data');

  const PAGE_LIMIT = 20;
  const SOURCE_LABELS = {
    'web-create': '网页创建',
    'api-create': 'API 创建',
    'admin-edit': '后台编辑',
    'admin-clone': '后台克隆',
    baseline: '基线回填',
    'legacy-update': '旧版更新'
  };

  let pageData = {};

  try {
    pageData = JSON.parse(pageDataElement.textContent || '{}');
  } catch (error) {
    console.error('无法读取分享数据：', error);
  }

  const shareId = pageData.id || '';
  const currentRevision = pageData.currentRevision || null;

  let listPageIndex = 0;
  let listTotal = 0;
  let listSeq = 0;
  let readSeq = 0;
  let compareSeq = 0;
  const selectedRevisions = [];

  function apiUrl(path) {
    return '/admin/pages/' + encodeURIComponent(shareId) + path;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.error) || '请求失败');
    }

    return data;
  }

  function sourceLabel(item) {
    const label = SOURCE_LABELS[item.source] || item.source || '未知来源';
    return item.actorType && item.actorType !== 'owner'
      ? label + '（' + item.actorType + '）'
      : label;
  }

  function invalidateCompare() {
    compareSeq += 1;

    if (window.SourceDiff) {
      window.SourceDiff.cancel();
    }
  }

  // --- History list -----------------------------------------------------

  function renderList(items) {
    listEl.textContent = '';

    items.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'admin-history-item';

      const main = document.createElement('div');
      main.className = 'admin-history-item-main';

      const heading = document.createElement('div');
      heading.className = 'admin-history-item-heading';

      const title = document.createElement('strong');
      title.textContent = 'Revision ' + item.revision;
      heading.appendChild(title);

      if (currentRevision && item.revision === currentRevision) {
        const badge = document.createElement('span');
        badge.className = 'admin-status public';
        badge.textContent = '当前版本';
        heading.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'admin-history-item-meta';
      meta.textContent = item.createdAtText + ' · 来源：' + sourceLabel(item)
        + (item.restoredFromRevision ? ' · 恢复自 Revision ' + item.restoredFromRevision : '');

      main.append(heading, meta);

      const actions = document.createElement('div');
      actions.className = 'admin-history-item-actions';

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'cyber-btn cyber-btn-secondary';
      previewBtn.textContent = '预览';
      previewBtn.addEventListener('click', function () {
        showPreview(item.revision);
      });

      const sourceBtn = document.createElement('button');
      sourceBtn.type = 'button';
      sourceBtn.className = 'cyber-btn cyber-btn-secondary';
      sourceBtn.textContent = '源码';
      sourceBtn.addEventListener('click', function () {
        showSource(item.revision);
      });

      const compareBtn = document.createElement('button');
      compareBtn.type = 'button';
      compareBtn.className = 'cyber-btn cyber-btn-secondary';
      compareBtn.dataset.compareToggle = item.revision;
      compareBtn.setAttribute('aria-pressed', 'false');
      compareBtn.textContent = '加入对比';
      compareBtn.addEventListener('click', function () {
        toggleCompareSelection(item.revision);
      });

      actions.append(previewBtn, sourceBtn, compareBtn);
      row.append(main, actions);
      listEl.appendChild(row);
    });

    refreshCompareButtons();
  }

  function renderPager() {
    const pageCount = Math.max(1, Math.ceil(listTotal / PAGE_LIMIT));

    pagerEl.hidden = listTotal === 0;
    pageInfoEl.textContent = '第 ' + (listPageIndex + 1) + ' / ' + pageCount + ' 页 · 共 ' + listTotal + ' 个版本';
    prevBtn.disabled = listPageIndex <= 0;
    nextBtn.disabled = listPageIndex + 1 >= pageCount;
  }

  async function loadList() {
    const seq = ++listSeq;
    invalidateCompare();

    statusEl.textContent = '正在加载历史…';
    retryBtn.hidden = true;
    listEl.textContent = '';
    pagerEl.hidden = true;

    try {
      const data = await fetchJson(
        apiUrl('/revisions?limit=' + PAGE_LIMIT + '&offset=' + (listPageIndex * PAGE_LIMIT))
      );

      if (seq !== listSeq) return;

      listTotal = data.total;

      if (data.total === 0) {
        statusEl.textContent = currentRevision
          ? '暂无历史版本。'
          : '该分享尚未建立基线版本，暂无历史。';
        renderPager();
        return;
      }

      statusEl.textContent = '';
      renderList(data.revisions);
      renderPager();
    } catch (error) {
      if (seq !== listSeq) return;

      statusEl.textContent = '历史加载失败，请稍后重试。';
      retryBtn.hidden = false;
    }
  }

  // --- Compare selection --------------------------------------------------

  function sortedSelection() {
    return [...selectedRevisions].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  }

  function refreshCompareButtons() {
    const buttons = listEl.querySelectorAll('[data-compare-toggle]');

    buttons.forEach(function (button) {
      const revision = button.getAttribute('data-compare-toggle');
      const selected = selectedRevisions.includes(revision);

      button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? '取消选择' : '加入对比';
      button.disabled = !selected && selectedRevisions.length >= 2;
    });

    if (selectedRevisions.length === 0) {
      compareBar.hidden = true;
      return;
    }

    compareBar.hidden = false;

    if (selectedRevisions.length === 1) {
      compareSelectionEl.textContent = '已选 Revision ' + selectedRevisions[0] + '，再选择一个版本进行比较';
      compareRunBtn.disabled = true;
    } else {
      const [before, after] = sortedSelection();
      compareSelectionEl.textContent = 'Revision ' + before + ' ↔ Revision ' + after;
      compareRunBtn.disabled = false;
    }
  }

  function toggleCompareSelection(revision) {
    const index = selectedRevisions.indexOf(revision);

    if (index >= 0) {
      selectedRevisions.splice(index, 1);
    } else if (selectedRevisions.length < 2) {
      selectedRevisions.push(revision);
    } else {
      return;
    }

    // A changed selection makes any displayed comparison stale.
    invalidateCompare();
    compareResult.hidden = true;
    refreshCompareButtons();
  }

  // --- Single-Revision source --------------------------------------------

  async function showSource(revision) {
    const seq = ++readSeq;
    invalidateCompare();

    sourcePanel.hidden = false;
    sourceTitle.textContent = 'Revision ' + revision;
    sourceStatus.textContent = '正在加载源码…';
    sourceBody.textContent = '';
    sourcePanel.scrollIntoView({ block: 'nearest' });

    try {
      const data = await fetchJson(apiUrl('/revisions/' + encodeURIComponent(revision)));

      if (seq !== readSeq) return;

      const snapshot = data.revision;
      sourceTitle.textContent = 'Revision ' + snapshot.revision + ' · ' + (snapshot.codeType || 'html');
      sourceStatus.textContent = snapshot.createdAtText + ' · 来源：' + sourceLabel(snapshot);
      // Plain-text only: the raw source is assigned as text, never
      // parsed or executed.
      sourceBody.textContent = snapshot.htmlContent || '';
    } catch (error) {
      if (seq !== readSeq) return;

      sourceStatus.textContent = '源码加载失败，请稍后重试。';
      sourceBody.textContent = '';
    }
  }

  // --- Single-Revision preview --------------------------------------------

  function showPreview(revision) {
    readSeq += 1;
    invalidateCompare();

    previewTitle.textContent = 'Revision ' + revision;
    previewPanel.hidden = false;
    // The framed document is rendered by the existing sandbox pipeline
    // from the stored snapshot; the iframe keeps the standard admin
    // sandbox (no allow-same-origin) and the document itself carries
    // no admin credential.
    previewFrame.src = apiUrl('/revisions/' + encodeURIComponent(revision) + '/preview');
    previewPanel.scrollIntoView({ block: 'nearest' });
  }

  // --- Two-Revision comparison ---------------------------------------------

  function renderCompareMeta(before, after) {
    compareMetaBody.textContent = '';

    const rows = [
      ['标题', before.title, after.title],
      ['简介', before.description, after.description],
      ['Markdown 主题', before.markdownTheme, after.markdownTheme],
      ['内容类型', before.codeType, after.codeType]
    ];
    let changed = false;

    rows.forEach(function ([label, beforeValue, afterValue]) {
      const beforeText = beforeValue == null || beforeValue === '' ? '（空）' : String(beforeValue);
      const afterText = afterValue == null || afterValue === '' ? '（空）' : String(afterValue);
      const row = document.createElement('tr');

      if (beforeText !== afterText) {
        row.className = 'conflict-meta-changed';
        changed = true;
      }

      [label, beforeText, afterText].forEach(function (text) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.appendChild(cell);
      });

      compareMetaBody.appendChild(row);
    });

    compareMeta.hidden = false;
    return changed;
  }

  async function runCompare() {
    if (selectedRevisions.length !== 2) return;

    const [beforeRevision, afterRevision] = sortedSelection();
    const seq = ++compareSeq;

    compareResult.hidden = false;
    compareTitle.textContent = 'Revision ' + beforeRevision + ' ↔ Revision ' + afterRevision;
    compareMeta.hidden = true;
    compareStatus.textContent = '正在读取所选版本…';
    compareDiff.textContent = '';
    compareBeforeFull.textContent = '';
    compareAfterFull.textContent = '';
    compareResult.scrollIntoView({ block: 'nearest' });

    let before;
    let after;

    try {
      const [beforeData, afterData] = await Promise.all([
        fetchJson(apiUrl('/revisions/' + encodeURIComponent(beforeRevision))),
        fetchJson(apiUrl('/revisions/' + encodeURIComponent(afterRevision)))
      ]);

      if (seq !== compareSeq) return;

      before = beforeData.revision;
      after = afterData.revision;
    } catch (error) {
      if (seq !== compareSeq) return;

      compareStatus.textContent = '读取所选版本失败，请稍后重试。';
      return;
    }

    const metaChanged = renderCompareMeta(before, after);

    // Both complete raw sources are always available to the owner,
    // including when the comparison itself cannot finish.
    compareBeforeFull.textContent = before.htmlContent || '';
    compareAfterFull.textContent = after.htmlContent || '';

    compareStatus.textContent = '正在比较差异…';

    if (!window.SourceDiff) {
      compareStatus.textContent = '比较失败，未能完成比较。可分别查看两个版本的完整正文。';
      return;
    }

    try {
      const result = await window.SourceDiff.compare(before.htmlContent || '', after.htmlContent || '');

      if (seq !== compareSeq) return;

      if (result.status === 'superseded') {
        return;
      }

      if (result.status !== 'ok') {
        compareDiff.textContent = '';
        compareStatus.textContent = '差异过大，未完成比较。可分别查看两个版本的完整正文。';
        return;
      }

      const renderSeq = compareSeq;
      const hasChanges = window.SourceDiff.renderParts(
        compareDiff,
        result.parts,
        () => renderSeq === compareSeq
      );

      compareStatus.textContent = hasChanges
        ? '红色为 Revision ' + beforeRevision + ' 中的行，绿色为 Revision ' + afterRevision + ' 中的行。'
        : metaChanged
          ? '正文内容没有差异（差异仅在标题、简介或主题字段）。'
          : '两个版本完全相同。';
    } catch (error) {
      if (seq !== compareSeq) return;

      // A Worker failure reaches a truthful unfinished state with both
      // raw sources available — never a permanent loading label.
      compareDiff.textContent = '';
      compareStatus.textContent = '比较失败，未能完成比较。可分别查看两个版本的完整正文。';
    }
  }

  // --- Wiring ---------------------------------------------------------------

  retryBtn.addEventListener('click', loadList);

  prevBtn.addEventListener('click', function () {
    if (listPageIndex <= 0) return;
    listPageIndex -= 1;
    loadList();
  });

  nextBtn.addEventListener('click', function () {
    if (listPageIndex + 1 >= Math.ceil(listTotal / PAGE_LIMIT)) return;
    listPageIndex += 1;
    loadList();
  });

  compareRunBtn.addEventListener('click', runCompare);

  compareClearBtn.addEventListener('click', function () {
    selectedRevisions.length = 0;
    invalidateCompare();
    compareResult.hidden = true;
    refreshCompareButtons();
  });

  sourceCloseBtn.addEventListener('click', function () {
    readSeq += 1;
    sourcePanel.hidden = true;
    sourceBody.textContent = '';
  });

  previewCloseBtn.addEventListener('click', function () {
    previewFrame.removeAttribute('src');
    previewPanel.hidden = true;
  });

  loadList();
})();
