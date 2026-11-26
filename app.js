require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('path');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { createAuth } = require('./middleware/auth');
const {
  isTrustedUiPath,
  privateNoStore,
  respondIfPublishingGate,
  respondOperationUnavailable,
  setTrustedUiCsp
} = require('./middleware/responsePolicy');
const { createBodyParsers } = require('./middleware/bodyParsers');
const { createApiV1Router } = require('./routes/apiV1');
const { createViewRouter } = require('./routes/view');
const { createAdminRouter } = require('./routes/admin');
const { createAdminApiKeysRouter } = require('./routes/adminApiKeys');
const { createPageRepository } = require('./models/pageRepository');
const { createShareOperations } = require('./services/shareOperations');
const { FAVICON_VERSION } = require('./utils/faviconVersion');
const { createPublicUrls } = require('./utils/publicUrls');
const {
  prepareSandboxContent,
  renderSandboxedDocument
} = require('./utils/sandboxDocument');
const {
  getMarkdownThemeOptions
} = require('./utils/markdownThemeCatalog');

const {
  isIdempotencyConflictError,
  namespaceKind,
  parseIdempotencyKey
} = require('./utils/idempotency');
const {
  formatManagementDateTime,
  toManagementDateTimeLocal
} = require('./utils/management-time');
const {
  CUSTOM_PASSWORD_ERROR,
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  encryptSecret,
  generateNumericPassword,
  hashSecret,
  parseCustomPassword
} = require('./utils/security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FAVICON_PATH = path.join(PUBLIC_DIR, 'icon/web/favicon.ico');
const STATIC_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

const app = express();
const pageRepository = createPageRepository();
const auth = createAuth({ config, pageRepository });
const {
  adminSessionToken,
  browserCreateContext,
  clearAdminCookie,
  clearDashboardAdminCookie,
  getAdminSession,
  getDashboardAdminSession,
  requireApiAdmin,
  requireBrowserPublishAccess,
  requireBrowserPublishCsrf,
  requireCsrf,
  requireDashboardApiAdmin,
  requireHomepageAccess,
  setAdminCookie,
  setDashboardAdminCookie,
  verifyAdminPassword,
  verifyDashboardAdminPassword
} = auth;
const publicUrls = createPublicUrls(config);
const parsers = createBodyParsers(config);
const {
  parseShareJson,
  parseSmallForm,
  parseSmallJson
} = parsers;
const shareOps = createShareOperations({ config, pageRepository });
const {
  checkAccessPrecondition,
  createOutcomePayload,
  createPageFromInput,
  executeIdempotentCreate,
  isCreateValidationError
} = shareOps;
const { socialImageUrl } = publicUrls;

app.locals.config = config;
app.locals.pageRepository = pageRepository;
app.locals.formatManagementDateTime = formatManagementDateTime;
app.locals.toManagementDateTimeLocal = toManagementDateTimeLocal;
app.locals.requestLogStream = process.stdout;
app.locals.viewPerformanceLogger = config.env === 'test' ? { info() {} } : console;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.disable('x-powered-by');

morgan.token('url', safeRequestLogUrl);
morgan.token('referrer', safeRequestLogReferrer);
app.use(morgan(config.logLevel, {
  skip: shouldSkipGenericRequestLog,
  stream: {
    write(line) {
      const stream = app.locals.requestLogStream || process.stdout;
      stream.write(line);
    }
  }
}));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (isTrustedUiPath(req.path)) {
    setTrustedUiCsp(res);
  }

  return next();
});
app.use('/login', privateNoStore);
app.use('/admin', privateNoStore);
app.use(cookieParser());
app.get('/favicon.ico', (req, res) => res.sendFile(FAVICON_PATH, {
  maxAge: STATIC_CACHE_MAX_AGE_MS,
  immutable: false,
  headers: { 'Cache-Control': STATIC_CACHE_CONTROL }
}));
app.use(express.static(PUBLIC_DIR, {
  maxAge: STATIC_CACHE_MAX_AGE_MS,
  immutable: false,
  etag: true,
  setHeaders: setStaticCacheHeaders
}));
app.use((req, res, next) => {
  res.locals.socialImageUrl = socialImageUrl(req);
  res.locals.faviconVersion = FAVICON_VERSION;
  return next();
});

function setStaticCacheHeaders(res) {
  res.setHeader('Cache-Control', STATIC_CACHE_CONTROL);
}

function exactViewRoute(pathname) {
  const match = /^\/view\/[^/]+(?:\/(password|view-event))?\/?$/i.exec(pathname);

  if (!match) {
    return null;
  }

  return match[1] ? `/view/:id/${match[1]}` : '/view/:id';
}

function safeViewLogPath(pathname) {
  return exactViewRoute(pathname)
    || (/^\/view\/[^/]+(?:\/.*)?$/i.test(pathname) ? '/view/:id/*' : null);
}

