const config = require('../config');
const express = require('express');
const path = require('path');
const { PUBLISH_SESSION_TTL_MS } = require('../middleware/auth');
const {
  respondIfPublishingGate,
  respondOperationUnavailable,
  sendPublishingMaintenance,
  setPrivateNoStore
} = require('../middleware/responsePolicy');
const {
  formatContentEtag,
  isSnapshotPurged,
  parseContentIfMatch,
  toContentRevisionString
} = require('../utils/contentRevision');
const {
  computeRequestHmac,
  dashboardNamespace,
  isIdempotencyConflictError,
  namespaceKind,
  parseIdempotencyKey
} = require('../utils/idempotency');
const { formatManagementDateTime } = require('../utils/management-time');
const { formatShareListTime, groupSharesForList, shareTypeAbbreviation } = require('../utils/shareListGroups');
const { getMarkdownThemeOptions, resolveMarkdownThemeId } = require('../utils/markdownThemeCatalog');
const { prepareSandboxContent, renderSandboxedDocument } = require('../utils/sandboxDocument');
const {
  CUSTOM_PASSWORD_ERROR,
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  decryptSecret,
  encryptSecret,
  generateNumericPassword,
  hashSecret,
  parseCustomPassword
} = require('../utils/security');
const { parseExpectedAccessRevision, toAccessRevisionString } = require('../utils/shareAccess');

