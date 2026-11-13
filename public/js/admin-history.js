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
  // them over the newer target. T09 adds restore: a Revision can be
  // written forward as the new current Revision behind an explicit
  // confirmation that names the source and the current version. T10
  // adds purge: a non-current Revision can be permanently cleared
  // behind a verbatim confirmation (the owner types the target
  // version number); a purged Revision renders as its tombstone —
  // metadata only, no source, preview, compare or restore actions.

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
  const restorePanel = document.getElementById('history-restore');
  const restoreTitle = document.getElementById('history-restore-title');
  const restoreStatus = document.getElementById('history-restore-status');
  const restoreConfirmBtn = document.getElementById('history-restore-confirm');
  const restoreCancelBtn = document.getElementById('history-restore-cancel');
  const purgePanel = document.getElementById('history-purge');
  const purgeTitle = document.getElementById('history-purge-title');
  const purgeStatus = document.getElementById('history-purge-status');
  const purgeTargetEl = document.getElementById('history-purge-target');
  const purgeConfirmInput = document.getElementById('history-purge-confirm-input');
  const purgeConfirmBtn = document.getElementById('history-purge-confirm');
  const purgeCancelBtn = document.getElementById('history-purge-cancel');
  const pageDataElement = document.getElementById('page-data');

  const PAGE_LIMIT = 20;
  const SOURCE_LABELS = {
    'web-create': '网页创建',
    'api-create': 'API 创建',
    'admin-edit': '后台编辑',
    'admin-restore': '历史恢复',
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
  // Mutable: a successful restore (T09) advances the current version and
  // its ETag without a page reload, and the list badge follows.
  let currentRevision = pageData.currentRevision || null;
  let currentEtag = pageData.contentEtag || '';

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

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

      const isCurrent = Boolean(currentRevision && item.revision === currentRevision);
      const isPurged = item.purged === true;

      if (isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'admin-status public';
        badge.textContent = '当前版本';
        heading.appendChild(badge);
      }

      if (isPurged) {
        const badge = document.createElement('span');
        badge.className = 'admin-status protected';
        badge.textContent = '已清除';
        heading.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'admin-history-item-meta';
      meta.textContent = item.createdAtText + ' · 来源：' + sourceLabel(item)
        + (item.restoredFromRevision ? ' · 恢复自 Revision ' + item.restoredFromRevision : '')
        + (isPurged ? ' · 内容已于 ' + (item.purgedAtText || '') + ' 清除' : '');

      main.append(heading, meta);

      const actions = document.createElement('div');
      actions.className = 'admin-history-item-actions';

      // A tombstone offers no content actions at all: its source and
      // preview answer 410, it cannot be restored from, and comparing
      // it would compare nothing. Only its metadata remains.
      if (!isPurged) {
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

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'cyber-btn cyber-btn-secondary';
        restoreBtn.textContent = '恢复';
        restoreBtn.addEventListener('click', function () {
          showRestore(item.revision);
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

        actions.append(previewBtn, sourceBtn, restoreBtn, compareBtn);

        // The current version can never be purged (the server also
        // refuses with 409), so it gets no purge control either.
        if (!isCurrent) {
          const purgeBtn = document.createElement('button');
          purgeBtn.type = 'button';
          purgeBtn.className = 'cyber-btn cyber-btn-secondary';
          purgeBtn.textContent = '清除';
          purgeBtn.addEventListener('click', function () {
            showPurge(item.revision);
          });
          actions.appendChild(purgeBtn);
        }
      }

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

  // --- Restore (T09) ------------------------------------------------------
  //
  // Restoring writes the chosen snapshot forward as a NEW Revision that
  // records its source; the snapshot itself is never rewritten, and only
  // content fields move — password, expiry, access policy, publish
  // state, favorite and view count are untouched. The confirmation names
  // both the source and the current version, and the request carries the
  // current content ETag as its version condition plus an operation
  // identifier: one pending restore intent per (source, expected ETag)
  // pair, kept across a lost response or a page reload through
  // sessionStorage, so confirming again replays the committed result
  // instead of restoring twice. Error statuses are never retried
  // automatically and never adopt a new baseline silently — a 412
  // refreshes the displayed current version and asks the owner to
  // confirm again explicitly.
  const restoreIntentStorageKey = 'quickshare-admin-restore-intent:' + shareId;
  let restoreIntent = null;
  let pendingRestore = null;
  let restoreBusy = false;

  try {
    const storedRestore = window.sessionStorage.getItem(restoreIntentStorageKey);
    if (storedRestore) {
      restoreIntent = JSON.parse(storedRestore);
    }
  } catch (error) {
    restoreIntent = null;
  }

  function persistRestoreIntent() {
    try {
      if (restoreIntent) {
        window.sessionStorage.setItem(restoreIntentStorageKey, JSON.stringify(restoreIntent));
      } else {
        window.sessionStorage.removeItem(restoreIntentStorageKey);
      }
    } catch (error) {
      // Storage unavailable: the in-memory intent still applies.
    }
  }

  function requestIdForRestore(sourceRevision) {
    const intentKey = sourceRevision + '|' + currentEtag;

    if (restoreIntent && restoreIntent.intentKey === intentKey && restoreIntent.requestId) {
      return restoreIntent.requestId;
    }

    restoreIntent = {
      requestId: window.PublishIntent
        ? window.PublishIntent.generateRequestId()
        : 'restore-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      intentKey
    };
    persistRestoreIntent();
    return restoreIntent.requestId;
  }

  function clearRestoreIntent() {
    restoreIntent = null;
    persistRestoreIntent();
  }

  function renderRestorePanel() {
    if (!pendingRestore) {
      restorePanel.hidden = true;
      return;
    }

    restorePanel.hidden = false;
    restoreTitle.textContent = 'Revision ' + pendingRestore.sourceRevision
      + ' → 当前 Revision ' + (currentRevision || '（尚未建立基线）');
    restoreConfirmBtn.disabled = restoreBusy;
  }

  function showRestore(sourceRevision) {
    pendingRestore = { sourceRevision };
    restoreStatus.textContent = sourceRevision === currentRevision
      ? '所选版本就是当前版本：确认后不会产生新版本，恢复结果仍会被记录。'
      : '';
    renderRestorePanel();
    restorePanel.scrollIntoView({ block: 'nearest' });
  }

  function hideRestore() {
    pendingRestore = null;
    renderRestorePanel();
  }

  function publishRevisionChanged() {
    window.dispatchEvent(new CustomEvent('quickshare:revision-changed', {
      detail: { contentRevision: currentRevision, contentEtag: currentEtag }
    }));
  }

  async function confirmRestore() {
    if (!pendingRestore || restoreBusy) return;

    const sourceRevision = pendingRestore.sourceRevision;
    const requestId = requestIdForRestore(sourceRevision);

    restoreBusy = true;
    restoreConfirmBtn.disabled = true;
    restoreStatus.textContent = '正在恢复…';

    try {
      const response = await fetch(apiUrl('/revisions/' + encodeURIComponent(sourceRevision) + '/restore'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken(),
          'If-Match': currentEtag,
          'Idempotency-Key': requestId
        },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);

      if (response.status === 412 && data && data.code === 'content_conflict') {
        // The current version moved: refresh the displayed baseline and
        // let the owner confirm again explicitly. The next confirm is a
        // new intent (the expected ETag changed); nothing auto-retries
        // and no baseline is adopted without this explicit step.
        currentRevision = data.contentRevision || currentRevision;
        currentEtag = data.contentEtag || currentEtag;
        publishRevisionChanged();
        restoreStatus.textContent = '内容已被更新，当前已是 Revision ' + data.contentRevision
          + '，恢复未执行。请确认最新版本后再次点击确认恢复。';
        renderRestorePanel();
        loadList();
        return;
      }

      if (response.status === 409 && data && data.code === 'idempotency_conflict') {
        clearRestoreIntent();
        restoreStatus.textContent = '该恢复操作标识已用于其他请求，操作标识已重置，请确认后重试。';
        return;
      }

      if (response.status === 410) {
        clearRestoreIntent();
        restoreStatus.textContent = data && data.code === 'revision_unavailable'
          ? '该版本内容已被清除，无法恢复。'
          : '该恢复的原结果已不可用（分享可能已被删除）。';
        return;
      }

      if (response.status === 404) {
        restoreStatus.textContent = '该版本不存在，恢复未执行。';
        return;
      }

      if (response.status === 428) {
        restoreStatus.textContent = '缺少版本前置条件，恢复未执行。请取消后重新打开恢复确认。';
        return;
      }

      if (response.status === 503) {
        restoreStatus.textContent = '发布维护中，暂时无法恢复，请稍后再试。';
        return;
      }

      if (!response.ok || !data || !data.success) {
        throw new Error((data && data.error) || '恢复失败');
      }

      clearRestoreIntent();
      currentRevision = data.contentRevision;
      currentEtag = data.contentEtag || currentEtag;
      publishRevisionChanged();
      hideRestore();

      // Refresh the list first, then report: loadList owns the status
      // line while it runs and would wipe a message set before it.
      await loadList();

      statusEl.textContent = data.unchanged
        ? 'Revision ' + data.sourceRevision + ' 与当前内容相同，未产生新版本。'
          + (data.replayed ? '（此前提交已生效）' : '')
        : '已恢复：Revision ' + data.sourceRevision + ' 已写入为新的当前版本 Revision '
          + data.contentRevision + '。'
          + (data.replayed ? '（此前提交已生效）' : '');
    } catch (error) {
      // A network failure leaves the outcome unknown: the intent is
      // kept, so confirming again replays the committed result instead
      // of restoring twice. Nothing is ever retried automatically.
      restoreStatus.textContent = '网络异常，恢复结果未知。可再次点击确认恢复：将使用同一操作标识，服务器会返回已提交的结果，不会重复恢复。';
    } finally {
      restoreBusy = false;
      if (pendingRestore) {
        restoreConfirmBtn.disabled = false;
      }
    }
  }

  // --- Purge (T10) ----------------------------------------------------------
  //
  // Purging permanently clears one non-current Revision's stored
  // payload and leaves a content-free tombstone. The confirmation is
  // verbatim: the owner types the target Revision number, the confirm
  // button stays disabled until the input matches it exactly, and the
  // request repeats it as confirmRevision, which the server checks
  // against the path target again. The panel names the exact Share and
  // version; the copy promises only that the copy of this version
  // stored online here is cleared — identical fragments in other
  // Revisions, offline backups and downloaded copies are out of scope,
  // and the client never claims otherwise. A repeat purge of the same
  // version is a no-op success on the server, so a lost response can
  // simply be confirmed again.
  let pendingPurge = null;
  let purgeBusy = false;

  function renderPurgePanel() {
    if (!pendingPurge) {
      purgePanel.hidden = true;
      return;
    }

    purgePanel.hidden = false;
    purgeTitle.textContent = 'Revision ' + pendingPurge.revision + ' · 分享 ' + shareId;
    purgeTargetEl.textContent = 'Revision ' + pendingPurge.revision;
    purgeConfirmBtn.disabled = purgeBusy
      || purgeConfirmInput.value.trim() !== pendingPurge.revision;
  }

  function showPurge(revision) {
    pendingPurge = { revision };
    purgeStatus.textContent = '';
    purgeConfirmInput.value = '';
    renderPurgePanel();
    purgePanel.scrollIntoView({ block: 'nearest' });
    purgeConfirmInput.focus();
  }

  function hidePurge() {
    pendingPurge = null;
    purgeConfirmInput.value = '';
    renderPurgePanel();
  }

  async function confirmPurge() {
    if (!pendingPurge || purgeBusy) return;

    const revision = pendingPurge.revision;

    if (purgeConfirmInput.value.trim() !== revision) {
      purgeStatus.textContent = '输入的版本号与要清除的版本不一致，清除未执行。';
      return;
    }

    purgeBusy = true;
    purgeConfirmBtn.disabled = true;
    purgeStatus.textContent = '正在清除…';

    try {
      const response = await fetch(apiUrl('/revisions/' + encodeURIComponent(revision) + '/purge'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ confirmRevision: revision })
      });
      const data = await response.json().catch(() => null);

      if (response.status === 409) {
        purgeStatus.textContent = '不能清除当前版本，清除未执行。';
        return;
      }

      if (response.status === 404) {
        purgeStatus.textContent = '该版本不存在，清除未执行。';
        return;
      }

      if (response.status === 400) {
        purgeStatus.textContent = '清除确认不匹配，清除未执行。请重新输入版本号确认。';
        return;
      }

      if (response.status === 503) {
        purgeStatus.textContent = '发布维护中，暂时无法清除，请稍后再试。';
        return;
      }

      if (!response.ok || !data || !data.success) {
        throw new Error((data && data.error) || '清除失败');
      }

      hidePurge();

      // A comparison selecting the purged version can no longer run.
      const selectionIndex = selectedRevisions.indexOf(revision);

      if (selectionIndex >= 0) {
        selectedRevisions.splice(selectionIndex, 1);
        invalidateCompare();
        compareResult.hidden = true;
      }

      // Refresh the list first, then report: loadList owns the status
      // line while it runs and would wipe a message set before it.
      await loadList();

      statusEl.textContent = data.alreadyPurged
        ? 'Revision ' + revision + ' 的内容此前已被清除，仅保留墓碑记录。'
        : 'Revision ' + revision + ' 保存在线上的内容已永久清除，仅保留墓碑记录。';
    } catch (error) {
      // A network failure leaves the outcome unknown: purge is
      // idempotent on the server, so confirming again is safe and
      // reports the already-purged state instead of failing.
      purgeStatus.textContent = '网络异常，清除结果未知。可再次点击确认清除：重复清除不会产生额外影响。';
    } finally {
      purgeBusy = false;
      if (pendingPurge) {
        renderPurgePanel();
      }
    }
  }

  // --- Wiring ---------------------------------------------------------------

  retryBtn.addEventListener('click', loadList);

  restoreConfirmBtn.addEventListener('click', confirmRestore);

  restoreCancelBtn.addEventListener('click', hideRestore);

  purgeConfirmBtn.addEventListener('click', confirmPurge);

  purgeCancelBtn.addEventListener('click', hidePurge);

  purgeConfirmInput.addEventListener('input', renderPurgePanel);

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