function safeRequestLogUrl(req) {
  return safeViewLogPath(req.path) || req.originalUrl || req.url;
}

function safeRequestLogReferrer(req) {
  const value = req.get('referer') || req.get('referrer');

  if (!value) {
    return '-';
  }

  try {
    const referrer = new URL(value, 'http://localhost');
    const safeRoute = safeViewLogPath(referrer.pathname);

    if (safeRoute) {
      return safeRoute;
    }

    referrer.search = '';
    referrer.hash = '';
    return referrer.toString();
  } catch (error) {
    return '-';
  }
}

function shouldSkipGenericRequestLog(req) {
  return ['GET', 'HEAD'].includes(req.method) && exactViewRoute(req.path) === '/view/:id';
}

app.get('/login', (req, res) => {
  if (!config.authEnabled || getAdminSession(req)) {
    return res.redirect('/');
  }

  return res.render('login', {
    title: 'QuickShare | 登录',
    page: 'login-page',
    error: null,
    formAction: '/login',
    heading: '请输入访问密码',
    inputPlaceholder: '请输入访问密码...'
  });
});

app.post('/login', parseSmallForm, async (req, res) => {
  if (!config.authEnabled) {
    return res.redirect('/');
  }

  const isValid = await verifyAdminPassword(req.body.password);

  if (!isValid) {
    return res.status(401).render('login', {
      title: 'QuickShare | 登录',
      page: 'login-page',
      error: '密码错误，请重试',
      formAction: '/login',
      heading: '请输入访问密码',
      inputPlaceholder: '请输入访问密码...'
    });
  }

  setAdminCookie(res);
  return res.redirect('/');
});

app.get('/logout', (req, res) => {
  clearAdminCookie(res);
  return res.redirect('/login');
});

app.get('/admin/login', (req, res) => {
  if (!config.authEnabled || getDashboardAdminSession(req)) {
    return res.redirect('/admin/stats');
  }

  return res.render('login', {
    title: 'QuickShare | 管理后台登录',
    page: 'login-page',
    error: null,
    formAction: '/admin/login',
    heading: '请输入管理后台密码',
    inputPlaceholder: '请输入管理后台密码...'
  });
});

app.post('/admin/login', parseSmallForm, async (req, res) => {
  if (!config.authEnabled) {
    return res.redirect('/admin/stats');
  }

  const isValid = await verifyDashboardAdminPassword(req.body.password);

  if (!isValid) {
    return res.status(401).render('login', {
      title: 'QuickShare | 管理后台登录',
      page: 'login-page',
      error: '管理后台密码错误，请重试',
      formAction: '/admin/login',
      heading: '请输入管理后台密码',
      inputPlaceholder: '请输入管理后台密码...'
    });
  }

  setDashboardAdminCookie(res);

  pageRepository.createAuditLog({
    action: 'admin.login',
    pageId: null,
    details: JSON.stringify({ method: 'password' }),
    ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
  }).catch((err) => { console.error('Audit log failed:', err); });

  return res.redirect('/admin/stats');
});

app.get('/admin/logout', (req, res) => {
  clearDashboardAdminCookie(res);
  return res.redirect('/admin/login');
});

app.get('/', privateNoStore, requireHomepageAccess, (req, res) => {
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

app.get('/admin', (req, res) => {
  if (!config.authEnabled || getDashboardAdminSession(req)) {
    return res.redirect('/admin/stats');
  }

  return res.redirect('/admin/login');
});

app.use(createAdminApiKeysRouter({ config, pageRepository, auth, parsers }));

app.use(createAdminRouter({ config, pageRepository, auth, publicUrls, shareOps, parsers }));

app.post('/api/pages/create', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishCsrf, async (req, res) => {
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

app.post('/api/pages/preview', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishCsrf, async (req, res) => {
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

app.use(createApiV1Router({ config, pageRepository, auth, publicUrls, shareOps, parsers }));

// Owner operation lookup (T08): the signed-in owner confirms an
// operation by request identifier across namespaces from the dashboard
// API. Reports only the actor KIND (never a credential identity beyond
// its kind) plus the same restricted identifiers as the Key endpoint.
app.get('/admin/operations/:requestId', requireDashboardApiAdmin, async (req, res) => {
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

app.use(createViewRouter({ config, pageRepository, auth, publicUrls, parseSmallJson }));

app.post('/api/pages/:id/protect', privateNoStore, requireApiAdmin, parseSmallJson, requireCsrf, async (req, res) => {
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

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: '请求内容过大'
    });
  }

  return next(error);
});

app.use((req, res) => {
  setTrustedUiCsp(res);
  res.status(404).render('error', {
    title: '页面未找到',
    page: 'error-page',
    message: '您请求的页面不存在'
  });
});

module.exports = app;
