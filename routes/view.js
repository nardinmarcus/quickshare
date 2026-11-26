const express = require('express');
const { performance } = require('node:perf_hooks');

const { privateNoStore, setPrivateNoStore, setTrustedUiCsp } = require('../middleware/responsePolicy');
const {
  formatContentEtag,
  toContentRevisionString
} = require('../utils/contentRevision');
const { isPublishingGateError } = require('../utils/publishing');
const { projectPublicMetadata } = require('../utils/publicProjection');
const {
  VALID_CODE_TYPES,
  prepareSandboxContent,
  renderSandboxedDocument
} = require('../utils/sandboxDocument');
const { verifySecret } = require('../utils/security');
const { toAccessRevisionString } = require('../utils/shareAccess');

let nextViewRequestIsColdStart = true;

function createViewRouter({ config, pageRepository, auth, publicUrls, parseSmallJson }) {
  const router = express.Router();
  const {
    getDashboardAdminSession,
    getPageAccess,
    hasPageAccess,
    isSameOriginRequest,
    setPageAccessCookie
  } = auth;
  const { socialImageUrl } = publicUrls;

  function roundDuration(value) {
    return Math.max(0, Number(value.toFixed(3)));
  }

  function responseByteLength(res) {
    const header = res.getHeader('content-length');
    const value = Array.isArray(header) ? header[0] : header;
    const parsed = Number.parseInt(String(value || '0'), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function beginViewPerformance(req, res) {
    const metrics = {
      startedAt: performance.now(),
      dbMs: 0,
      renderMs: 0,
      contentType: null,
      protected: null,
      outcome: 'unknown',
      phase: 'routing',
      coldStart: nextViewRequestIsColdStart
    };
    let finalized = false;

    nextViewRequestIsColdStart = false;

    function finalize(closedEarly = false) {
      if (finalized) {
        return;
      }

      finalized = true;

      if (closedEarly) {
        metrics.outcome = 'client_closed';
      }

      const event = {
        event: 'quickshare.view',
        route: '/view/:id',
        method: req.method,
        outcome: metrics.outcome,
        status: res.statusCode,
        total_ms: roundDuration(performance.now() - metrics.startedAt),
        db_ms: roundDuration(metrics.dbMs),
        render_ms: roundDuration(metrics.renderMs),
        response_bytes: responseByteLength(res),
        content_type: metrics.contentType,
        protected: metrics.protected,
        cold_start: metrics.coldStart
      };

      try {
        (req.app.locals.viewPerformanceLogger || console).info(JSON.stringify(event));
      } catch (error) {
        // Observability must never change the response path.
      }
    }

    res.once('finish', () => finalize(false));
    res.once('close', () => finalize(!res.writableFinished));
    return metrics;
  }

  function safeContentType(value) {
    return VALID_CODE_TYPES.has(value) ? value : 'unknown';
  }

  function safeErrorCode(error) {
    return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : 'UNKNOWN';
  }

  router.get('/api/pages/:id', async (req, res) => {
    try {
      const publicPage = await pageRepository.getPublicById(req.params.id, Date.now());

      if (!publicPage) {
        return res.status(404).json({
          success: false,
          error: '页面不存在'
        });
      }

      // Unpublished is indistinguishable from nonexistent on every public
      // surface (T11, parent spec §5), and the judgment outranks expiry:
      // an unpublished Share answers 404 even with a valid access cookie,
      // and even when it is also expired.
      if (publicPage.page.published === false) {
        return res.status(404).json({
          success: false,
          error: '页面不存在'
        });
      }

      if (publicPage.expired) {
        return res.status(410).json({
          success: false,
          error: '此分享已失效'
        });
      }

      const { page } = publicPage;

      if (page.is_protected === 1) {
        setPrivateNoStore(res);
      }

      // Unified public projection (T02): a locked protected Share exposes
      // only neutral metadata until the requester presents a valid access
      // credential. The unlock judgment reuses T01's revision-bound cookie
      // check, so a credential revoked by a policy change no longer unlocks
      // the real title/description either.
      const hasValidAccess = page.is_protected !== 1
        || hasPageAccess(req, page.id, page.access_revision);
      const projected = projectPublicMetadata(page, hasValidAccess);

      // The content GET carries the strong content ETag (T06, parent spec
      // §4), but only for a requester who may see the real metadata: a
      // locked Share's neutral projection must not leak even the revision
      // counter, so neither the header nor the field is emitted for it.
      const contentRevision = hasValidAccess
        ? toContentRevisionString(page.current_revision)
        : null;

      if (contentRevision !== null) {
        res.set('ETag', formatContentEtag(page.id, contentRevision));
      }

      return res.json({
        success: true,
        page: {
          id: page.id,
          createdAt: page.created_at,
          codeType: page.code_type,
          title: projected.title,
          description: projected.description,
          isProtected: page.is_protected === 1,
          expiresAt: page.expires_at,
          accessRevision: toAccessRevisionString(page.access_revision),
          ...(contentRevision !== null ? { contentRevision } : {}),
          markdownTheme: page.markdown_theme
        }
      });
    } catch (error) {
      console.error('Get page failed:', error);
      return res.status(500).json({
        success: false,
        error: '服务器错误'
      });
    }
  });

  router.post('/view/:id/password', privateNoStore, parseSmallJson, async (req, res) => {
    try {
      const publicPage = await pageRepository.getPublicById(req.params.id, Date.now());

      if (!publicPage) {
        return res.status(404).json({
          valid: false
        });
      }

      // Unpublished answers exactly like nonexistent here too (T11), so
      // no new unlock credential can be minted while a Share is down —
      // and the unpublished judgment outranks expiry.
      if (publicPage.page.published === false) {
        return res.status(404).json({
          valid: false
        });
      }

      if (publicPage.expired) {
        return res.status(410).json({
          valid: false,
          error: '此分享已失效'
        });
      }

      const { page } = publicPage;

      if (page.is_protected !== 1) {
        return res.status(404).json({
          valid: false
        });
      }

      const isValid = await verifySecret(req.body.password, page.password_hash || page.password);

      if (!isValid) {
        return res.status(401).json({
          valid: false
        });
      }

      // Issue the credential bound to the access revision read together with
      // the password hash above (T01). If the policy rotates afterwards, this
      // cookie carries the old revision and is rejected; a credential for the
      // newest revision is never minted from an old-policy verification.
      setPageAccessCookie(res, req.params.id, page.access_revision);
      return res.json({
        valid: true,
        redirectUrl: `/view/${req.params.id}`
      });
    } catch (error) {
      console.error('Validate page password failed:', error);
      return res.status(500).json({
        valid: false
      });
    }
  });

  router.post('/view/:id/view-event', privateNoStore, async (req, res) => {
    if (!isSameOriginRequest(req)) {
      return res.sendStatus(403);
    }

    try {
      const access = getPageAccess(req, req.params.id);
      const outcome = await pageRepository.recordViewEvent(
        req.params.id,
        Date.now(),
        Boolean(access),
        access?.accessRevision ?? null
      );

      if (outcome === 'not_found') {
        return res.sendStatus(404);
      }

      if (outcome === 'expired') {
        return res.sendStatus(410);
      }

      if (outcome === 'protected') {
        return res.sendStatus(403);
      }

      // During write maintenance the event is not counted at all (T04).
      if (outcome === 'maintenance') {
        return res.sendStatus(503);
      }

      return outcome === 'counted' ? res.sendStatus(204) : res.sendStatus(500);
    } catch (error) {
      console.error('Track page view failed:', {
        name: error?.name || 'Error',
        code: safeErrorCode(error)
      });
      return res.sendStatus(isPublishingGateError(error) ? 503 : 500);
    }
  });

  router.get('/view/:id', async (req, res) => {
    setPrivateNoStore(res);
    const metrics = beginViewPerformance(req, res);

    try {
      metrics.phase = 'database';
      const databaseStartedAt = performance.now();
      let publicPage;

      try {
        publicPage = await pageRepository.getPublicById(req.params.id, Date.now());
      } finally {
        metrics.dbMs = performance.now() - databaseStartedAt;
      }

      metrics.phase = 'routing';

      if (!publicPage) {
        metrics.outcome = 'not_found';
        setTrustedUiCsp(res, { allowFraming: true });
        return res.status(404).render('error', {
          title: '页面未找到',
          page: 'error-page',
          message: '您请求的页面不存在或已被删除'
        });
      }

      const { page } = publicPage;
      metrics.contentType = safeContentType(page.code_type);
      metrics.protected = page.is_protected === 1;

      // Unpublished renders the same 404 page as a missing Share (T11),
      // ahead of the expiry judgment — for every requester, including one
      // holding a still-current access cookie or a dashboard preview.
      if (page.published === false) {
        metrics.outcome = 'not_found';
        setTrustedUiCsp(res, { allowFraming: true });
        return res.status(404).render('error', {
          title: '页面未找到',
          page: 'error-page',
          message: '您请求的页面不存在或已被删除'
        });
      }

      if (publicPage.expired) {
        metrics.outcome = 'expired';
        setTrustedUiCsp(res, { allowFraming: true });
        return res.status(410).render('error', {
          title: '分享已失效',
          page: 'error-page',
          message: '此分享已失效，无法继续访问'
        });
      }

      if (page.is_protected === 1 && !hasPageAccess(req, req.params.id, page.access_revision)) {
        metrics.outcome = 'password_required';
        setTrustedUiCsp(res, { allowFraming: true });
        return res.render('password', {
          title: 'QuickShare | 密码保护',
          page: 'password-page',
          id: req.params.id,
          error: null
        });
      }

      metrics.phase = 'render';
      const renderStartedAt = performance.now();
      let prepared;

      try {
        prepared = await prepareSandboxContent(
          page.html_content,
          page.code_type,
          page.markdown_theme
        );
      } finally {
        metrics.renderMs = performance.now() - renderStartedAt;
      }

      metrics.phase = 'response';
      metrics.contentType = safeContentType(prepared.contentType);
      metrics.outcome = 'served';

      const pageUrl = `${req.protocol}://${req.get('host')}/view/${req.params.id}`;
      const isDashboardPreview = req.query.adminPreview !== undefined && (
        !config.authEnabled || Boolean(getDashboardAdminSession(req))
      );
      const viewEventUrl = isDashboardPreview
        ? null
        : `/view/${encodeURIComponent(req.params.id)}/view-event`;
      return res.send(renderSandboxedDocument(prepared.renderedContent, prepared.contentType, {
        title: page.title,
        description: page.description,
        pageUrl,
        socialImageUrl: socialImageUrl(req),
        viewEventUrl
      }));
    } catch (error) {
      metrics.outcome = metrics.phase === 'database'
        ? 'database_error'
        : metrics.phase === 'render'
          ? 'render_error'
          : 'server_error';
      console.error('View page failed:', {
        name: error?.name || 'Error',
        code: safeErrorCode(error)
      });
      setTrustedUiCsp(res, { allowFraming: true });
      return res.status(500).render('error', {
        title: '服务器错误',
        page: 'error-page',
        message: '查看页面时发生错误，请稍后再试'
      });
    }
  });

  return router;
}

module.exports = {
  createViewRouter
};