function createAdminRouter({ config, pageRepository, auth, publicUrls, shareOps, parsers }) {
  const router = express.Router();
  const {
    dashboardSessionToken,
    requireDashboardAdmin,
    requireDashboardApiAdmin,
    requireDashboardCsrf
  } = auth;
  const {
    publicPageUrl,
    socialImageUrl
  } = publicUrls;
  const {
    checkAccessPrecondition,
    contentPreconditionState,
    operationReceipt
  } = shareOps;
  const {
    parseShareJson,
    parseSmallForm,
    parseSmallJson,
    parseSmallJsonBody
  } = parsers;

  function parsePagination(query) {
    const page = Number.parseInt(query.page || '1', 10);
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const limit = 50;

    return {
      page: safePage,
      limit,
      offset: (safePage - 1) * limit
    };
  }

  function buildAdminPagesUrl(filters, overrides = {}) {
    const values = { ...filters, ...overrides };
    const params = new URLSearchParams();
    const keys = ['search', 'type', 'status', 'favorite', 'sort', 'order', 'dateFrom', 'dateTo', 'page'];

    keys.forEach((key) => {
      const value = values[key];

      if (value === undefined || value === null || value === '') return;
      if (key === 'favorite' && value !== 'true') return;
      if (key === 'page' && Number(value) <= 1) return;
      params.set(key, String(value));
    });

    const query = params.toString();
    return query ? `/admin/pages?${query}` : '/admin/pages';
  }

  function enrichAdminStats(stats) {
    const maxDailyCount = Math.max(1, ...stats.recentDays.map((day) => day.count));
    const total = Math.max(1, stats.total);

    return {
      ...stats,
      protectedPercent: Math.round((stats.protected / total) * 100),
      publicPercent: Math.round((stats.public / total) * 100),
      byType: stats.byType.map((item) => ({
        ...item,
        percent: Math.round((item.count / total) * 100)
      })),
      recentDays: stats.recentDays.map((day) => ({
        ...day,
        percent: Math.round((day.count / maxDailyCount) * 100)
      }))
    };
  }

  function visiblePagePassword(page) {
    if (page.is_protected !== 1) {
      return null;
    }

    return decryptSecret(page.encrypted_password);
  }

  function serializeJsonForHtml(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  router.get('/admin/pages/export', requireDashboardAdmin, async (req, res) => {
    try {
      const pages = await pageRepository.listAdminPages({ limit: null });
      const exportData = pages.map((page) => ({
        id: page.id,
        title: page.title,
        description: page.description,
        codeType: page.code_type,
        isProtected: page.is_protected === 1,
        isFavorite: page.is_favorite === true,
        createdAt: page.created_at,
        expiresAt: page.expires_at || null
      }));

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="quickshare-export.json"');
      return res.json({
        kind: 'manifest',
        includesContent: false,
        restorable: false,
        notice: '清单导出仅包含分享元信息，不包含正文、密码材料、站点设置或审计记录，不能独立用于恢复。完整备份请使用数据库备份脚本（见 docs/backup-restore.md）。',
        exportedAt: Date.now(),
        total: exportData.length,
        pages: exportData
      });
    } catch (error) {
      console.error('Export failed:', error);
      return res.status(500).json({ success: false, error: 'Failed to export pages' });
    }
  });

  router.get('/admin/pages', requireDashboardAdmin, async (req, res) => {
    try {
      const requestedPagination = parsePagination(req.query);
      const favorite = req.query.favorite === 'true' ? 'true' : '';
      const filterOptions = {
        search: req.query.search || '',
        codeType: req.query.type || '',
        isProtected: req.query.status || '',
        dateFrom: req.query.dateFrom || '',
        dateTo: req.query.dateTo || '',
        isFavorite: favorite === 'true'
      };
      const sortBy = req.query.sort || 'created_at';
      const sortOrder = req.query.order === 'asc' ? 'asc' : 'desc';
      const total = await pageRepository.countPages(filterOptions);
      const totalPages = Math.max(1, Math.ceil(total / requestedPagination.limit));
      const currentPage = Math.min(requestedPagination.page, totalPages);
      const pagination = {
        page: currentPage,
        limit: requestedPagination.limit,
        offset: (currentPage - 1) * requestedPagination.limit
      };
      const pages = await pageRepository.listAdminPages({
        ...filterOptions,
        limit: pagination.limit,
        offset: pagination.offset,
        sortBy,
        sortOrder
      });
      const visiblePages = pages.map((sharedPage) => ({
        ...sharedPage,
        visiblePassword: visiblePagePassword(sharedPage)
      }));
      const filters = {
        search: filterOptions.search,
        type: filterOptions.codeType,
        status: filterOptions.isProtected,
        favorite,
        sort: sortBy,
        order: sortOrder,
        dateFrom: filterOptions.dateFrom,
        dateTo: filterOptions.dateTo
      };
      const hasActiveFilters = Boolean(
        filters.search || filters.type || filters.status || filters.favorite || filters.dateFrom || filters.dateTo
      );
      const hasAnyPages = total > 0 || (hasActiveFilters && await pageRepository.countPages() > 0);
      const sessionToken = dashboardSessionToken(req);

      return res.render('admin-pages', {
        title: 'QuickShare | 分享管理',
        page: 'admin-pages',
        csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : '',
        pages: visiblePages,
        groups: groupSharesForList(visiblePages, sortBy),
        formatShareListTime,
        shareTypeAbbreviation,
        pagination: {
          ...pagination,
          total,
          totalPages,
          hasPrevious: pagination.page > 1,
          hasNext: pagination.page < totalPages
        },
        filters,
        hasAnyPages,
        adminPagesUrl: (overrides) => buildAdminPagesUrl(filters, overrides),
        favoriteRefreshUrl: buildAdminPagesUrl(filters, { page: pagination.page }),
        publicPageUrl: (id) => publicPageUrl(req, id)
      });
    } catch (error) {
      console.error('Admin list pages failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to load admin pages'
      });
    }
  });

  router.put('/admin/settings/homepage-access', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    if (typeof req.body?.passwordRequired !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'passwordRequired must be a boolean'
      });
    }

    try {
      const result = await pageRepository.setHomepagePasswordRequired({
        passwordRequired: req.body.passwordRequired,
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return res.json({
        success: true,
        passwordRequired: result.passwordRequired,
        changed: result.changed
      });
    } catch (error) {
      console.error('Update homepage access setting failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(503).json({
        success: false,
        error: 'Homepage access setting is unavailable'
      });
    }
  });

  router.get('/admin/stats', requireDashboardAdmin, async (req, res) => {
    try {
      const [statsResult, settingsResult] = await Promise.allSettled([
        pageRepository.getAdminStats(),
        pageRepository.getHomepagePasswordRequired()
      ]);
      const homepagePasswordRequired = settingsResult.value;

      if (settingsResult.status === 'rejected' || typeof homepagePasswordRequired !== 'boolean') {
        console.error('Admin homepage access setting failed:', settingsResult.reason || new Error('Invalid setting value'));
        return res.status(503).render('error', {
          title: 'Service Unavailable',
          page: 'error-page',
          message: '首页访问设置暂时不可用，请稍后重试'
        });
      }

      if (statsResult.status === 'rejected') {
        throw statsResult.reason;
      }

      const statsData = statsResult.value;
      const stats = enrichAdminStats(statsData);
      const sessionToken = dashboardSessionToken(req);

      return res.render('admin-stats', {
        title: 'QuickShare | 数据统计',
        page: 'admin-stats',
        stats,
        homepagePasswordRequired,
        csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : ''
      });
    } catch (error) {
      console.error('Admin stats failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to load admin stats'
      });
    }
  });

  router.get('/admin/audit', requireDashboardAdmin, async (req, res) => {
    try {
      const limit = 50;
      const currentPage = Math.max(1, parseInt(req.query.page, 10) || 1);
      const offset = (currentPage - 1) * limit;
      const total = await pageRepository.countAuditLogs();
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const logs = await pageRepository.listAuditLogs({ limit, offset });

      return res.render('admin-audit', {
        title: 'QuickShare | 审计日志',
        page: 'admin-audit',
        logs,
        pagination: {
          page: currentPage,
          limit,
          total,
          totalPages,
          hasPrevious: currentPage > 1,
          hasNext: currentPage < totalPages
        }
      });
    } catch (error) {
      console.error('Admin audit failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to load audit log'
      });
    }
  });

  router.get('/admin/pages/:id', requireDashboardAdmin, async (req, res) => {
    try {
      const sharedPage = await pageRepository.getById(req.params.id);

      if (!sharedPage) {
        return res.status(404).render('error', {
          title: 'Page Not Found',
          page: 'error-page',
          message: 'The requested shared page does not exist'
        });
      }

      const pageData = {
        id: sharedPage.id,
        htmlContent: sharedPage.html_content,
        createdAt: sharedPage.created_at,
        codeType: sharedPage.code_type,
        title: sharedPage.title,
        description: sharedPage.description,
        isProtected: sharedPage.is_protected === 1,
        isFavorite: sharedPage.is_favorite === true,
        password: visiblePagePassword(sharedPage),
        accessRevision: toAccessRevisionString(sharedPage.access_revision),
        // Content Revision state (T06): the admin editor displays the
        // current Revision and saves content against its strong ETag. A
        // null revision means the Share predates the baseline backfill.
        currentRevision: toContentRevisionString(sharedPage.current_revision),
        contentEtag: formatContentEtag(sharedPage.id, sharedPage.current_revision),
        published: sharedPage.published !== false,
        expiresAt: sharedPage.expires_at,
        markdownTheme: sharedPage.code_type === 'markdown'
          ? resolveMarkdownThemeId(sharedPage.markdown_theme)
          : null
      };
      const sessionToken = dashboardSessionToken(req);

      return res.render('admin-page-detail', {
        title: `QuickShare | ${sharedPage.id}`,
        page: 'admin-page-detail',
        csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : '',
        sharedPage: pageData,
        pageDataJson: serializeJsonForHtml(pageData),
        publicUrl: publicPageUrl(req, sharedPage.id),
        markdownThemeOptions: getMarkdownThemeOptions()
      });
    } catch (error) {
      console.error('Admin page detail failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to load shared page details'
      });
    }
  });

  // --- Share history browsing (T07, issue #31) ---------------------------
  //
  // Read-only, owner-only history surfaces for the admin detail page. All
  // three endpoints require the dashboard admin identity: a Share being
  // public, an unlock Cookie, or an API Key never grants history access.
  // The /admin prefix already carries private/no-store, and history bodies
  // never enter a shared cache. Listing returns metadata only (no content
  // aggregation); a single Revision returns its complete raw snapshot to
  // the owner; the preview renders that snapshot through the same
  // renderer + sandbox pipeline as the public view, without embedding any
  // admin credential in the framed document. (Restore arrives with T09
  // below; purge with T10.)

  function historyRevisionMetaJson(record) {
    return {
      revision: toContentRevisionString(record.revision),
      createdAt: Number(record.created_at),
      createdAtText: formatManagementDateTime(record.created_at),
      source: record.source,
      actorType: record.actor_type,
      restoredFromRevision: record.restored_from_revision == null
        ? null
        : toContentRevisionString(record.restored_from_revision),
      // A purged Revision (T10) keeps its tombstone metadata — version,
      // capture time, provenance, purge time — and nothing else. Meta
      // records carry no html_content key at all, so the payload check
      // compares against null exactly (an absent key is undefined).
      purged: record.purged_at != null || record.html_content === null,
      purgedAt: record.purged_at == null ? null : Number(record.purged_at),
      purgedAtText: record.purged_at == null
        ? null
        : formatManagementDateTime(record.purged_at)
    };
  }

  router.get('/admin/pages/:id/revisions', requireDashboardApiAdmin, async (req, res) => {
    try {
      const sharedPage = await pageRepository.getById(req.params.id);

      if (!sharedPage) {
        return res.status(404).json({ success: false, error: 'Share not found' });
      }

      const parsedLimit = Number.parseInt(req.query.limit, 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(100, Math.max(1, parsedLimit))
        : 20;
      const parsedOffset = Number.parseInt(req.query.offset, 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

      const { total, revisions } = await pageRepository.listContentRevisionMeta(
        req.params.id,
        { limit, offset }
      );

      return res.json({
        success: true,
        total,
        limit,
        offset,
        revisions: revisions.map(historyRevisionMetaJson)
      });
    } catch (error) {
      console.error('Admin revision list failed:', error);
      return res.status(500).json({ success: false, error: 'Unable to load revision history' });
    }
  });

  router.get('/admin/pages/:id/revisions/:revision', requireDashboardApiAdmin, async (req, res) => {
    try {
      const revision = toContentRevisionString(req.params.revision);

      if (revision === null) {
        return res.status(404).json({ success: false, error: 'Revision not found' });
      }

      const snapshot = await pageRepository.getContentSnapshot(req.params.id, revision);

      if (!snapshot) {
        return res.status(404).json({ success: false, error: 'Revision not found' });
      }

      // A purged Revision (T10) is a tombstone: its metadata stays
      // listed, but its content is gone for good — 410, never an empty
      // or fabricated snapshot.
      if (isSnapshotPurged(snapshot)) {
        return res.status(410).json({
          success: false,
          error: '该版本内容已被清除',
          code: 'revision_unavailable',
          retryable: false,
          revision: historyRevisionMetaJson(snapshot)
        });
      }

      return res.json({
        success: true,
        revision: {
          ...historyRevisionMetaJson(snapshot),
          codeType: snapshot.code_type,
          title: snapshot.title,
          description: snapshot.description,
          markdownTheme: snapshot.markdown_theme,
          htmlContent: snapshot.html_content,
          contentEtag: formatContentEtag(req.params.id, snapshot.revision)
        }
      });
    } catch (error) {
      console.error('Admin revision read failed:', error);
      return res.status(500).json({ success: false, error: 'Unable to load revision' });
    }
  });

  router.get('/admin/pages/:id/revisions/:revision/preview', requireDashboardAdmin, async (req, res) => {
    try {
      const revision = toContentRevisionString(req.params.revision);
      const snapshot = revision === null
        ? null
        : await pageRepository.getContentSnapshot(req.params.id, revision);

      if (!snapshot) {
        return res.status(404).render('error', {
          title: 'Page Not Found',
          page: 'error-page',
          message: 'The requested revision does not exist'
        });
      }

      if (isSnapshotPurged(snapshot)) {
        return res.status(410).render('error', {
          title: 'Content Purged',
          page: 'error-page',
          message: '该版本内容已被永久清除，无法预览'
        });
      }

      const prepared = await prepareSandboxContent(
        snapshot.html_content,
        snapshot.code_type,
        snapshot.markdown_theme
      );

      setPrivateNoStore(res);
      return res.send(renderSandboxedDocument(prepared.renderedContent, prepared.contentType, {
        title: snapshot.title,
        description: snapshot.description,
        pageUrl: null,
        socialImageUrl: socialImageUrl(req),
        viewEventUrl: null
      }));
    } catch (error) {
      console.error('Admin revision preview failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to preview this revision'
      });
    }
  });

  // History restore (T09, issue #33): the chosen snapshot becomes the
  // current content as a NEW Revision that records its restore source;
  // restoring a snapshot identical to the current one is a successful
  // no-op (unchanged, no new Revision). The restore carries the current
  // content If-Match as its version condition and — with an
  // Idempotency-Key header or requestId field — an operation identifier,
  // under the same protocol as the idempotent save: the committed
  // operation is resolved before the (by then stale) If-Match is judged,
  // so a lost response can be confirmed and safely retried. Only content
  // fields move; the restore never touches the URL, password, expiry,
  // access_revision, Key authorization, publish state, favorite or view
  // count.
  router.post('/admin/pages/:id/revisions/:revision/restore', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    try {
      const idem = parseIdempotencyKey(req.get('idempotency-key') || req.body?.requestId);

      if (idem.provided && !idem.valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Idempotency-Key',
          code: 'invalid_idempotency_key',
          retryable: false
        });
      }

      const sourceRevision = toContentRevisionString(req.params.revision);

      if (sourceRevision === null) {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      const page = await pageRepository.getById(req.params.id);

      // Write maintenance outranks precondition validation (T04): while
      // paused, even a replay is refused at the gate, and the operation
      // stays confirmable through the operations query instead.
      if (page
        && typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      const contentState = contentPreconditionState(req, req.params.id);
      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      const outcome = await pageRepository.restoreRevision({
        id: req.params.id,
        sourceRevision,
        precondition: {
          expectedContentRevision: contentState.expectedContentRevision,
          contentPreconditionMissing: contentState.contentPreconditionMissing,
          contentPreconditionInvalid: contentState.contentPreconditionInvalid,
          ip
        },
        operation: idem.valid
          ? {
            actorNamespace: dashboardNamespace(),
            requestId: idem.value,
            action: 'share.restore',
            targetId: req.params.id,
            requestHmac: computeRequestHmac({
              action: 'share.restore',
              targetId: req.params.id,
              presence: {
                sourceRevision: 1,
                expectedContentRevision: contentState.digestValue !== null ? 1 : 0
              },
              values: {
                sourceRevision,
                expectedContentRevision: contentState.digestValue
              }
            })
          }
          : null
      });

      if (outcome.outcome === 'unavailable') {
        return respondOperationUnavailable(res, idem.valid ? idem.value : null);
      }

      if (outcome.outcome === 'replayed') {
        const receipt = operationReceipt(outcome.operation);

        if (!outcome.shareState || !receipt || receipt.kind !== 'share.restore') {
          return respondOperationUnavailable(res, idem.valid ? idem.value : null);
        }

        return res.json({
          success: true,
          replayed: true,
          requestId: idem.valid ? idem.value : null,
          action: 'share.restore',
          shareId: req.params.id,
          sourceRevision: receipt.sourceRevision,
          previousRevision: receipt.previousRevision,
          contentRevision: receipt.contentRevision,
          contentEtag: formatContentEtag(req.params.id, receipt.contentRevision),
          contentChanged: receipt.contentChanged === true,
          unchanged: receipt.contentChanged !== true
        });
      }

      const result = outcome.result;

      if (result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      if (result.status === 'source_not_found') {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      if (result.status === 'source_unavailable') {
        return res.status(410).json({
          success: false,
          error: '该版本内容已被清除，无法恢复',
          code: 'revision_unavailable',
          retryable: false
        });
      }

      if (result.status === 'precondition_required') {
        return res.status(428).json({
          success: false,
          error: '缺少内容版本前置条件 If-Match，请刷新后重试',
          code: 'content_precondition_required',
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(req.params.id, result.contentRevision)
        });
      }

      if (result.status === 'content_conflict') {
        return res.status(412).json({
          success: false,
          error: '内容已被更新，恢复未执行，请确认最新版本后重试',
          code: 'content_conflict',
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(req.params.id, result.contentRevision),
          current: result.current
        });
      }

      return res.json({
        success: true,
        ...(idem.valid ? { requestId: idem.value } : {}),
        shareId: req.params.id,
        sourceRevision: result.sourceRevision,
        previousRevision: result.previousRevision,
        contentRevision: result.contentRevision,
        contentEtag: formatContentEtag(req.params.id, result.contentRevision),
        contentChanged: result.contentChanged === true,
        unchanged: result.contentChanged !== true
      });
    } catch (error) {
      console.error('Restore revision failed:', error);
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId: parseIdempotencyKey(req.get('idempotency-key') || req.body?.requestId).value,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to restore revision'
      });
    }
  });

  // Unpublish / republish a Share (T11, issue #35). Dashboard session +
  // CSRF only — deliberately no API-Key entry, mirroring the purge: this
  // is an owner console action. The request carries the T01 access-version
  // precondition (expectedAccessRevision: missing 428, stale 412, judged
  // inside the repository transaction against the locked row) and may
  // carry the T08/T09 request identifier (Idempotency-Key header or body
  // requestId); a keyed transition commits its operation record and audit
  // atomically with the state change, so a lost response is confirmable
  // through GET /admin/operations/:requestId and a retry with the same
  // identifier replays the recorded result instead of re-judging the (now
  // stale) precondition. A real transition advances access_revision — old
  // unlock cookies die on unpublish AND on republish — while password,
  // expiry and content version are never written. Setting the state the
  // Share already has is a recorded success that changes nothing.
  router.post('/admin/pages/:id/publish-state', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    try {
      const idem = parseIdempotencyKey(req.get('idempotency-key') || req.body?.requestId);

      if (idem.provided && !idem.valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Idempotency-Key',
          code: 'invalid_idempotency_key',
          retryable: false
        });
      }

      if (typeof req.body?.published !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'published must be a boolean',
          code: 'invalid_published_state',
          retryable: false
        });
      }

      const expected = parseExpectedAccessRevision(req.body?.expectedAccessRevision);

      if (expected.provided && !expected.valid) {
        return res.status(400).json({
          success: false,
          error: 'expectedAccessRevision 必须为十进制字符串'
        });
      }

      const targetPublished = req.body.published;
      const action = targetPublished ? 'share.republish' : 'share.unpublish';
      const page = await pageRepository.getById(req.params.id);

      // Write maintenance outranks precondition validation (T04): while
      // paused, even a replay is refused at the gate, and the operation
      // stays confirmable through the operations query instead.
      if (page
        && typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      const outcome = await pageRepository.setPublishedState({
        id: req.params.id,
        published: targetPublished,
        precondition: {
          expectedAccessRevision: expected.valid ? expected.value : null,
          accessPreconditionMissing: !expected.provided
        },
        operation: idem.valid
          ? {
            actorNamespace: dashboardNamespace(),
            requestId: idem.value,
            action,
            targetId: req.params.id,
            requestHmac: computeRequestHmac({
              action,
              targetId: req.params.id,
              presence: {
                published: 1,
                expectedAccessRevision: expected.provided ? 1 : 0
              },
              values: {
                published: targetPublished ? 'true' : 'false',
                expectedAccessRevision: expected.provided ? expected.value : null
              }
            })
          }
          : null,
        ip
      });

      if (outcome.outcome === 'unavailable') {
        return respondOperationUnavailable(res, idem.valid ? idem.value : null);
      }

      if (outcome.outcome === 'replayed') {
        const receipt = operationReceipt(outcome.operation);

        if (!outcome.shareState || !receipt || receipt.kind !== action) {
          return respondOperationUnavailable(res, idem.valid ? idem.value : null);
        }

        return res.json({
          success: true,
          replayed: true,
          requestId: idem.valid ? idem.value : null,
          action,
          shareId: req.params.id,
          published: receipt.published === true,
          changed: receipt.changed === true,
          unchanged: receipt.changed !== true,
          accessRevision: receipt.accessRevision
        });
      }

      const result = outcome.result;

      if (result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      if (result.status === 'access_precondition_required') {
        return res.status(428).json({
          success: false,
          error: '缺少 expectedAccessRevision，请刷新后重试'
        });
      }

      if (result.status === 'conflict') {
        return res.status(412).json({
          success: false,
          error: '访问策略已被更新，请刷新后重试',
          accessRevision: result.accessRevision
        });
      }

      return res.json({
        success: true,
        ...(idem.valid ? { requestId: idem.value } : {}),
        action,
        shareId: req.params.id,
        published: result.published === true,
        changed: result.changed === true,
        unchanged: result.changed !== true,
        accessRevision: result.accessRevision
      });
    } catch (error) {
      console.error('Publish state update failed:', error);
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId: parseIdempotencyKey(req.get('idempotency-key') || req.body?.requestId).value,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update publish state'
      });
    }
  });

  // Permanent purge of one non-current Revision (T10, issue #34). This
  // is the one explicitly destructive exception to snapshot immutability
  // and it is deliberately narrow: dashboard session + CSRF only (no
  // API-Key endpoint, no CLI), and the request must confirm its target
  // verbatim — the body's confirmRevision must equal the path Revision —
  // so a stale page or a stray request cannot clear the wrong version.
  // The current Revision can never be purged (409). The repository
  // re-verifies non-current under the Share row lock, clears the payload
  // and the sensitive receipts of that version in the same transaction,
  // and leaves a content-free tombstone; repeating the purge is a no-op
  // success. The success copy promises only what is true: the copy of
  // that version stored online here is gone — identical fragments in
  // other Revisions, offline backups and copies a recipient already
  // downloaded are NOT covered.
  router.post('/admin/pages/:id/revisions/:revision/purge', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    try {
      const targetRevision = toContentRevisionString(req.params.revision);

      if (targetRevision === null) {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      const confirmRevision = typeof req.body?.confirmRevision === 'string'
        ? req.body.confirmRevision.trim()
        : '';

      if (confirmRevision !== targetRevision) {
        return res.status(400).json({
          success: false,
          error: '清除确认不匹配：请准确确认要清除的分享与版本',
          code: 'purge_confirmation_required',
          retryable: false
        });
      }

      const page = await pageRepository.getById(req.params.id);

      // Write maintenance outranks the purge like every other write
      // (T04): while paused the purge is refused at the gate.
      if (page
        && typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const result = await pageRepository.purgeRevision({
        id: req.params.id,
        revision: targetRevision,
        ip
      });

      if (result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      if (result.status === 'revision_not_found') {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      if (result.status === 'current_revision') {
        return res.status(409).json({
          success: false,
          error: '不能清除当前版本',
          code: 'revision_is_current',
          contentRevision: result.currentRevision,
          retryable: false
        });
      }

      if (result.status === 'already_purged') {
        return res.json({
          success: true,
          alreadyPurged: true,
          shareId: req.params.id,
          revision: result.revision,
          purgedAt: result.purgedAt
        });
      }

      return res.json({
        success: true,
        shareId: req.params.id,
        revision: result.revision,
        purgedAt: result.purgedAt
      });
    } catch (error) {
      console.error('Purge revision failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to purge revision'
      });
    }
  });

  router.put('/admin/pages/:id/favorite', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    if (typeof req.body?.isFavorite !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isFavorite must be a boolean'
      });
    }

    try {
      const result = await pageRepository.setFavorite(req.params.id, req.body.isFavorite);

      if (!result.found) {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      if (result.changed) {
        try {
          await pageRepository.createAuditLog({
            action: 'page.favorite.update',
            pageId: req.params.id,
            details: JSON.stringify({ from: result.previousValue, to: result.isFavorite }),
            ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
          });
        } catch (error) {
          console.error('Favorite audit log failed:');
        }
      }

      return res.json({
        success: true,
        changed: result.changed,
        isFavorite: result.isFavorite
      });
    } catch (error) {
      console.error('Update favorite failed:');
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update favorite'
      });
    }
  });

  router.post('/admin/pages/:id/revoke-access', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
    try {
      const page = await pageRepository.getById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      // Active revocation is an access-policy write: it advances the access
      // revision (invalidating every issued access cookie) without changing
      // the password, expiry, or content (T01).
      const expectedAccessRevision = checkAccessPrecondition(req, res, page);

      if (expectedAccessRevision === null) {
        return;
      }

      const result = await pageRepository.revokeAccess(req.params.id, expectedAccessRevision);

      if (result.status === 'conflict') {
        return res.status(412).json({
          success: false,
          error: '访问策略已被更新，请刷新后重试',
          accessRevision: result.accessRevision
        });
      }

      if (result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      pageRepository.createAuditLog({
        action: 'page.access.revoke',
        pageId: req.params.id,
        details: JSON.stringify({ accessRevision: result.accessRevision }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        accessRevision: result.accessRevision
      });
    } catch (error) {
      console.error('Revoke page access failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to revoke access'
      });
    }
  });

  // Idempotent variant of the admin save (T09, issue #33). Mirrors the
  // legacy PUT below field for field, but the write runs through
  // pageRepository.saveContentIdempotent in the dashboard namespace:
  // static validation (password format, expected-revision format) happens
  // first; the repository then resolves a committed operation BEFORE
  // judging any precondition, so a successful retry is never misreported
  // as a stale-If-Match failure and never mints a second Revision; only a
  // first execution derives values, compares versions and writes. A first
  // execution answers with the legacy payload plus the requestId; a
  // replay answers from the stored receipt (identifiers and versions
  // only — receipts never carry content).
  async function handleIdempotentAdminSave(req, res, requestId) {
    const id = req.params.id;
    const {
      title, description, htmlContent, expiresAt, isProtected, password, markdownTheme
    } = req.body || {};
    const customPassword = parseCustomPassword(password);

    if (customPassword.error) {
      return res.status(400).json({
        success: false,
        error: CUSTOM_PASSWORD_ERROR
      });
    }

    const page = await pageRepository.getById(id);

    const touchesContent = title !== undefined
      || description !== undefined
      || htmlContent !== undefined
      || (markdownTheme !== undefined && (!page || page.code_type === 'markdown'));
    const touchesAccessPolicy = isProtected !== undefined
      || customPassword.provided
      || expiresAt !== undefined;
    const touchesWriteFamily = touchesContent || touchesAccessPolicy;

    // Write maintenance outranks precondition validation (T04), exactly
    // as on the legacy route: while paused, even a replay is refused at
    // the gate, and the operation stays confirmable through the
    // operations query instead.
    if (page && touchesWriteFamily
      && typeof pageRepository.getPublishingWritesPaused === 'function'
      && await pageRepository.getPublishingWritesPaused()) {
      return sendPublishingMaintenance(res);
    }

    const contentState = touchesContent
      ? contentPreconditionState(req, id)
      : {
        expectedContentRevision: null,
        contentPreconditionMissing: false,
        contentPreconditionInvalid: false,
        digestValue: null
      };

    let expectedAccessRevision = null;
    let accessPreconditionMissing = false;

    if (touchesAccessPolicy) {
      const expected = parseExpectedAccessRevision(req.body?.expectedAccessRevision);

      if (expected.provided && !expected.valid) {
        return res.status(400).json({
          success: false,
          error: 'expectedAccessRevision 必须为十进制字符串'
        });
      }

      if (!expected.provided) {
        accessPreconditionMissing = true;
      } else {
        expectedAccessRevision = expected.value;
      }
    }

    const parsedExpiresAt = expiresAt === undefined
      ? undefined
      : (() => {
        const parsed = Number.parseInt(expiresAt, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      })();

    const updateOptions = {};

    if (page) {
      if (title !== undefined) {
        updateOptions.title = title ? String(title).trim() || null : null;
      }
      if (description !== undefined) {
        updateOptions.description = description ? String(description).trim() || null : null;
      }
      if (htmlContent !== undefined) {
        updateOptions.htmlContent = htmlContent;
      }
      if (expiresAt !== undefined) {
        updateOptions.expiresAt = parsedExpiresAt;
      }
      if (markdownTheme !== undefined && page.code_type === 'markdown') {
        updateOptions.markdownTheme = resolveMarkdownThemeId(markdownTheme);
      }

      if (isProtected !== undefined) {
        const newProtected = Boolean(isProtected);
        const currentlyProtected = page.is_protected === 1;

        if (newProtected !== currentlyProtected) {
          updateOptions.isProtected = newProtected;

          if (newProtected) {
            const finalPassword = customPassword.provided
              ? customPassword.value
              : generateNumericPassword(DEFAULT_PASSWORD_LENGTH);
            updateOptions.passwordHash = await hashSecret(finalPassword);
            updateOptions.encryptedPassword = encryptSecret(finalPassword);
          } else {
            updateOptions.passwordHash = null;
            updateOptions.encryptedPassword = null;
          }
        } else if (newProtected && customPassword.provided) {
          updateOptions.isProtected = true;
          updateOptions.passwordHash = await hashSecret(customPassword.value);
          updateOptions.encryptedPassword = encryptSecret(customPassword.value);
        }
      }
    }

    const expiryChanged = Boolean(page) && expiresAt !== undefined
      && updateOptions.expiresAt !== (page.expires_at ?? null);
    const accessPolicyChanged = updateOptions.isProtected !== undefined || expiryChanged;

    // The digest binds the identifier to this exact request (parent spec
    // §8): action, target, both expected versions, field presence and the
    // normalized input values. It is computed from the request alone —
    // before any derived value (password hash, generated password) exists
    // — so a byte-identical retry digests identically in any state.
    const present = (value) => value !== undefined && value !== null;
    const requestHmac = computeRequestHmac({
      action: 'share.content.update',
      targetId: id,
      presence: {
        title: present(title) ? 1 : 0,
        description: present(description) ? 1 : 0,
        htmlContent: present(htmlContent) ? 1 : 0,
        markdownTheme: present(markdownTheme) ? 1 : 0,
        isProtected: present(isProtected) ? 1 : 0,
        password: customPassword.provided ? 1 : 0,
        expiresAt: present(expiresAt) ? 1 : 0,
        expectedContentRevision: contentState.digestValue !== null ? 1 : 0,
        expectedAccessRevision: expectedAccessRevision !== null ? 1 : 0
      },
      values: {
        title: present(title) ? (title ? String(title).trim() || null : null) : null,
        description: present(description)
          ? (description ? String(description).trim() || null : null)
          : null,
        htmlContent: present(htmlContent) ? htmlContent : null,
        markdownTheme: present(markdownTheme)
          ? (page && page.code_type === 'markdown'
            ? resolveMarkdownThemeId(markdownTheme)
            : markdownTheme)
          : null,
        isProtected: present(isProtected) ? Boolean(isProtected) : null,
        password: customPassword.provided ? customPassword.value : null,
        expiresAt: present(expiresAt) ? parsedExpiresAt : null,
        expectedContentRevision: contentState.digestValue,
        expectedAccessRevision
      }
    });

    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    let outcome;

    try {
      outcome = await pageRepository.saveContentIdempotent({
        id,
        options: updateOptions,
        precondition: {
          expectedAccessRevision,
          accessPreconditionMissing,
          advanceAccessRevision: accessPolicyChanged,
          expectedContentRevision: contentState.expectedContentRevision,
          contentPreconditionMissing: contentState.contentPreconditionMissing,
          contentPreconditionInvalid: contentState.contentPreconditionInvalid,
          contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
          ip
        },
        operation: {
          actorNamespace: dashboardNamespace(),
          requestId,
          action: 'share.content.update',
          targetId: id,
          requestHmac
        }
      });
    } catch (error) {
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId,
          retryable: false
        });
      }

      throw error;
    }

    if (outcome.outcome === 'unavailable') {
      return respondOperationUnavailable(res, requestId);
    }

    if (outcome.outcome === 'replayed') {
      const receipt = operationReceipt(outcome.operation);

      if (!outcome.shareState || !receipt || receipt.kind !== 'share.content.update') {
        return respondOperationUnavailable(res, requestId);
      }

      return res.json({
        success: true,
        replayed: true,
        requestId,
        action: 'share.content.update',
        shareId: id,
        contentChanged: receipt.contentChanged === true,
        contentRevision: receipt.contentRevision,
        contentEtag: formatContentEtag(id, receipt.contentRevision),
        accessRevision: receipt.accessRevision
      });
    }

    const result = outcome.result;

    if (result.status === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Page not found'
      });
    }

    if (result.status === 'conflict') {
      return res.status(412).json({
        success: false,
        error: '访问策略已被更新，请刷新后重试',
        accessRevision: result.accessRevision
      });
    }

    if (result.status === 'access_precondition_required') {
      return res.status(428).json({
        success: false,
        error: '缺少 expectedAccessRevision，请刷新后重试'
      });
    }

    if (result.status === 'precondition_required') {
      return res.status(428).json({
        success: false,
        error: '缺少内容版本前置条件 If-Match，请刷新后重试',
        code: 'content_precondition_required',
        contentRevision: result.contentRevision,
        contentEtag: formatContentEtag(id, result.contentRevision)
      });
    }

    if (result.status === 'content_conflict') {
      return res.status(412).json({
        success: false,
        error: '内容已被更新，你的稿件未被覆盖，请查看差异后决定如何处理',
        code: 'content_conflict',
        contentRevision: result.contentRevision,
        contentEtag: formatContentEtag(id, result.contentRevision),
        current: result.current
      });
    }

    const updatedPage = await pageRepository.getById(id);

    pageRepository.createAuditLog({
      action: 'page.update',
      pageId: id,
      details: JSON.stringify({ fields: Object.keys(updateOptions) }),
      ip
    }).catch((err) => { console.error('Audit log failed:', err); });

    return res.json({
      success: true,
      requestId,
      page: {
        id: updatedPage.id,
        title: updatedPage.title,
        description: updatedPage.description,
        htmlContent: updatedPage.html_content,
        codeType: updatedPage.code_type,
        isProtected: updatedPage.is_protected === 1,
        password: visiblePagePassword(updatedPage),
        expiresAt: updatedPage.expires_at,
        accessRevision: toAccessRevisionString(updatedPage.access_revision),
        currentRevision: toContentRevisionString(updatedPage.current_revision),
        contentEtag: formatContentEtag(updatedPage.id, updatedPage.current_revision),
        published: updatedPage.published !== false,
        markdownTheme: updatedPage.markdown_theme,
        createdAt: updatedPage.created_at
      },
      contentChanged: result.contentChanged === true
    });
  }

  router.put('/admin/pages/:id', requireDashboardAdmin, parseShareJson, requireDashboardCsrf, async (req, res) => {
    try {
      // Idempotent save (T09): with a valid Idempotency-Key header the
      // save runs the operation protocol above. A malformed identifier is
      // a client error — never silently ignored, or the client would
      // believe an unkeyed save was idempotent. Without the header the
      // save keeps the exact T01/T06 behavior below.
      const idem = parseIdempotencyKey(req.get('idempotency-key'));

      if (idem.provided && !idem.valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Idempotency-Key',
          code: 'invalid_idempotency_key',
          retryable: false
        });
      }

      if (idem.valid) {
        return await handleIdempotentAdminSave(req, res, idem.value);
      }

      const page = await pageRepository.getById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: 'Page not found'
        });
      }

      const { title, description, htmlContent, expiresAt, isProtected, password, markdownTheme } = req.body;
      const customPassword = parseCustomPassword(password);

      if (customPassword.error) {
        return res.status(400).json({
          success: false,
          error: CUSTOM_PASSWORD_ERROR
        });
      }

      // Submitting content fields (title, description, body, or — for
      // Markdown Shares — the theme Preset) is a content write and requires
      // a concrete strong content If-Match (T06): a missing precondition is
      // 428, and anything that is not exactly the current tag — weak,
      // wildcard, list, bare/single-quoted token, access-family tag, tag
      // for another Share, or a stale revision — is a 412 conflict whose
      // response carries the current snapshot so the caller keeps its
      // candidate and can compare. The latest revision is never filled in
      // silently.
      const touchesContent = title !== undefined
        || description !== undefined
        || htmlContent !== undefined
        || (markdownTheme !== undefined && page.code_type === 'markdown');

      // Write maintenance outranks precondition validation (T04): while
      // publishing writes are paused, a save attempt on either family is a
      // maintenance rejection, not a 428/412 — the gate refuses the write
      // before any precondition could be honored.
      const touchesWriteFamily = touchesContent
        || isProtected !== undefined
        || customPassword.provided
        || expiresAt !== undefined;

      if (touchesWriteFamily
        && typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      let expectedContentRevision = null;

      if (touchesContent) {
        const parsedIfMatch = parseContentIfMatch(req.get('if-match'), page.id);
        const currentContentRevision = toContentRevisionString(page.current_revision);

        if (parsedIfMatch.status === 'missing') {
          return res.status(428).json({
            success: false,
            error: '缺少内容版本前置条件 If-Match，请刷新后重试',
            code: 'content_precondition_required',
            contentRevision: currentContentRevision,
            contentEtag: formatContentEtag(page.id, currentContentRevision)
          });
        }

        if (parsedIfMatch.status !== 'ok'
          || currentContentRevision === null
          || parsedIfMatch.revision !== currentContentRevision) {
          return res.status(412).json({
            success: false,
            error: '内容已被更新，你的稿件未被覆盖，请查看差异后决定如何处理',
            code: 'content_conflict',
            contentRevision: currentContentRevision,
            contentEtag: formatContentEtag(page.id, currentContentRevision),
            current: {
              htmlContent: page.html_content,
              codeType: page.code_type,
              title: page.title,
              description: page.description,
              markdownTheme: page.markdown_theme
            }
          });
        }

        expectedContentRevision = parsedIfMatch.revision;
      }

      // Submitting access-policy fields (protection, password, or expiry) is
      // an access-policy write and requires the caller's expectedAccessRevision
      // precondition (T01). Content-only saves do not need one and never
      // advance the revision.
      const touchesAccessPolicy = isProtected !== undefined
        || customPassword.provided
        || expiresAt !== undefined;
      let expectedAccessRevision = null;

      if (touchesAccessPolicy) {
        expectedAccessRevision = checkAccessPrecondition(req, res, page);

        if (expectedAccessRevision === null) {
          return;
        }
      }

      const updateOptions = {};

      if (title !== undefined) {
        updateOptions.title = title ? String(title).trim() || null : null;
      }
      if (description !== undefined) {
        updateOptions.description = description ? String(description).trim() || null : null;
      }
      if (htmlContent !== undefined) {
        updateOptions.htmlContent = htmlContent;
      }
      if (expiresAt !== undefined) {
        const parsed = Number.parseInt(expiresAt, 10);
        updateOptions.expiresAt = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      if (markdownTheme !== undefined && page.code_type === 'markdown') {
        updateOptions.markdownTheme = resolveMarkdownThemeId(markdownTheme);
      }

      if (isProtected !== undefined) {
        const newProtected = Boolean(isProtected);
        const currentlyProtected = page.is_protected === 1;

        if (newProtected !== currentlyProtected) {
          updateOptions.isProtected = newProtected;

          if (newProtected) {
            const finalPassword = customPassword.provided
              ? customPassword.value
              : generateNumericPassword(DEFAULT_PASSWORD_LENGTH);
            updateOptions.passwordHash = await hashSecret(finalPassword);
            updateOptions.encryptedPassword = encryptSecret(finalPassword);
          } else {
            updateOptions.passwordHash = null;
            updateOptions.encryptedPassword = null;
          }
        } else if (newProtected && customPassword.provided) {
          // Protection status unchanged but password explicitly provided - update password
          updateOptions.isProtected = true;
          updateOptions.passwordHash = await hashSecret(customPassword.value);
          updateOptions.encryptedPassword = encryptSecret(customPassword.value);
        }
      }

      const expiryChanged = expiresAt !== undefined
        && updateOptions.expiresAt !== (page.expires_at ?? null);
      const accessPolicyChanged = updateOptions.isProtected !== undefined || expiryChanged;

      const updateResult = await pageRepository.updatePageWithPreconditions(
        req.params.id,
        updateOptions,
        {
          expectedAccessRevision,
          advanceAccessRevision: accessPolicyChanged,
          expectedContentRevision,
          contentMeta: { source: 'admin-edit', actorType: 'owner', actorId: null },
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        }
      );

      if (updateResult.status === 'conflict') {
        return res.status(412).json({
          success: false,
          error: '访问策略已被更新，请刷新后重试',
          accessRevision: updateResult.accessRevision
        });
      }

      if (updateResult.status === 'content_conflict') {
        // The candidate was NOT applied and the caller's draft is
        // preserved; the response carries the current remote snapshot so
        // the editor can show the difference and let the owner decide.
        return res.status(412).json({
          success: false,
          error: '内容已被更新，你的稿件未被覆盖，请查看差异后决定如何处理',
          code: 'content_conflict',
          contentRevision: updateResult.contentRevision,
          contentEtag: formatContentEtag(req.params.id, updateResult.contentRevision),
          current: updateResult.current
        });
      }

      if (updateResult.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Page not found'
        });
      }

      const updatedPage = await pageRepository.getById(req.params.id);

      pageRepository.createAuditLog({
        action: 'page.update',
        pageId: req.params.id,
        details: JSON.stringify({ fields: Object.keys(updateOptions) }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        page: {
          id: updatedPage.id,
          title: updatedPage.title,
          description: updatedPage.description,
          htmlContent: updatedPage.html_content,
          codeType: updatedPage.code_type,
          isProtected: updatedPage.is_protected === 1,
          password: visiblePagePassword(updatedPage),
          expiresAt: updatedPage.expires_at,
          accessRevision: toAccessRevisionString(updatedPage.access_revision),
          currentRevision: toContentRevisionString(updatedPage.current_revision),
          contentEtag: formatContentEtag(updatedPage.id, updatedPage.current_revision),
          published: updatedPage.published !== false,
          markdownTheme: updatedPage.markdown_theme,
          createdAt: updatedPage.created_at
        },
        contentChanged: updateResult.contentChanged === true
      });
    } catch (error) {
      console.error('Update page failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update page'
      });
    }
  });

  router.delete('/admin/pages/batch', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
      }

      if (ids.length > 100) {
        return res.status(400).json({ success: false, error: 'Batch delete limited to 100 items' });
      }

      const deleted = await pageRepository.deletePages(ids);

      pageRepository.createAuditLog({
        action: 'page.delete.batch',
        pageId: null,
        details: JSON.stringify({ count: deleted, ids: ids.slice(0, 10) }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({ success: true, deleted });
    } catch (error) {
      console.error('Batch delete failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({ success: false, error: 'Failed to delete pages' });
    }
  });

  router.delete('/admin/pages/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
    try {
      const page = await pageRepository.getById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: 'Page not found'
        });
      }

      await pageRepository.deletePage(req.params.id);

      pageRepository.createAuditLog({
        action: 'page.delete',
        pageId: req.params.id,
        details: JSON.stringify({ title: page.title || page.id }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true
      });
    } catch (error) {
      console.error('Delete page failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to delete page'
      });
    }
  });

  // Clone completion marker (T08): after any successful clone — first
  // execution or replay — the server sets this readable cookie so the
  // admin client can retire the persisted clone intent for that request
  // identifier even when the response was a redirect it never inspected.
  const CLONE_INTENT_DONE_COOKIE = 'clone_intent_done';

  function setCloneIntentDoneCookie(res, requestId) {
    res.cookie(CLONE_INTENT_DONE_COOKIE, requestId, {
      maxAge: PUBLISH_SESSION_TTL_MS,
      httpOnly: false,
      secure: config.secureCookies,
      sameSite: 'lax'
    });
  }

  router.post('/admin/pages/:id/clone', requireDashboardAdmin, parseSmallForm, requireDashboardCsrf, async (req, res) => {
    // A clone retry carries its request identifier either as the
    // Idempotency-Key header or as the form's requestId field (T08); the
    // dashboard client persists one intent per clone target so a lost or
    // unknown-outcome submission can be safely repeated.
    const idem = parseIdempotencyKey(req.get('idempotency-key') || req.body?.requestId);

    if (idem.provided && !idem.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Idempotency-Key',
        code: 'invalid_idempotency_key',
        retryable: false
      });
    }

    try {
      const page = await pageRepository.getById(req.params.id);

      if (!page) {
        return res.status(404).json({ success: false, error: 'Page not found' });
      }

      const buildClone = (row) => ({
        htmlContent: row.html_content,
        codeType: row.code_type,
        title: (row.title || row.id) + ' (Copy)',
        description: row.description,
        markdownTheme: row.code_type === 'markdown'
          ? resolveMarkdownThemeId(row.markdown_theme)
          : null
      });
      const audit = {
        action: 'page.clone',
        details: JSON.stringify({
          sourceId: req.params.id,
          ...(idem.provided ? { requestId: idem.value } : {})
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      };

      if (idem.provided) {
        const outcome = await pageRepository.clonePage({
          sourceId: req.params.id,
          operation: {
            actorNamespace: dashboardNamespace(),
            requestId: idem.value,
            action: 'share.clone',
            targetId: req.params.id,
            requestHmac: computeRequestHmac({
              action: 'share.clone',
              targetId: req.params.id,
              presence: {},
              values: {}
            })
          },
          buildClone,
          audit
        });

        if (outcome.outcome === 'unavailable'
          || (outcome.outcome === 'replayed' && !outcome.shareState)) {
          return respondOperationUnavailable(res, idem.value);
        }

        const targetId = outcome.outcome === 'created'
          ? outcome.id
          : outcome.operation.resultShareId;
        setCloneIntentDoneCookie(res, idem.value);
        return res.redirect('/admin/pages/' + encodeURIComponent(targetId));
      }

      const outcome = await pageRepository.clonePage({
        sourceId: req.params.id,
        buildClone,
        audit
      });

      return res.redirect('/admin/pages/' + encodeURIComponent(outcome.id));
    } catch (error) {
      console.error('Clone page failed:', error);
      if (error && error.code === 'share_not_found') {
        return res.status(404).json({ success: false, error: 'Page not found' });
      }
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: '该请求标识已用于另一个克隆目标',
          code: 'idempotency_conflict',
          requestId: idem.provided ? idem.value : null,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({ success: false, error: 'Failed to clone page' });
    }
  });

  // Owner operation lookup (T08): the signed-in owner confirms an
  // operation by request identifier across namespaces from the dashboard
  // API. Reports only the actor KIND (never a credential identity beyond
  // its kind) plus the same restricted identifiers as the Key endpoint.
  router.get('/admin/operations/:requestId', requireDashboardApiAdmin, async (req, res) => {
    const parsed = parseIdempotencyKey(req.params.requestId);

    if (!parsed.provided || !parsed.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request id',
        code: 'invalid_request_id',
        retryable: false
      });
    }

    try {
      const record = await pageRepository.getOperationByRequestId(parsed.value);

      if (!record) {
        return res.status(404).json({
          success: false,
          error: 'Operation not found',
          code: 'operation_not_found',
          requestId: parsed.value,
          retryable: false
        });
      }

      return res.json({
        success: true,
        requestId: record.requestId,
        action: record.action,
        actorKind: namespaceKind(record.actorNamespace),
        status: record.resultState,
        shareId: record.resultShareId,
        targetId: record.targetId,
        contentRevision: record.resultRevision,
        accessRevision: record.resultAccessRevision,
        createdAt: record.createdAt
      });
    } catch (error) {
      console.error('Admin operation lookup failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter
};
