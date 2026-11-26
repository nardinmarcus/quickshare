const express = require('express');
const {
  privateNoStore,
  respondIfPublishingGate,
  respondOperationUnavailable
} = require('../middleware/responsePolicy');
const { isIdempotencyConflictError, parseIdempotencyKey } = require('../utils/idempotency');
const { getMarkdownThemeOptions } = require('../utils/markdownThemeCatalog');
const { prepareSandboxContent, renderSandboxedDocument } = require('../utils/sandboxDocument');
const {
  CUSTOM_PASSWORD_ERROR,
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  encryptSecret,
  generateNumericPassword,
  hashSecret,
  parseCustomPassword
} = require('../utils/security');

function createPublishRouter({ pageRepository, auth, publicUrls, shareOps, parsers }) {
  const router = express.Router();
  const {
    adminSessionToken,
    browserCreateContext,
    requireApiAdmin,
    requireBrowserPublishAccess,
    requireBrowserPublishCsrf,
    requireCsrf,
    requireHomepageAccess
  } = auth;
  const {
    socialImageUrl
  } = publicUrls;
  const {
    checkAccessPrecondition,
    createOutcomePayload,
    createPageFromInput,
    executeIdempotentCreate,
    isCreateValidationError
  } = shareOps;
  const {
    parseShareJson,
    parseSmallJson
  } = parsers;

  router.get('/', privateNoStore, requireHomepageAccess, (req, res) => {
    const sessionToken = adminSessionToken(req);
    // The publish-session tag lets the homepage client bind a pending
    // create to this namespace and detect when the session rotated (T08).
    const publishContext = browserCreateContext(req, res);

    return res.render('index', {
      title: 'QuickShare | 粘贴代码，一键分享',
      page: 'home-page',
      csrfToken: req.homepageAccessMode === 'locked' ? createCsrfToken(sessionToken) : '',
      markdownThemeOptions: getMarkdownThemeOptions(),
      socialImageUrl: socialImageUrl(req),
      publishSessionTag: publishContext.sessionTag
    });
  });

  router.post('/api/pages/create', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishCsrf, async (req, res) => {
    // Idempotency-Key (T08): the homepage client sends a per-publish-intent
    // request identifier; retries of the same intent replay the original
    // result instead of minting a second Share. Requests without the
    // header keep the historical behavior exactly.
    const idem = parseIdempotencyKey(req.get('idempotency-key'));

    if (idem.provided && !idem.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Idempotency-Key',
        code: 'invalid_idempotency_key',
        retryable: false
      });
    }

    try {
      if (idem.provided) {
        const context = browserCreateContext(req, res);
        const outcome = await executeIdempotentCreate(req, {
          namespace: context.namespace,
          requestId: idem.value,
          source: 'web',
          apiCredential: undefined
        });
        const payload = createOutcomePayload(outcome);

        if (!payload) {
          return respondOperationUnavailable(res, idem.value);
        }

        return res.json({
          success: true,
          urlId: payload.shareId,
          password: payload.password,
          isProtected: payload.isProtected,
          codeType: payload.codeType,
          title: payload.title,
          description: payload.description,
          expiresAt: payload.expiresAt,
          markdownTheme: payload.markdownTheme,
          contentRevision: payload.contentRevision,
          contentEtag: payload.contentEtag,
          requestId: idem.value,
          ...(outcome.outcome === 'replayed' ? { replayed: true } : {})
        });
      }

      const result = await createPageFromInput(req.body);

      if (result.error) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }

      pageRepository.createAuditLog({
        action: 'page.create',
        pageId: result.id,
        details: JSON.stringify({ codeType: result.codeType, isProtected: result.isProtected }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        urlId: result.id,
        password: result.password,
        isProtected: result.isProtected,
        codeType: result.codeType,
        title: result.title,
        description: result.description,
        expiresAt: result.expiresAt,
        markdownTheme: result.markdownTheme,
        contentRevision: result.contentRevision,
        contentEtag: result.contentEtag
      });
    } catch (error) {
      console.error('Create page failed:', error);
      if (isCreateValidationError(error)) {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: '该请求标识已用于不同的创建内容，请作为新的发布重新提交',
          code: 'idempotency_conflict',
          requestId: idem.provided ? idem.value : null,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: '服务器错误'
      });
    }
  });

  router.post('/api/pages/preview', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishCsrf, async (req, res) => {
    try {
      const { htmlContent, codeType, markdownTheme, title, description } = req.body || {};

      if (typeof htmlContent !== 'string' || !htmlContent.trim()) {
        return res.status(400).json({
          success: false,
          error: '请提供内容'
        });
      }

      const prepared = await prepareSandboxContent(htmlContent, codeType, markdownTheme);

      return res.json({
        success: true,
        codeType: prepared.contentType,
        document: renderSandboxedDocument(prepared.renderedContent, prepared.contentType, {
          title: title ? String(title).trim() : null,
          description: description ? String(description).trim() : null,
          socialImageUrl: socialImageUrl(req)
        })
      });
    } catch (error) {
      console.error('Preview page failed:', error);
      return res.status(500).json({
        success: false,
        error: '预览生成失败，请稍后重试'
      });
    }
  });

  router.post('/api/pages/:id/protect', privateNoStore, requireApiAdmin, parseSmallJson, requireCsrf, async (req, res) => {
    try {
      const page = await pageRepository.getById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: '页面不存在'
        });
      }

      const isProtected = Boolean(req.body.isProtected);
      const customPassword = parseCustomPassword(req.body.password);

      if (customPassword.error) {
        return res.status(400).json({
          success: false,
          error: CUSTOM_PASSWORD_ERROR
        });
      }

      // The existing protection entry is an access-policy write and carries
      // the same expectedAccessRevision precondition as the admin routes
      // (T01): missing is 428, stale is 412.
      const expectedAccessRevision = checkAccessPrecondition(req, res, page);

      if (expectedAccessRevision === null) {
        return;
      }

      const password = isProtected
        ? (customPassword.provided ? customPassword.value : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
        : null;
      const passwordHash = password ? await hashSecret(password) : null;
      const encryptedPassword = password ? encryptSecret(password) : null;

      // This entry always (re)sets the password when protection is on and
      // clears it when protection is turned off, so any submission that does
      // not restate the unchanged unprotected state is one access-policy
      // update and advances the revision.
      const accessPolicyChanged = isProtected || page.is_protected === 1;

      const result = await pageRepository.updateProtectionWithAccessRevision(req.params.id, {
        isProtected,
        passwordHash,
        encryptedPassword
      }, {
        expectedAccessRevision,
        advanceAccessRevision: accessPolicyChanged
      });

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
          error: '页面不存在'
        });
      }

      return res.json({
        success: true,
        isProtected,
        password,
        accessRevision: result.accessRevision
      });
    } catch (error) {
      console.error('Update page protection failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: '更新保护状态失败'
      });
    }
  });

  return router;
}

module.exports = {
  createPublishRouter
};
