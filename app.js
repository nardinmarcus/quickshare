require('dotenv').config();

const express = require('express');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('path');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { performance } = require('node:perf_hooks');

const config = require('./config');
const { managedIdentity, CREATE_ONLY_SCOPES, READ_SCOPE } = require('./utils/apiKeyIdentity');
const {
  CONTENT_TYPES, CREATE_SHARE, SHARE_CONTENT_UPDATE, SHARE_UNPUBLISH, SHARE_REPUBLISH, apiCapabilities
} = require('./utils/apiCapabilities');
const capabilities = apiCapabilities(config);
const { isAccessRevision, requireAccessRevision, accessError } = require('./utils/shareAccess');
const { contentEtag, accessEtag, ifNoneMatchMatches, requireContentBaselineFor, isContentRevision } = require('./utils/contentRevision');
const { publicShareProjection } = require('./utils/publicShareProjection');
const { createPageRepository } = require('./models/pageRepository');
const { createPublishing, sendPublishingError } = require('./models/publishing');
const { detectCodeType, extractCodeBlocks } = require('./utils/codeDetector');
const { renderContent, escapeHtml } = require('./utils/contentRenderer');
const { FAVICON_VERSION } = require('./utils/faviconVersion');
const {
  getMarkdownThemeOptions,
  resolveMarkdownThemeId
} = require('./utils/markdownThemeCatalog');
const { derivePageTitle } = require('./utils/pageTitle');
const {
  INVALID_REQUEST_ID_MESSAGE,
  isvalidRequestId,
  resolveApiCredentialNamespace,
  resolveBrowserPublishNamespace,
  resolveDashboardSessionNamespace,
  namespaceKind,
  encodeOperationReceipt
} = require('./utils/publishingOperation');
const {
  normalizeCreateInput,
  createRequestDigest,
  createPageWithUniqueId,
  executeNormalizedCreate,
  buildCreationOperationRecord,
  classifyOperationReplay,
  normalizeContentUpdateDigestInput,
  validateDashboardUpdateInput,
  validateApiContentUpdateInput,
  normalizeRestoreDigestInput,
  normalizePublishStateDigestInput,
  isPublishStateAction,
  operationStatusProjection
} = require('./models/publishingOperations');
const {
  formatManagementDateTime,
  toManagementDateTimeLocal
} = require('./utils/management-time');
const {
  CUSTOM_PASSWORD_ERROR,
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  createScopedToken,
  decryptSecret,
  encryptSecret,
  generateId,
  generateNumericPassword,
  hashSecret,
  parseCustomPassword,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
} = require('./utils/security');

const ADMIN_COOKIE = 'admin_session';
const DASHBOARD_ADMIN_COOKIE = 'dashboard_admin_session';
const PUBLISH_SESSION_COOKIE = 'publish_session';
const CLONE_INTENT_DONE_COOKIE = 'clone_intent_done';
const ADMIN_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLISH_SCOPE = 'share:publish';
const PAGE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_CODE_TYPES = new Set(CONTENT_TYPES);
const PUBLIC_DIR = path.join(__dirname, 'public');
const FAVICON_PATH = path.join(PUBLIC_DIR, 'icon/web/favicon.ico');
const STATIC_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const SOCIAL_IMAGE_PATH = '/icon/web/icon-512.png';
const SOCIAL_IMAGE_VERSION = createHash('sha256')
  .update(fs.readFileSync(path.join(PUBLIC_DIR, SOCIAL_IMAGE_PATH)))
  .digest('hex')
  .slice(0, 12);
const EMBEDDABLE_UI_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' https://umami.namooca.com",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://umami.namooca.com",
  "form-action 'self'",
  "frame-src 'self'"
].join('; ');
const TRUSTED_UI_CSP = `${EMBEDDABLE_UI_CSP}; frame-ancestors 'none'`;
let nextViewRequestIsColdStart = true;

const app = express();
const pageRepository = createPageRepository();
const publishing = createPublishing(pageRepository);
const parseSmallJson = bodyParser.json({ limit: capabilities.limits.smallRequestBodyBytes });
const parseSmallForm = bodyParser.urlencoded({ extended: true, limit: capabilities.limits.smallRequestBodyBytes });
const parseShareJson = bodyParser.json({ limit: capabilities.limits.shareRequestBodyBytes });

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
app.use(cors({ origin: false }));
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

function setPrivateNoStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

function privateNoStore(req, res, next) {
  setPrivateNoStore(res);
  return next();
}

function parseSmallJsonBody(req, res, next) {
  return parseSmallJson(req, res, (error) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON body'
      });
    }

    return next(error);
  });
}

function isTrustedUiPath(pathname) {
  return /^\/login\/?$/i.test(pathname) || /^\/admin(?:\/|$)/i.test(pathname);
}

function setTrustedUiCsp(res, { allowFraming = false } = {}) {
  res.set('Content-Security-Policy', allowFraming ? EMBEDDABLE_UI_CSP : TRUSTED_UI_CSP);
}

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
      (app.locals.viewPerformanceLogger || console).info(JSON.stringify(event));
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

function getAdminSession(req) {
  const token = req.cookies?.[ADMIN_COOKIE];
  const payload = verifyScopedToken(token, 'admin');

  if (!payload) {
    return null;
  }

  return {
    payload,
    token
  };
}

function getDashboardAdminSession(req) {
  const token = req.cookies?.[DASHBOARD_ADMIN_COOKIE];
  const payload = verifyScopedToken(token, 'dashboard-admin');

  if (!payload) {
    return null;
  }

  return {
    payload,
    token
  };
}

async function getHomepageAccessMode() {
  const passwordRequired = await pageRepository.getHomepagePasswordRequired();

  if (typeof passwordRequired !== 'boolean') {
    throw new Error('Homepage access setting is unavailable');
  }

  return passwordRequired ? 'locked' : 'public';
}

async function requireHomepageAccess(req, res, next) {
  if (!config.authEnabled) {
    req.homepageAccessMode = 'auth-disabled';
    return next();
  }

  try {
    req.homepageAccessMode = await getHomepageAccessMode();

    if (req.homepageAccessMode === 'public') {
      return next();
    }

    const session = getAdminSession(req);

    if (!session) {
      return res.redirect('/login');
    }

    req.adminSession = session;
    return next();
  } catch (error) {
    console.error('Homepage access check failed:', error);
    return res.status(503).render('error', {
      title: 'Service Unavailable',
      page: 'error-page',
      message: '首页访问设置暂时不可用，请稍后重试'
    });
  }
}

async function requireBrowserPublishAccess(req, res, next) {
  if (!config.authEnabled) {
    req.homepageAccessMode = 'auth-disabled';
    return next();
  }

  try {
    req.homepageAccessMode = await getHomepageAccessMode();

    if (req.homepageAccessMode === 'public') {
      if (!isSameOriginRequest(req)) {
        return res.status(403).json({
          success: false,
          error: 'Invalid request origin'
        });
      }

      return next();
    }

    const session = getAdminSession(req);

    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    req.adminSession = session;
    return next();
  } catch (error) {
    console.error('Browser publish access check failed:', error);
    return res.status(503).json({
      success: false,
      error: 'Homepage access setting is unavailable'
    });
  }
}

function requireBrowserPublishCsrf(req, res, next) {
  if (req.homepageAccessMode === 'locked') {
    return requireCsrf(req, res, next);
  }

  if (req.homepageAccessMode === 'public' || req.homepageAccessMode === 'auth-disabled') {
    return next();
  }

  return res.status(503).json({
    success: false,
    error: 'Homepage access setting is unavailable'
  });
}

function requireBrowserPublishSession(req, res, next) {
  if (getPublishSessionId(req)) {
    req.publishNamespace = resolveBrowserPublishSessionNamespace(req);
    return next();
  }

  // Auth-disabled mode has no homepage gate in front of API clients (local
  // development and tests): mint a session lazily instead of failing the
  // request. The browser flow always passes through GET / first, where the
  // session is established before the first possibly-lost submit.
  if (req.homepageAccessMode === 'auth-disabled') {
    const sid = setPublishSessionCookie(res);
    req.publishNamespace = resolveBrowserPublishNamespace(sid);
    return next();
  }

  // Public and locked homepage modes require the pre-established session:
  // without it there is no safe replay identity, so creation is refused
  // instead of silently risking a duplicate on a lost response.
  return res.status(403).json({
    success: false,
    code: 'PUBLISH_SESSION_REQUIRED',
    error: '发布会话缺失或已过期，请刷新页面后重试'
  });
}

function requireApiAdmin(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const session = getAdminSession(req);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  req.adminSession = session;
  return next();
}

function requireDashboardAdmin(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const session = getDashboardAdminSession(req);

  if (!session) {
    return res.redirect('/admin/login');
  }

  req.dashboardAdminSession = session;
  return next();
}

function requireDashboardApiAdmin(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const session = getDashboardAdminSession(req);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  req.dashboardAdminSession = session;
  return next();
}

function requireCsrf(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const sessionToken = req.adminSession?.token || req.cookies?.[ADMIN_COOKIE];
  const csrfToken = req.get('x-csrf-token') || req.body?._csrf;

  if (!verifyCsrfToken(sessionToken, csrfToken)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token'
    });
  }

  return next();
}

function requireDashboardCsrf(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE];
  const csrfToken = req.get('x-csrf-token') || req.body?._csrf;

  if (!verifyCsrfToken(sessionToken, csrfToken)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token'
    });
  }

  return next();
}

function sendApiReadUnavailable(res) {
  return res.status(503).json({
    success: false,
    code: 'API_READ_UNAVAILABLE',
    requestId: null,
    retryable: true,
    error: 'Share data is temporarily unavailable'
  });
}

function markApiResourceReadEndpoint(req, res, next) {
  req.apiResourceReadEndpoint = true;
  return next();
}

function sendApiContentUpdateError(req, res, status, code, error, retryable = false) {
  return res.status(status).json({
    success: false,
    code,
    requestId: isvalidRequestId(req.apiUpdateRequestId) ? req.apiUpdateRequestId : null,
    retryable,
    error
  });
}

function sendApiRevisionError(req, res, status, code, error, retryable = false, details = {}) {
  return res.status(status).json({
    success: false,
    code,
    requestId: isvalidRequestId(req.apiUpdateRequestId) ? req.apiUpdateRequestId : null,
    retryable,
    ...details,
    error
  });
}

function markApiRevisionEndpoint({ write = false } = {}) {
  return (req, res, next) => {
    req.apiRevisionEndpoint = true;
    if (write) {
      req.apiContentUpdateEndpoint = true;
      req.apiUpdateRequestId = req.get('Idempotency-Key');
    }
    return next();
  };
}

function sendApiPublishError(req, res, status, code, error, retryable = false, details = {}) {
  return res.status(status).json({
    success: false,
    code,
    requestId: isvalidRequestId(req.apiPublishRequestId) ? req.apiPublishRequestId : null,
    retryable,
    ...details,
    error
  });
}

function markApiPublishStateEndpoint({ write = false } = {}) {
  return (req, res, next) => {
    req.apiPublishStateEndpoint = true;
    if (write) req.apiPublishRequestId = req.get('Idempotency-Key');
    return next();
  };
}

async function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');

  if (!key) {
    if (req.apiPublishStateEndpoint) {
      return sendApiPublishError(req, res, 401, 'INVALID_API_KEY', 'Missing X-API-Key header');
    }
    if (req.apiContentUpdateEndpoint || req.apiRevisionEndpoint) {
      return sendApiContentUpdateError(req, res, 401, 'INVALID_API_KEY', 'Missing X-API-Key header');
    }
    return res.status(401).json({ success: false, error: 'Missing X-API-Key header' });
  }

  if (config.shareApiKey) {
    const expected = Buffer.from(config.shareApiKey);
    const provided = Buffer.from(key);

    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      // Legacy keys stay create-only forever (#24 §6); scopes make that
      // contract explicit to the resource APIs and discovery.
      req.apiKeyIdentity = Object.freeze({ credentialKind: 'legacy', scopes: CREATE_ONLY_SCOPES });
      return next();
    }
  }

  const match = /^qs\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,})$/.exec(key);

  if (!match) {
    if (req.apiPublishStateEndpoint) {
      return sendApiPublishError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
    }
    if (req.apiContentUpdateEndpoint || req.apiRevisionEndpoint) {
      return sendApiContentUpdateError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
    }
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  try {
    const apiKey = await pageRepository.getApiKeyById(match[1]);
    // Capture the version paired with the FIRST hash read, before async scrypt.
    const identity = apiKey ? managedIdentity(apiKey) : null;
    const isValid = apiKey && await verifySecret(match[2], apiKey.key_hash);

    if (!isValid) {
      if (req.apiPublishStateEndpoint) {
        return sendApiPublishError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
      }
      if (req.apiContentUpdateEndpoint || req.apiRevisionEndpoint) {
        return sendApiContentUpdateError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
      }
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    req.apiKeyIdentity = identity;

    pageRepository.touchApiKey(apiKey.id).catch((error) => {
      console.error('API key usage update failed:', error);
    });

    return next();
  } catch (error) {
    console.error('API key validation failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    if (req.apiResourceReadEndpoint) {
      return sendApiReadUnavailable(res);
    }
    if (req.apiPublishStateEndpoint) {
      return sendApiPublishError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'API authentication unavailable', true);
    }
    if (req.apiContentUpdateEndpoint || req.apiRevisionEndpoint) {
      return sendApiContentUpdateError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'API authentication unavailable', true);
    }
    return res.status(503).json({ success: false, error: 'API authentication unavailable' });
  }
}

/**
 * Scope gate for the read-only resource APIs (#36). Authenticated credential
 * without the required scope is 403 — the key exists but may not even ask
 * for this operation family. Legacy keys carry create-only scopes, so they
 * are refused here without ever reaching grant checks.
 */
function requireScope(scope) {
  return (req, res, next) => {
    const identity = req.apiKeyIdentity || {};
    if (!Array.isArray(identity.scopes) || !identity.scopes.includes(scope)) {
      return res.status(403).json({
        success: false,
        code: 'SCOPE_REQUIRED',
        scope,
        retryable: false,
        error: '当前凭据缺少所需 scope'
      });
    }
    return next();
  };
}

function requireApiRevisionScopes(scopes) {
  return (req, res, next) => {
    const granted = req.apiKeyIdentity?.scopes || [];
    const missing = scopes.find(scope => !granted.includes(scope));
    if (missing) {
      return sendApiRevisionError(req, res, 403, 'SCOPE_REQUIRED', `当前凭据缺少所需 scope: ${missing}`, false, { scope: missing });
    }
    return next();
  };
}

function requireApiStateScope(req, res, next) {
  const scopes = req.apiKeyIdentity?.scopes || [];
  if (scopes.includes(READ_SCOPE) || scopes.includes(PUBLISH_SCOPE)) return next();
  return res.status(403).json({
    success: false,
    code: 'SCOPE_REQUIRED',
    scopesAnyOf: [READ_SCOPE, PUBLISH_SCOPE],
    retryable: false,
    error: '当前凭据缺少读取 Share 状态所需的 scope'
  });
}

function requireApiPublishScope(req, res, next) {
  if (req.apiKeyIdentity?.scopes?.includes(PUBLISH_SCOPE)) return next();
  return sendApiPublishError(req, res, 403, 'SCOPE_REQUIRED', '当前凭据缺少所需 scope: share:publish', false, { scope: PUBLISH_SCOPE });
}

function requireAccessBaselineFor(shareId, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw accessError(428, 'If-Match access ETag is required');
  }
  const value = String(raw).trim();
  const match = /^\"access:([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,18})\"$/.exec(value);
  if (!match || match[1] !== shareId) {
    throw accessError(400, 'If-Match must be one concrete strong access ETag for this Share');
  }
  requireAccessRevision(match[2]);
  return { shareId: match[1], revision: match[2] };
}

function validateApiPublishStateHeaders(req, res, next) {
  const requestId = req.get('Idempotency-Key');
  req.apiPublishRequestId = requestId;
  if (requestId === undefined || requestId === '') {
    return sendApiPublishError(req, res, 428, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }
  if (!isvalidRequestId(requestId)) {
    return sendApiPublishError(req, res, 400, 'INVALID_REQUEST_ID', INVALID_REQUEST_ID_MESSAGE);
  }
  try {
    req.apiPublishBaseline = requireAccessBaselineFor(req.params.id, req.get('If-Match'));
  } catch (error) {
    return sendApiPublishError(req, res, error.status || 400, error.code || 'INVALID_ACCESS_REVISION', error.message);
  }
  return next();
}

function parseApiPublishStateJson(req, res, next) {
  const mediaType = String(req.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return sendApiPublishError(req, res, 400, 'INVALID_PUBLISH_STATE_INPUT', '上下架请求必须使用 application/json 空对象');
  }
  return parseSmallJson(req, res, error => {
    if (error?.type === 'entity.too.large') {
      return sendApiPublishError(req, res, 413, 'PAYLOAD_TOO_LARGE', '请求内容超过 small request body limit');
    }
    if (error?.type === 'entity.parse.failed') {
      return sendApiPublishError(req, res, 400, 'INVALID_JSON', 'Invalid JSON body');
    }
    return next(error);
  });
}

function validateApiPublishStateBody(req, res, next) {
  const body = req.body;
  if (body === undefined) {
    const contentLength = Number(req.get('Content-Length') || 0);
    const contentType = req.get('Content-Type');
    if (contentLength > 0 || req.get('Transfer-Encoding')
      || (contentType && !req.is('application/json') && !req.is('application/*+json'))) {
      return sendApiPublishError(req, res, 400, 'INVALID_PUBLISH_STATE_INPUT', '上下架请求体必须为空或空 JSON 对象');
    }
    return next();
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return next();
  return sendApiPublishError(req, res, 400, 'INVALID_PUBLISH_STATE_INPUT', '上下架请求体必须为空对象，不能包含内容或访问策略字段');
}

function validateApiRestoreHeaders(req, res, next) {
  const requestId = req.get('Idempotency-Key');
  req.apiUpdateRequestId = requestId;
  if (requestId === undefined || requestId === '') {
    return sendApiRevisionError(req, res, 428, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }
  if (!isvalidRequestId(requestId)) {
    return sendApiRevisionError(req, res, 400, 'INVALID_REQUEST_ID', INVALID_REQUEST_ID_MESSAGE);
  }
  try {
    req.apiUpdateBaseline = requireContentBaselineFor(req.params.id, req.get('If-Match'));
  } catch (error) {
    return sendApiRevisionError(req, res, error.status || 400, error.code || 'INVALID_CONTENT_REVISION', error.message);
  }
  return next();
}

function parseApiRestoreInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'revision')) {
    return { error: '恢复请求必须只包含 revision 字段' };
  }
  const raw = input.revision;
  const revision = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
    ? String(raw)
    : raw;
  if (!isContentRevision(revision)) {
    return { error: '恢复来源版本必须是正整数或规范十进制字符串' };
  }
  return { revision };
}

function validateApiContentUpdateHeaders(req, res, next) {
  const requestId = req.get('Idempotency-Key');
  req.apiUpdateRequestId = requestId;
  if (requestId === undefined || requestId === '') {
    return sendApiContentUpdateError(req, res, 428, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }
  if (!isvalidRequestId(requestId)) {
    return sendApiContentUpdateError(req, res, 400, 'INVALID_REQUEST_ID', INVALID_REQUEST_ID_MESSAGE);
  }
  try {
    req.apiUpdateBaseline = requireContentBaselineFor(req.params.id, req.get('If-Match'));
  } catch (error) {
    return sendApiContentUpdateError(req, res, error.status || 400, error.code || 'INVALID_CONTENT_REVISION', error.message);
  }
  return next();
}

function requireApiContentUpdateScopes(req, res, next) {
  const scopes = req.apiKeyIdentity?.scopes || [];
  const missing = [READ_SCOPE, 'share:update'].find(scope => !scopes.includes(scope));
  if (missing) {
    return sendApiContentUpdateError(req, res, 403, 'SCOPE_REQUIRED', `当前凭据缺少所需 scope: ${missing}`);
  }
  return next();
}

function parseApiContentUpdateJson(req, res, next) {
  return parseShareJson(req, res, error => {
    if (error?.type === 'entity.too.large') {
      return sendApiContentUpdateError(req, res, 413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    }
    if (error?.type === 'entity.parse.failed') {
      return sendApiContentUpdateError(req, res, 400, 'INVALID_JSON', 'Invalid JSON body');
    }
    return next(error);
  });
}

function parseApiRestoreJson(req, res, next) {
  return parseSmallJson(req, res, error => {
    if (error?.type === 'entity.too.large') {
      return sendApiRevisionError(req, res, 413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    }
    if (error?.type === 'entity.parse.failed') {
      return sendApiRevisionError(req, res, 400, 'INVALID_JSON', 'Invalid JSON body');
    }
    return next(error);
  });
}

/**
 * Grant-missing and Share-missing answer identically (#24 §6): a 404 that
 * never reveals whether the instance holds the target Share.
 */
function sendShareNotFound(res) {
  return res.status(404).json({
    success: false,
    code: 'SHARE_NOT_FOUND',
    retryable: false,
    error: 'Share 不存在或没有对它的授权'
  });
}

/**
 * List cursor (#36): base64url(JSON {t: created_at ms, i: share id}) of the
 * previous page's last row. Carries no secret and no sort fragment; any
 * malformed input is a 400 instead of a degraded scan.
 */
function parseShareListCursor(raw) {
  if (raw === undefined || raw === null || String(raw) === '') return { cursor: null };
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    return { error: 'cursor 无效' };
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { error: 'cursor 无效' };
  const { t, i } = decoded;
  if (typeof t !== 'string' || !/^[0-9]{1,15}$/.test(t)) return { error: 'cursor 无效' };
  if (typeof i !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(i)) return { error: 'cursor 无效' };
  return { cursor: { cursorCreatedAt: t, cursorId: i } };
}

function encodeShareListCursor(row) {
  return Buffer.from(JSON.stringify({ t: String(row.created_at), i: row.id }), 'utf8').toString('base64url');
}

function parseShareListLimit(raw) {
  if (raw === undefined || raw === null || String(raw) === '') return 20;
  if (!/^[0-9]{1,4}$/.test(String(raw))) return { error: 'limit 必须是 1-100 的整数' };
  const value = Number.parseInt(String(raw), 10);
  if (value < 1 || value > 100) return { error: 'limit 必须是 1-100 的整数' };
  return value;
}

function parseRevisionHistoryCursor(raw) {
  if (raw === undefined || raw === null || String(raw) === '') return { cursor: null };
  const token = String(raw);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return { error: 'cursor 无效' };
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const value = JSON.parse(decoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !isContentRevision(value.revision)
      || Buffer.from(JSON.stringify({ revision: value.revision }), 'utf8').toString('base64url') !== token) {
      return { error: 'cursor 无效' };
    }
    return { cursor: value.revision };
  } catch {
    return { error: 'cursor 无效' };
  }
}

function encodeRevisionHistoryCursor(revision) {
  return Buffer.from(JSON.stringify({ revision: String(revision) }), 'utf8').toString('base64url');
}

function apiRevisionMetadata(page, row) {
  const revision = String(row.revision);
  const purged = row.purged_at !== null && row.purged_at !== undefined;
  return {
    revision,
    createdAt: Number(row.created_at),
    source: row.source || null,
    restoredFrom: row.restored_from === null || row.restored_from === undefined ? null : String(row.restored_from),
    current: String(page.current_revision) === revision,
    purged,
    ...(purged ? { purgedAt: Number(row.purged_at) } : {})
  };
}

/**
 * Metadata projection of a granted Share (#36). Allow-list by field: never
 * password/encrypted_password, never grant tables, never Favorite state,
 * never view counts. Revisions travel as decimal strings (BIGINT safety).
 */
function grantedShareProjection(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    codeType: row.code_type,
    title: row.title,
    description: row.description,
    markdownTheme: row.markdown_theme,
    currentRevision: String(row.current_revision),
    accessRevision: String(row.access_revision),
    published: row.published !== false,
    isProtected: row.is_protected === 1,
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at)
  };
}

async function verifyAdminPassword(password) {
  if (!password) {
    return false;
  }

  if (config.adminPasswordHash) {
    return verifySecret(password, config.adminPasswordHash);
  }

  if (!config.authPassword) {
    return false;
  }

  return verifySecret(password, config.authPassword);
}

async function verifyDashboardAdminPassword(password) {
  if (!password) {
    return false;
  }

  if (config.adminDashboardPasswordHash) {
    return verifySecret(password, config.adminDashboardPasswordHash);
  }

  if (!config.adminDashboardPassword) {
    return false;
  }

  return verifySecret(password, config.adminDashboardPassword);
}

function setAdminCookie(res) {
  const token = createScopedToken('admin', {}, ADMIN_TTL_MS);

  res.cookie(ADMIN_COOKIE, token, {
    maxAge: ADMIN_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });

  return token;
}

function setDashboardAdminCookie(res) {
  const token = createScopedToken('dashboard-admin', {}, ADMIN_TTL_MS);

  res.cookie(DASHBOARD_ADMIN_COOKIE, token, {
    maxAge: ADMIN_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });

  return token;
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
}

function clearDashboardAdminCookie(res) {
  res.clearCookie(DASHBOARD_ADMIN_COOKIE, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
}

function pageAccessCookieName(id) {
  return `page_access_${id}`;
}

function setPageAccessCookie(res, id, accessRevision) {
  const token = createScopedToken('page-access', { id, accessRevision }, PAGE_ACCESS_TTL_MS);

  res.cookie(pageAccessCookieName(id), token, {
    maxAge: PAGE_ACCESS_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
}

// Browser publish sessions (#24 §8, #32): an independently signed session
// cookie gives every browser creator a stable replay namespace that exists
// BEFORE the first submit whose response could be lost. It carries no
// management privilege; the request id itself is never a credential.
function setPublishSessionCookie(res) {
  const sid = generateId(12);
  const token = createScopedToken('publish-session', { sid }, ADMIN_TTL_MS);

  res.cookie(PUBLISH_SESSION_COOKIE, token, {
    maxAge: ADMIN_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });

  return sid;
}

function getPublishSessionId(req) {
  const payload = verifyScopedToken(req.cookies?.[PUBLISH_SESSION_COOKIE], 'publish-session');

  return typeof payload?.sid === 'string' && payload.sid ? payload.sid : null;
}

function resolveBrowserPublishSessionNamespace(req) {
  return resolveBrowserPublishNamespace(getPublishSessionId(req));
}

function resolveDashboardCloneNamespace(req) {
  return resolveDashboardSessionNamespace(dashboardSessionFingerprint(req));
}

function dashboardSessionFingerprint(req) {
  const token = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE];
  if (!token) {
    // Auth-disabled single-user mode (local development/tests): one shared
    // dashboard namespace; no cookie exists to fingerprint.
    return 'auth-disabled';
  }
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function resolveApiNamespace(req) {
  const identity = req.apiKeyIdentity || {};
  if (identity.credentialKind === 'managed') {
    return resolveApiCredentialNamespace(identity);
  }
  return resolveApiCredentialNamespace({ credentialKind: 'legacy', legacySecret: req.get('x-api-key') });
}

function pageAccessRevision(req, id) {
  const token = req.cookies?.[pageAccessCookieName(id)];
  const payload = verifyScopedToken(token, 'page-access');

  return payload?.id === id && isAccessRevision(payload.accessRevision)
    ? payload.accessRevision : null;
}

function isSameOriginRequest(req) {
  const origin = req.get('origin');

  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(`${req.protocol}://${req.get('host')}`).origin;
  } catch (error) {
    return false;
  }
}

function normalizeCodeType(content, requestedCodeType) {
  if (VALID_CODE_TYPES.has(requestedCodeType)) {
    return requestedCodeType;
  }

  const detectedType = detectCodeType(content);
  return VALID_CODE_TYPES.has(detectedType) ? detectedType : 'html';
}

async function createPageWithRetry(data, repository) {
  // Collision-safe id generation lives with the publishing module so every
  // creation entry shares one implementation; ids are generated only AFTER a
  // request digest exists (digest-before-randomness, #24 §8).
  return createPageWithUniqueId(repository, data);
}

/**
 * Shared idempotent creation flow for the web and Share API entries.
 *
 * Order inside the transaction (fixed, #24 §8): maintenance gate → managed
 * key verification → operation lock → operation lookup → only then expiry
 * checks, source reads and any randomness. The digest is computed from the
 * normalized input BEFORE this call — before random ids, generated passwords,
 * timestamps or time-derived fallback titles exist — so a retry of the same
 * operation hashes identically and confirms the committed result.
 */
async function runIdempotentCreate({
  input,
  namespace,
  requestId,
  provenance,
  apiKeyIdentity,
  auditDetails,
  clientIp,
  buildResponse
}) {
  const normalized = normalizeCreateInput(input);
  if (normalized.error) {
    return (res) => res.status(400).json({ success: false, error: normalized.error });
  }

  const requestDigest = createRequestDigest(normalized.fields, { presence: normalized.presence });
  const publishingOperation = requestId
    ? { actorNamespace: namespace, requestId, action: 'create', targetId: null, requestDigest }
    : null;

  return publishing.run(async (repository, existingOperation) => {
    if (existingOperation) {
      const outcome = await classifyOperationReplay(repository, { record: existingOperation, requestDigest });

      if (outcome.kind === 'conflict') {
        return (res) => res.status(409).json({
          success: false,
          code: 'REQUEST_ID_CONFLICT',
          requestId,
          retryable: false,
          error: '同一请求标识对应了不同的请求内容'
        });
      }

      if (outcome.kind === 'result-unavailable') {
        return (res) => res.status(410).json({
          success: false,
          code: 'RESULT_UNAVAILABLE',
          requestId,
          retryable: false,
          error: '该操作已提交，但其结果已被永久删除'
        });
      }

      // #34: the creation's committed result revision was later purged. The
      // operation is confirmed but its result payload (and receipt) is gone;
      // answer result-unavailable without leaking receipt metadata.
      if (outcome.replayPurged) {
        return (res) => res.status(410).json({
          success: false,
          code: 'RESULT_UNAVAILABLE',
          requestId,
          retryable: false,
          error: '该操作已提交，但其结果版本已被清除，无法再次确认'
        });
      }

      // Confirmed replay: never re-executes writes. Every response metadata
      // field is the ORIGINAL committed result from the encrypted receipt —
      // a create replay never reads the owner's later edits. The generated
      // password replays only while the access policy is unchanged.
      const { result: originalResult, receiptPassword } = outcome;
      return (res) => buildResponse(res, {
        id: originalResult.id,
        password: receiptPassword,
        isProtected: originalResult.isProtected,
        codeType: originalResult.codeType,
        title: originalResult.title,
        description: originalResult.description,
        expiresAt: originalResult.expiresAt,
        markdownTheme: originalResult.markdownTheme
      }, true);
    }

    const result = await executeNormalizedCreate(repository, normalized.fields, provenance);
    if (result.error) {
      return (res) => res.status(400).json({ success: false, error: result.error });
    }

    if (apiKeyIdentity?.credentialKind === 'managed') {
      const key = await repository.getApiKeyById(apiKeyIdentity.id);
      if (!key) throw Object.assign(new Error('API key disappeared during creation'), { code: 'INVALID_API_KEY' });
      if (key.auto_grant_new_share_edit === true) {
        const grant = await repository.grantShareEdit({ apiKeyId: apiKeyIdentity.id, shareId: result.id });
        if (!['granted', 'unchanged'].includes(grant.status)) {
          throw new Error(`Could not atomically grant edit access to created Share (${grant.status})`);
        }
        await repository.createAuditLog({
          action: 'api_key.grant',
          pageId: result.id,
          details: JSON.stringify({ apiKeyId: apiKeyIdentity.id, shareId: result.id, grants: ['read', 'update'], source: 'auto-grant' }),
          ip: clientIp
        });
      }
    }

    await repository.createAuditLog({
      action: 'page.create',
      pageId: result.id,
      details: JSON.stringify(typeof auditDetails === 'function' ? auditDetails(result) : auditDetails),
      ip: clientIp
    });

    if (publishingOperation) {
      // Same transaction as the Share, its baseline Revision and this audit
      // entry; the unique constraint is the final dedupe guard.
      await repository.createPublishingOperation(
        buildCreationOperationRecord({ actorNamespace: namespace, requestId, requestDigest, result })
      );
    }

    return (res) => buildResponse(res, result, false);
  }, { apiKeyIdentity, publishingOperation });
}

function injectCodeTypeMeta(renderedContent, contentType) {
  if (!renderedContent.includes('</head>')) {
    return renderedContent;
  }

  return renderedContent.replace(
    '</head>',
    `<meta name="code-type" content="${escapeHtml(contentType)}">\n</head>`
  );
}

function renderSandboxedDocument(renderedContent, contentType, {
  title,
  description,
  pageUrl,
  socialImageUrl,
  viewEventUrl
} = {}) {
  const escapedContent = escapeHtml(renderedContent);
  const pageTitle = title ? `${escapeHtml(title)} - QuickShare` : 'QuickShare';
  const ogDescription = description ? escapeHtml(description) : '通过 QuickShare 分享的内容';
  const ogUrl = pageUrl ? escapeHtml(pageUrl) : '';

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="code-type" content="${escapeHtml(contentType)}">
      <title>${pageTitle}</title>
      <link rel="icon" href="/icon/web/favicon.ico?v=${FAVICON_VERSION}" sizes="any">
      <link rel="apple-touch-icon" href="/icon/web/apple-touch-icon.png?v=${FAVICON_VERSION}">
      <link rel="icon" type="image/png" sizes="192x192" href="/icon/web/icon-192.png?v=${FAVICON_VERSION}">
      <link rel="icon" type="image/png" sizes="512x512" href="/icon/web/icon-512.png?v=${FAVICON_VERSION}">
      <meta property="og:title" content="${pageTitle}">
      <meta property="og:description" content="${ogDescription}">
      <meta property="og:type" content="article">
      ${ogUrl ? `<meta property="og:url" content="${ogUrl}">` : ''}
      <meta property="og:image" content="${escapeHtml(socialImageUrl)}">
      <meta property="og:image:type" content="image/png">
      <meta property="og:image:width" content="512">
      <meta property="og:image:height" content="512">
      <meta property="og:image:alt" content="QuickShare Site Identity Icon">
      <meta name="twitter:card" content="summary">
      <meta name="twitter:title" content="${pageTitle}">
      <meta name="twitter:description" content="${ogDescription}">
      ${pageUrl ? '<script defer src="https://umami.namooca.com/script.js" data-website-id="c5b79d49-f1e7-46c1-87c7-b2965383c820"></script>' : ''}
      <style>
        html, body {
          width: 100%;
          height: 100%;
          margin: 0;
          background: #ffffff;
        }
        iframe {
          width: 100%;
          height: 100vh;
          border: 0;
          display: block;
        }
      </style>
    </head>
    <body>
      <iframe
        title="Shared content"
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
        referrerpolicy="no-referrer"
        srcdoc="${escapedContent}">
      </iframe>
      ${viewEventUrl ? `<script src="/js/view-event.js" data-view-event-url="${escapeHtml(viewEventUrl)}"></script>` : ''}
    </body>
    </html>
  `;
}

async function prepareSandboxContent(rawContent, requestedCodeType, markdownTheme) {
  let processedContent = rawContent;
  let contentType = normalizeCodeType(rawContent, requestedCodeType);
  const codeBlocks = extractCodeBlocks(rawContent);

  if (codeBlocks.length === 1 && codeBlocks[0].content.length > rawContent.length * 0.7) {
    processedContent = codeBlocks[0].content;
    contentType = VALID_CODE_TYPES.has(codeBlocks[0].type) ? codeBlocks[0].type : 'html';
  }

  const renderedContent = await renderContent(processedContent, contentType, markdownTheme);

  return {
    contentType,
    renderedContent: injectCodeTypeMeta(renderedContent, contentType)
  };
}

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

function publicPageUrl(req, id) {
  return `${publicOrigin(req)}/view/${encodeURIComponent(id)}`;
}

function publicOrigin(req) {
  const base = config.shareBaseUrl || config.baseUrl || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '');
}

function socialImageUrl(req) {
  return `${publicOrigin(req)}${SOCIAL_IMAGE_PATH}?v=${SOCIAL_IMAGE_VERSION}`;
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
  // Establish the signed publish session before any submit: the browser
  // cannot rely on a Set-Cookie riding along the creation response, because
  // exactly that response is the one a network retry may never see.
  let sid = getPublishSessionId(req);
  if (!sid) {
    sid = setPublishSessionCookie(res);
  }
  // EVERY render carries the current session's stable NON-SECRET tag (short
  // hash of the random sid). Pending request identities bind to it on the
  // browser side, so a session replaced anywhere else (cookie cleared,
  // expired, rotated in another tab) is DETECTED on this tab's next load —
  // including when this load did not mint the session.
  const publishSessionTag = createHash('sha256')
    .update(`quickshare:publish-session-tag:${sid}`)
    .digest('hex')
    .slice(0, 16);
  const sessionToken = req.adminSession?.token || req.cookies?.[ADMIN_COOKIE] || '';

  return res.render('index', {
    title: 'QuickShare | 粘贴代码，一键分享',
    page: 'home-page',
    csrfToken: req.homepageAccessMode === 'locked' ? createCsrfToken(sessionToken) : '',
    markdownThemeOptions: getMarkdownThemeOptions(),
    socialImageUrl: socialImageUrl(req),
    publishSessionTag
  });
});

app.get('/admin', (req, res) => {
  if (!config.authEnabled || getDashboardAdminSession(req)) {
    return res.redirect('/admin/stats');
  }

  return res.redirect('/admin/login');
});

app.get('/admin/apis', requireDashboardAdmin, async (req, res) => {
  try {
    const apiKeys = await pageRepository.listApiKeys();
    // Grants travel with the page render (#36): each key row renders its own
    // read-grant controls without an extra discovery endpoint.
    const grantsByApiKey = new Map();
    for (const apiKey of apiKeys) {
      grantsByApiKey.set(apiKey.id, await pageRepository.listShareGrantsForKey(apiKey.id));
    }
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-apis', {
      title: 'QuickShare | API 管理',
      page: 'admin-apis',
      apiKeys,
      grantsByApiKey,
      capabilities,
      legacyApiKeyConfigured: Boolean(config.shareApiKey),
      csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : ''
    });
  } catch (error) {
    console.error('API management page failed:', error);
    return res.status(500).render('error', {
      title: 'Server Error',
      page: 'error-page',
      message: 'Unable to load API management'
    });
  }
});

app.post('/admin/apis/keys', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const name = String(req.body?.name || '').trim();

      if (!name || name.length > 80) {
        return (res) => res.status(400).json({
          success: false,
          error: 'Key name must be between 1 and 80 characters'
        });
      }

      const id = generateId(12);
      const secret = randomBytes(32).toString('base64url');
      const apiKey = await repository.createApiKey({
        id,
        name,
        keyHash: await hashSecret(secret),
        keyPrefix: `qs.${id.slice(0, 8)}…`,
        createdAt: Date.now(),
        // New keys start create-only (#36): read access comes exclusively
        // from explicit per-Share grants the owner grants afterwards.
        scopes: ['share:create'],
        autoGrantNewShareEdit: false
      });

      await repository.createAuditLog({
        action: 'api_key.create',
        pageId: null,
        details: JSON.stringify({ apiKeyId: apiKey.id, name: apiKey.name }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return (res) => res.status(201).json({
        success: true,
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          key_prefix: apiKey.key_prefix,
          created_at: apiKey.created_at,
          last_used_at: apiKey.last_used_at,
          credential_version: apiKey.credential_version,
          scopes: apiKey.scopes,
          auto_grant_new_share_edit: apiKey.auto_grant_new_share_edit === true,
          secret: `qs.${id}.${secret}`
        }
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Create API key failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create API key'
    });
  }
});

app.post('/admin/apis/keys/:id/rotate', privateNoStore, requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const secret = randomBytes(32).toString('base64url');
      const apiKey = await repository.rotateApiKey(req.params.id, await hashSecret(secret));
      if (!apiKey) return res => res.status(404).json({ success: false, error: 'API key not found' });
      await repository.createAuditLog({
        action: 'api_key.rotate', pageId: null,
        details: JSON.stringify({ apiKeyId: apiKey.id, credentialVersion: apiKey.credential_version }),
        ip: req.ip
      });
      return res => res.json({ success: true, apiKey: { ...apiKey, secret: `qs.${apiKey.id}.${secret}` } });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Rotate API key failed:', { name: error?.name, code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: 'Failed to rotate API key' });
  }
});

// Per-Share read grant (#36): owner grants a specific Key read access to a
// specific Share over Cookie + CSRF. Missing Key OR Share is 404; a duplicate
// grant is a no-op (changed:false), not a new audit event. The §8 lock order
// (Key row → Share row) lives inside the repository method.
app.post('/admin/apis/keys/:id/grants', privateNoStore, requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some(field => !['shareId', 'canRead', 'canUpdate', 'canPublish'].includes(field))
        || ['canRead', 'canUpdate', 'canPublish'].some(field => req.body[field] !== undefined && typeof req.body[field] !== 'boolean')) {
        return (res) => res.status(400).json({ success: false, error: '授权请求字段无效' });
      }
      const shareId = String(req.body.shareId || '').trim();

      if (!/^[A-Za-z0-9_-]{1,64}$/.test(shareId)) {
        return (res) => res.status(400).json({ success: false, error: 'shareId 无效' });
      }

      const canUpdate = req.body.canUpdate === true;
      const canPublish = req.body.canPublish === true;
      const permissionFieldsSupplied = ['canRead', 'canUpdate', 'canPublish']
        .some(field => Object.prototype.hasOwnProperty.call(req.body, field));
      const legacyReadDefault = req.body.canUpdate === false
        && req.body.canRead === undefined && req.body.canPublish === undefined;
      const canRead = canUpdate || req.body.canRead === true || !permissionFieldsSupplied || legacyReadDefault;
      if ((req.body.canRead === false && canUpdate) || (!canRead && !canPublish)) {
        return (res) => res.status(400).json({ success: false, error: '至少选择读取、编辑或上下架授权；编辑权包含读取权' });
      }

      const outcomes = [];
      if (canRead || canUpdate) {
        outcomes.push(canUpdate
          ? await repository.grantShareEdit({ apiKeyId: req.params.id, shareId })
          : await repository.grantShareRead({ apiKeyId: req.params.id, shareId }));
      }
      if (canPublish) outcomes.push(await repository.grantSharePublish({ apiKeyId: req.params.id, shareId }));

      const missing = outcomes.find(outcome => outcome.status === 'key-not-found' || outcome.status === 'share-not-found');
      if (missing?.status === 'key-not-found') {
        return (res) => res.status(404).json({ success: false, error: 'API key not found' });
      }
      if (missing?.status === 'share-not-found') return (res) => sendShareNotFound(res);

      const changed = outcomes.some(outcome => outcome.status === 'granted');
      if (changed) {
        await repository.createAuditLog({
          action: 'api_key.grant',
          pageId: shareId,
          details: JSON.stringify({
            apiKeyId: req.params.id,
            shareId,
            grants: [...(canRead ? ['read'] : []), ...(canUpdate ? ['update'] : []), ...(canPublish ? ['publish'] : [])]
          }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }

      const scopes = (await repository.getApiKeyById(req.params.id))?.scopes || [];
      const currentGrant = await repository.getShareGrant(req.params.id, shareId);
      const grantProjection = {
        apiKeyId: req.params.id,
        shareId,
        canRead: currentGrant?.can_read === true,
        canUpdate: currentGrant?.can_update === true,
        ...(currentGrant?.can_publish === true ? { canPublish: true } : {})
      };
      return (res) => res.status(changed ? 201 : 200).json({
        success: true,
        changed,
        grant: grantProjection,
        scopes
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Grant share read failed:', { name: error?.name, code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: '授权失败' });
  }
});

app.put('/admin/apis/keys/:id/grants/:shareId', privateNoStore, requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async repository => {
      const validBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        && Object.keys(req.body).length === 1
        && (typeof req.body.canUpdate === 'boolean' || typeof req.body.canPublish === 'boolean');
      if (!validBody) {
        return response => response.status(400).json({ success: false, error: '请求必须且只能包含布尔 canUpdate 或 canPublish' });
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.shareId)) {
        return response => response.status(400).json({ success: false, error: 'shareId 无效' });
      }
      const isPublishToggle = Object.prototype.hasOwnProperty.call(req.body, 'canPublish');
      const enabled = isPublishToggle ? req.body.canPublish : req.body.canUpdate;
      const outcome = isPublishToggle
        ? await repository.setSharePublish({ apiKeyId: req.params.id, shareId: req.params.shareId, canPublish: enabled })
        : await repository.setShareEdit({ apiKeyId: req.params.id, shareId: req.params.shareId, canUpdate: enabled });
      if (outcome.status === 'key-not-found') {
        return response => response.status(404).json({ success: false, error: 'API key not found' });
      }
      if (outcome.status === 'share-not-found') return response => sendShareNotFound(response);
      const changed = outcome.status === 'granted' || outcome.status === 'updated';
      if (changed) {
        await repository.createAuditLog({
          action: enabled ? 'api_key.grant' : 'api_key.revoke',
          pageId: req.params.shareId,
          details: JSON.stringify({
            apiKeyId: req.params.id,
            shareId: req.params.shareId,
            grants: isPublishToggle ? ['publish'] : (enabled ? ['read', 'update'] : ['update'])
          }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }
      const grant = await repository.getShareGrant(req.params.id, req.params.shareId);
      const scopes = (await repository.getApiKeyById(req.params.id))?.scopes || [];
      const grantProjection = grant ? {
        apiKeyId: req.params.id,
        shareId: req.params.shareId,
        canRead: grant.can_read === true,
        canUpdate: grant.can_update === true,
        ...((isPublishToggle || grant.can_publish === true) ? { canPublish: grant.can_publish === true } : {})
      } : null;
      return response => response.json({
        success: true,
        changed,
        grant: grantProjection,
        scopes
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Set share edit grant failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: '更新编辑授权失败' });
  }
});

app.put('/admin/apis/keys/:id/auto-grant-edit', privateNoStore, requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async repository => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') {
        return response => response.status(400).json({ success: false, error: 'enabled 必须是布尔值' });
      }
      const outcome = await repository.setApiKeyAutoGrantNewShareEdit({
        apiKeyId: req.params.id, enabled: req.body.enabled
      });
      if (outcome.status === 'key-not-found') {
        return response => response.status(404).json({ success: false, error: 'API key not found' });
      }
      const changed = outcome.status === 'updated';
      if (changed) {
        await repository.createAuditLog({
          action: req.body.enabled ? 'api_key.auto_grant_new_share_edit.enable' : 'api_key.auto_grant_new_share_edit.disable',
          pageId: null,
          details: JSON.stringify({ apiKeyId: req.params.id, enabled: req.body.enabled }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }
      return response => response.json({ success: true, changed, autoGrantNewShareEdit: outcome.enabled });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Update auto-edit grant failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: '更新自动编辑授权失败' });
  }
});

// Revoke is idempotent (#36): an absent grant — including one already
// removed by a Share deletion cascade — is a 200 no-op.
//
// Explicit boundary (rework-r1 review observation): a revocation commits
// and governs every request authorized AFTER it; a read that already passed
// its grant check is not cancelled mid-flight. Later tickets needing
// revoke-cancels-in-flight semantics must introduce that serialization
// explicitly — it is deliberately out of #36 scope.
app.delete('/admin/apis/keys/:id/grants/:shareId', privateNoStore, requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const outcome = await repository.revokeShareRead({ apiKeyId: req.params.id, shareId: req.params.shareId });

      if (outcome.status === 'key-not-found') {
        return (res) => res.status(404).json({ success: false, error: 'API key not found' });
      }

      if (outcome.status === 'revoked') {
        await repository.createAuditLog({
          action: 'api_key.revoke',
          pageId: req.params.shareId,
          details: JSON.stringify({ apiKeyId: req.params.id, shareId: req.params.shareId, grants: ['read'] }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }

      if (outcome.status === 'dependent-grant') {
        return (res) => res.status(409).json({ success: false, error: '编辑授权依赖读取授权，不能单独撤回' });
      }

      const scopes = (await repository.getApiKeyById(req.params.id))?.scopes || [];
      const grant = await repository.getShareGrant(req.params.id, req.params.shareId);
      return (res) => res.json({
        success: true,
        changed: outcome.status === 'revoked',
        grant: grant ? {
          apiKeyId: req.params.id, shareId: req.params.shareId,
          canRead: grant.can_read === true, canUpdate: grant.can_update === true, canPublish: grant.can_publish === true
        } : null,
        scopes
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Revoke share read failed:', { name: error?.name, code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: '撤回授权失败' });
  }
});

app.delete('/admin/apis/keys/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const deleted = await repository.deleteApiKey(req.params.id);

      if (!deleted) {
        return (res) => res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      await repository.createAuditLog({
        action: 'api_key.delete',
        pageId: null,
        details: JSON.stringify({ apiKeyId: req.params.id }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return (res) => res.json({ success: true });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Delete API key failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete API key'
    });
  }
});

app.get('/admin/operations', requireDashboardAdmin, async (req, res) => {
  const requestId = String(req.query.requestId || '');
  if (!isvalidRequestId(requestId)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }

  try {
    // Owner oversight across namespaces: same request id in different
    // namespaces is listed separately and never conflated. Metadata only —
    // no receipt, no body, no password; the creator's own replay path is the
    // only way generated secrets come back.
    const records = await pageRepository.findPublishingOperationsByRequestId(requestId);

    return res.json({
      success: true,
      requestId,
      operations: records.map(operationStatusProjection)
    });
  } catch (error) {
    console.error('Admin operation lookup failed:', error);
    return res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.get('/admin/pages/export', requireDashboardAdmin, async (req, res) => {
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
    return res.json({ exportedAt: Date.now(), total: exportData.length, pages: exportData });
  } catch (error) {
    console.error('Export failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to export pages' });
  }
});

app.get('/admin/pages', requireDashboardAdmin, async (req, res) => {
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
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-pages', {
      title: 'QuickShare | 分享管理',
      page: 'admin-pages',
      csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : '',
      pages: visiblePages,
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

app.put('/admin/settings/homepage-access', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
  if (typeof req.body?.passwordRequired !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'passwordRequired must be a boolean'
    });
  }

  try {
    const result = await publishing.run(repository => repository.setHomepagePasswordRequired({
      passwordRequired: req.body.passwordRequired,
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    }));

    return res.json({
      success: true,
      passwordRequired: result.passwordRequired,
      changed: result.changed
    });
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Update homepage access setting failed:', error);
    return res.status(503).json({
      success: false,
      error: 'Homepage access setting is unavailable'
    });
  }
});

app.get('/admin/stats', requireDashboardAdmin, async (req, res) => {
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
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

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

app.get('/admin/audit', requireDashboardAdmin, async (req, res) => {
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

app.get('/admin/pages/:id', requireDashboardAdmin, async (req, res) => {
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
      accessRevision: sharedPage.access_revision,
      currentRevision: sharedPage.current_revision,
      published: sharedPage.published === true,
      password: visiblePagePassword(sharedPage),
      expiresAt: sharedPage.expires_at,
      markdownTheme: sharedPage.code_type === 'markdown'
        ? resolveMarkdownThemeId(sharedPage.markdown_theme)
        : null
    };
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-page-detail', {
      title: `QuickShare | ${sharedPage.id}`,
      page: 'admin-page-detail',
      csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : '',
      sharedPage: pageData,
      pageDataJson: serializeJsonForHtml(pageData),
      publicUrl: publicPageUrl(req, sharedPage.id),
      markdownThemeOptions: getMarkdownThemeOptions(),
      dashboardSessionTag: dashboardSessionFingerprint(req)
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

// ---- Owner history (#31): dashboard-only, read-only, metadata-first. ----
// Every surface below reads existing snapshots through bounded queries; none
// of them write, count views, touch policy fields or talk to public surfaces.

const HISTORY_DEFAULT_PAGE_SIZE = 20;
const HISTORY_MAX_PAGE_SIZE = 100;
const HISTORY_SOURCE_LABELS = {
  web: '网页创建',
  api: 'Share API',
  clone: '克隆',
  'dashboard-edit': '后台编辑',
  'dashboard-restore': '后台恢复',
  'title-backfill': '标题回填',
  'baseline-backfill': '基线回填'
};

function parseHistoryPagination(query) {
  const pageRaw = Number.parseInt(query.page, 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limitRaw = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, HISTORY_MAX_PAGE_SIZE)
    : HISTORY_DEFAULT_PAGE_SIZE;
  return { page, limit, offset: (page - 1) * limit };
}

function historyPageView(pagination, revisions, total) {
  const totalPages = Math.max(Math.ceil(Number(total) / pagination.limit), 1);
  return {
    page: pagination.page,
    limit: pagination.limit,
    total,
    totalPages,
    // Exact big-integer arithmetic: a total above 2^53 still yields correct
    // bounds without ever passing the revision count through Number ordering.
    hasNext: BigInt(pagination.offset) + BigInt(revisions.length) < BigInt(total),
    hasPrevious: pagination.page > 1 && BigInt(total) > 0n
  };
}

function buildHistoryUrl(id, page, limit) {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (limit !== HISTORY_DEFAULT_PAGE_SIZE) params.set('limit', String(limit));
  const query = params.toString();
  return `/admin/pages/${encodeURIComponent(id)}/history${query ? `?${query}` : ''}`;
}

function historyRevisionProjection(row) {
  const purged = row.purged_at !== null && row.purged_at !== undefined;
  return {
    revision: String(row.revision),
    createdAt: Number(row.created_at),
    source: row.source || null,
    restoredFrom: row.restored_from === null || row.restored_from === undefined ? null : String(row.restored_from),
    purged,
    ...(purged ? { purgedAt: Number(row.purged_at) } : {})
  };
}

app.get('/admin/pages/:id/history', requireDashboardAdmin, async (req, res) => {
  try {
    const sharedPage = await pageRepository.getById(req.params.id);

    if (!sharedPage) {
      return res.status(404).render('error', {
        title: 'Page Not Found',
        page: 'error-page',
        message: 'The requested shared page does not exist'
      });
    }

    const pagination = parseHistoryPagination(req.query);
    const { items, total } = await pageRepository.listContentRevisionPage(req.params.id, pagination);
    const revisions = items.map(historyRevisionProjection);
    const view = historyPageView(pagination, revisions, total);

    const historySessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-page-history', {
      title: `QuickShare | ${sharedPage.id} 历史版本`,
      page: 'admin-page-detail',
      csrfToken: config.authEnabled ? createCsrfToken(historySessionToken) : '',
      sharedPage: {
        id: sharedPage.id,
        title: sharedPage.title,
        codeType: sharedPage.code_type,
        currentRevision: String(sharedPage.current_revision)
      },
      revisions,
      pagination: view,
      sourceLabels: HISTORY_SOURCE_LABELS,
      dashboardSessionTag: dashboardSessionFingerprint(req),
      prevUrl: view.hasPrevious ? buildHistoryUrl(sharedPage.id, view.page - 1, view.limit) : null,
      nextUrl: view.hasNext ? buildHistoryUrl(sharedPage.id, view.page + 1, view.limit) : null,
      historyDataJson: serializeJsonForHtml({
        id: sharedPage.id,
        codeType: sharedPage.code_type,
        currentRevision: String(sharedPage.current_revision),
        revisions,
        pagination: view
      })
    });
  } catch (error) {
    console.error('Admin page history failed:', error);
    return res.status(500).render('error', {
      title: 'Server Error',
      page: 'error-page',
      message: 'Unable to load share history'
    });
  }
});

app.get('/admin/pages/:id/revisions', requireDashboardApiAdmin, async (req, res) => {
  try {
    const sharedPage = await pageRepository.getById(req.params.id);

    if (!sharedPage) {
      return res.status(404).json({ success: false, error: 'Share not found' });
    }

    const pagination = parseHistoryPagination(req.query);
    const { items, total } = await pageRepository.listContentRevisionPage(req.params.id, pagination);
    const revisions = items.map(historyRevisionProjection);

    return res.json({
      success: true,
      shareId: sharedPage.id,
      revisions,
      pagination: historyPageView(pagination, revisions, total)
    });
  } catch (error) {
    console.error('Admin revision list failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to list revisions' });
  }
});

app.get('/admin/pages/:id/revisions/:revision', requireDashboardApiAdmin, privateNoStore, async (req, res) => {
  try {
    if (!isContentRevision(req.params.revision)) {
      return res.status(400).json({ success: false, code: 'INVALID_CONTENT_REVISION', error: 'content revision must be a positive decimal string' });
    }

    const row = await pageRepository.getContentRevision(req.params.id, req.params.revision);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Revision not found' });
    }

    // #34: a purged tombstone is GONE, never empty content. The response
    // confirms only the non-content identity of the tombstone; no payload
    // byte and no snapshot hash returns, and the response stays unshared.
    if (row.purged_at !== null && row.purged_at !== undefined) {
      return res.status(410).json({
        success: false,
        code: 'REVISION_PURGED',
        error: '该版本内容已被永久清除，仅保留墓碑',
        revision: {
          shareId: row.share_id,
          revision: String(row.revision),
          createdAt: Number(row.created_at),
          source: row.source || null,
          restoredFrom: row.restored_from === null || row.restored_from === undefined ? null : String(row.restored_from),
          purged: true,
          purgedAt: Number(row.purged_at)
        }
      });
    }

    return res.json({
      success: true,
      revision: {
        shareId: row.share_id,
        revision: String(row.revision),
        htmlContent: row.html_content,
        codeType: row.code_type,
        title: row.title,
        description: row.description,
        markdownTheme: row.markdown_theme,
        createdAt: Number(row.created_at),
        snapshotHash: row.snapshot_hash,
        source: row.source || null,
        actor: row.actor || null,
        restoredFrom: row.restored_from === null || row.restored_from === undefined ? null : String(row.restored_from)
      }
    });
  } catch (error) {
    if (error.code === 'INVALID_CONTENT_REVISION') {
      return res.status(400).json({ success: false, code: error.code, error: error.message });
    }
    console.error('Admin revision read failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to read revision' });
  }
});

app.get('/admin/pages/:id/revisions/:revision/preview', requireDashboardAdmin, privateNoStore, async (req, res) => {
  try {
    if (!isContentRevision(req.params.revision)) {
      return res.status(400).render('error', {
        title: 'Invalid Revision',
        page: 'error-page',
        message: 'The requested content revision is invalid'
      });
    }

    const row = await pageRepository.getContentRevision(req.params.id, req.params.revision);
    if (!row) {
      return res.status(404).render('error', {
        title: 'Revision Not Found',
        page: 'error-page',
        message: 'The requested content revision does not exist'
      });
    }

    // #34: a purged tombstone has no renderable payload. The preview is a
    // 410 gone page carrying no payload-derived bytes.
    if (row.purged_at !== null && row.purged_at !== undefined) {
      return res.status(410).render('error', {
        title: 'Revision Purged',
        page: 'error-page',
        message: '该版本内容已被永久清除，仅保留墓碑，无法预览'
      });
    }

    // Same renderer and sandbox as the public view, but WITHOUT pageUrl (no
    // public analytics script) and WITHOUT viewEventUrl (no view counting).
    // The wrapper document is safe to open directly: the escaped srcdoc
    // iframe keeps the historical user content out of the management origin.
    const prepared = await prepareSandboxContent(row.html_content, row.code_type, row.markdown_theme);
    setTrustedUiCsp(res, { allowFraming: true });
    return res.send(renderSandboxedDocument(prepared.renderedContent, prepared.contentType, {
      title: `${row.title || row.share_id} · 版本 ${String(row.revision)} 历史预览`,
      description: row.description || '',
      socialImageUrl: ''
    }));
  } catch (error) {
    console.error('Admin revision preview failed:', error);
    return res.status(500).render('error', {
      title: 'Server Error',
      page: 'error-page',
      message: 'Unable to render revision preview'
    });
  }
});

app.put('/admin/pages/:id/favorite', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
  if (typeof req.body?.isFavorite !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'isFavorite must be a boolean'
    });
  }

  try {
    const respond = await publishing.run(async (repository) => {
      const result = await repository.setFavorite(req.params.id, req.body.isFavorite);

      if (!result.found) {
        return (res) => res.status(404).json({
          success: false,
          error: 'Share not found'
        });
      }

      if (result.changed) {
        await repository.createAuditLog({
          action: 'page.favorite.update',
          pageId: req.params.id,
          details: JSON.stringify({ from: result.previousValue, to: result.isFavorite }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }

      return (res) => res.json({
        success: true,
        changed: result.changed,
        isFavorite: result.isFavorite
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Update favorite failed:');
    return res.status(500).json({
      success: false,
      error: 'Failed to update favorite'
    });
  }
});

/**
 * Owner-facing projection of a Share row for content-save and restore
 * responses. Same shape for fresh results and confirmed replays so the
 * dashboard can consume both identically.
 */
function adminPageProjection(page) {
  return {
    id: page.id,
    title: page.title,
    description: page.description,
    htmlContent: page.html_content,
    codeType: page.code_type,
    isProtected: page.is_protected === 1,
    accessRevision: String(page.access_revision),
    currentRevision: String(page.current_revision),
    published: page.published === true,
    password: visiblePagePassword(page),
    expiresAt: page.expires_at,
    markdownTheme: page.markdown_theme,
    createdAt: page.created_at
  };
}

/**
 * Confirmed replay of a committed dashboard content-update or restore
 * (#24 §8): every content field comes from the committed result snapshot
 * (operation record + share_revisions), never from the owner's later
 * edits. The live row only decides whether the access policy is unchanged
 * — the same rule that gates generated-password replay on creates.
 */
function contentReplayResponse(outcome, { requestId, action }) {
  const { record, revisionRow, page: livePage, accessUnchanged } = outcome;
  const receipt = outcome.receipt || {};
  // #34: a committed result whose revision was LATER purged can never serve
  // the purged snapshot. The result payload must exist with real string
  // bytes; a tombstone (or any payload-less row) makes the committed result
  // unavailable — replay answers 410 without leaking receipt metadata and
  // without rebuilding anything.
  if (revisionRow.purged_at !== null && revisionRow.purged_at !== undefined
    || typeof revisionRow.html_content !== 'string') {
    return { replayPurged: true, record };
  }
  const page = adminPageProjection({
    id: record.result_share_id,
    title: revisionRow.title,
    description: revisionRow.description,
    html_content: revisionRow.html_content,
    code_type: revisionRow.code_type,
    markdown_theme: revisionRow.markdown_theme,
    is_protected: receipt.isProtected === true ? 1 : 0,
    encrypted_password: livePage.is_protected === 1 ? livePage.encrypted_password : null,
    access_revision: record.result_access_revision,
    current_revision: record.result_revision,
    expires_at: receipt.expiresAt === undefined ? null : receipt.expiresAt,
    created_at: livePage.created_at
  });
  if (!accessUnchanged) page.password = null;
  return (res) => res.json({
    success: true,
    replayed: true,
    action,
    ...(requestId ? { requestId } : {}),
    changed: receipt.changed === undefined ? true : Boolean(receipt.changed),
    page
  });
}

app.put('/admin/pages/:id', requireDashboardAdmin, parseShareJson, requireDashboardCsrf, async (req, res) => {
  try {
    // Static validation precedes both coercive digest normalization and replay.
    // Keep all preprocessing inside the Express 4 async error boundary; live
    // CAS/source checks still happen only after a successful-result lookup.
    const requestIdHeader = req.get('Idempotency-Key');
    if (requestIdHeader !== undefined && !isvalidRequestId(requestIdHeader)) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
    }
    const validation = validateDashboardUpdateInput(req.body, { idempotent: requestIdHeader !== undefined });
    if (validation.error) {
      return res.status(400).json({ success: false, code: validation.code, error: validation.error });
    }
    const { title, description, htmlContent, expiresAt, isProtected, markdownTheme, codeType } = req.body;
    const { customPassword } = validation;
    const contentSubmitted = htmlContent !== undefined || title !== undefined
      || description !== undefined || markdownTheme !== undefined;
    const policySubmitted = isProtected !== undefined || expiresAt !== undefined || req.body.revokeAccess === true;

    let publishingOperation = null;
    let parsedContentBaseline = null;
    if (requestIdHeader !== undefined) {
      parsedContentBaseline = requireContentBaselineFor(req.params.id, req.get('If-Match'));
      const digestInput = normalizeContentUpdateDigestInput({
        expectedRevision: parsedContentBaseline.revision,
        htmlContent, title, description, markdownTheme, codeType
      });
      publishingOperation = {
        actorNamespace: resolveDashboardCloneNamespace(req),
        requestId: requestIdHeader,
        action: 'content-update',
        targetId: req.params.id,
        requestDigest: createRequestDigest(digestInput.fields, {
          action: 'content-update', targetId: req.params.id, presence: digestInput.presence
        })
      };
    }

    const respond = await publishing.run(async (repository, existingOperation) => {
      // Replay confirmation BEFORE any share read or CAS (#24 §8): a
      // committed save confirms its original result even when the retried
      // If-Match is long stale.
      if (existingOperation) {
        const outcome = await classifyOperationReplay(repository, {
          record: existingOperation,
          requestDigest: publishingOperation.requestDigest
        });
        if (outcome.kind === 'conflict') {
          return (res) => res.status(409).json({
            success: false,
            code: 'REQUEST_ID_CONFLICT',
            requestId: requestIdHeader,
            retryable: false,
            error: '同一请求标识对应了不同的请求内容'
          });
        }
        if (outcome.kind === 'result-unavailable') {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: requestIdHeader,
            retryable: false,
            error: '该操作已提交，但其结果已被永久删除'
          });
        }
        // #34: the committed result revision was later purged — the replay
        // confirms the operation happened but the result payload is gone.
        if (outcome.replayPurged) {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: requestIdHeader,
            retryable: false,
            error: '该操作已提交，但其结果版本已被清除，无法再次确认'
          });
        }
        return contentReplayResponse(outcome, { requestId: requestIdHeader, action: 'content-update' });
      }

      const page = await repository.getById(req.params.id);

      if (!page) {
        return (res) => res.status(404).json({
          success: false,
          error: 'Page not found'
        });
      }

      const updateOptions = { returnUpdated: true };
      if (policySubmitted) {
        updateOptions.expectedAccessRevision = requireAccessRevision(req.body.expectedAccessRevision);
        updateOptions.revokeAccess = req.body.revokeAccess === true;
        // Keep even unchanged protection submissions conditional on the displayed baseline.
        updateOptions.accessPrecondition = true;
      }
      // Row-level revision provenance: the owner dashboard is the trusted actor.
      updateOptions.actorSource = 'dashboard-edit';
      updateOptions.actorIdentity = 'owner-dashboard';

      // Content edits (body, title, description, Markdown theme) require a
      // concrete strong content baseline; a combined save must pass both
      // baselines atomically inside the repository update. Idempotent saves
      // reuse the baseline parsed before the transaction.
      if (contentSubmitted) {
        if (codeType !== undefined && codeType !== page.code_type) {
          return (res) => res.status(400).json({ success: false, code: 'INVALID_CONTENT_REVISION', error: '内容类型在创建后固定，不能修改' });
        }
        const baseline = parsedContentBaseline || requireContentBaselineFor(req.params.id, req.get('If-Match'));
        updateOptions.expectedContentRevision = baseline.revision;
      }

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

      // Memory returns a live row reference; freeze the revision BEFORE its
      // staged update mutates that row, matching the PostgreSQL read value.
      const previousContentRevision = String(page.current_revision);
      const saved = await repository.updatePage(req.params.id, updateOptions);
      if (!saved) return (res) => res.status(404).json({ success: false, error: 'Share not found' });

      const updatedPage = saved;
      const contentRevision = String(updatedPage.current_revision);
      await repository.createAuditLog({
        action: 'page.update',
        pageId: req.params.id,
        details: JSON.stringify({
          fields: Object.keys(updateOptions),
          revision: contentRevision
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      if (publishingOperation) {
        // The operation result commits in the SAME transaction as the Share,
        // its Revision and this audit entry (#24 §8). The receipt carries the
        // committed outcome (changed or same-content no-op plus the policy
        // display values) so a replay reproduces the original response.
        await repository.createPublishingOperation({
          actor_namespace: publishingOperation.actorNamespace,
          request_id: requestIdHeader,
          action: 'content-update',
          request_digest: publishingOperation.requestDigest,
          target_id: req.params.id,
          result_share_id: req.params.id,
          result_revision: contentRevision,
          result_access_revision: String(updatedPage.access_revision),
          receipt_encrypted: encodeOperationReceipt({
            changed: contentRevision !== previousContentRevision,
            isProtected: updatedPage.is_protected === 1,
            expiresAt: updatedPage.expires_at === null || updatedPage.expires_at === undefined
              ? null
              : Number(updatedPage.expires_at)
          }),
          created_at: Date.now()
        });
      }

      return (res) => res.json({
        success: true,
        ...(publishingOperation ? { requestId: requestIdHeader } : {}),
        changed: contentRevision !== previousContentRevision,
        page: adminPageProjection(updatedPage)
      });
    }, { publishingOperation });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    if (error.code?.startsWith('ACCESS_') || error.code === 'INVALID_ACCESS_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    if (error.code === 'CONTENT_PRECONDITION_REQUIRED' || error.code === 'INVALID_CONTENT_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    if (error.code === 'CONTENT_REVISION_CONFLICT') {
      // The dashboard owns this route; the conflict payload carries the remote
      // content so the owner can compare it with the retained draft. Policy
      // fields are never included.
      return res.status(error.status).json({
        success: false,
        code: error.code,
        error: error.message,
        current: error.current || null
      });
    }
    console.error('Update page failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update page'
    });
  }
});

app.post('/admin/pages/:id/restore', requireDashboardApiAdmin, parseShareJson, requireDashboardCsrf, async (req, res) => {
  // #33 owner restore (#24 §7/§8/§9): a source revision becomes the new
  // current Revision with restored_from provenance; a same-snapshot restore
  // is the approved unchanged no-op. An operation id makes the whole action
  // idempotent: the retried request confirms the committed result instead of
  // re-running a CAS that its stale If-Match would now fail.
  const requestIdHeader = req.get('Idempotency-Key');
  if (!isvalidRequestId(requestIdHeader)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }

  const revisionInput = req.body?.revision;
  if (!isContentRevision(revisionInput)) {
    return res.status(400).json({ success: false, code: 'INVALID_CONTENT_REVISION', error: '恢复来源版本必须是正整数十进制字符串' });
  }
  const sourceRevision = String(revisionInput);

  // Format-level precondition validation first (#24 §8 order); the CAS
  // itself runs inside the transaction against the locked row.
  let baseline;
  try {
    baseline = requireContentBaselineFor(req.params.id, req.get('If-Match'));
  } catch (error) {
    if (error.code === 'CONTENT_PRECONDITION_REQUIRED' || error.code === 'INVALID_CONTENT_REVISION'
      || error.code === 'CONTENT_REVISION_CONFLICT') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    throw error;
  }

  const digestInput = normalizeRestoreDigestInput({ expectedRevision: baseline.revision, sourceRevision });
  const requestDigest = createRequestDigest(digestInput.fields, { action: 'restore', targetId: req.params.id });
  const publishingOperation = requestIdHeader === undefined ? null : {
    actorNamespace: resolveDashboardCloneNamespace(req),
    requestId: requestIdHeader,
    action: 'restore',
    targetId: req.params.id,
    requestDigest
  };

  try {
    const respond = await publishing.run(async (repository, existingOperation) => {
      // Replay confirmation BEFORE the source re-read and the CAS: a
      // committed restore replays even after its source was purged or the
      // Share moved on (same discipline as the #32 clone replay).
      if (existingOperation) {
        const outcome = await classifyOperationReplay(repository, { record: existingOperation, requestDigest });
        if (outcome.kind === 'conflict') {
          return (res) => res.status(409).json({
            success: false,
            code: 'REQUEST_ID_CONFLICT',
            requestId: requestIdHeader,
            retryable: false,
            error: '同一请求标识对应了不同的请求内容'
          });
        }
        if (outcome.kind === 'result-unavailable') {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: requestIdHeader,
            retryable: false,
            error: '该操作已提交，但其结果已被永久删除'
          });
        }
        // #34: the committed result revision was later purged — the replay
        // confirms the operation happened but the result payload is gone.
        if (outcome.replayPurged) {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: requestIdHeader,
            retryable: false,
            error: '该操作已提交，但其结果版本已被清除，无法再次确认'
          });
        }
        return contentReplayResponse(outcome, { requestId: requestIdHeader, action: 'restore' });
      }

      const page = await repository.getById(req.params.id);
      if (!page) {
        return (res) => res.status(404).json({ success: false, error: 'Page not found' });
      }

      const result = await repository.restorePageRevision(req.params.id, {
        sourceRevision,
        expectedContentRevision: baseline.revision,
        actorSource: 'dashboard-restore',
        actorIdentity: 'owner-dashboard',
        returnUpdated: true
      });
      if (!result || !result.page) {
        return (res) => res.status(404).json({ success: false, error: 'Share not found' });
      }
      const updatedPage = result.page;
      const contentRevision = String(updatedPage.current_revision);

      await repository.createAuditLog({
        action: 'page.restore',
        pageId: req.params.id,
        details: JSON.stringify({
          sourceRevision,
          revision: contentRevision,
          changed: result.changed
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      if (publishingOperation) {
        // Same transaction as the new Revision, its provenance and this
        // audit entry; the unique constraint is the final dedupe guard.
        await repository.createPublishingOperation({
          actor_namespace: publishingOperation.actorNamespace,
          request_id: requestIdHeader,
          action: 'restore',
          request_digest: requestDigest,
          target_id: req.params.id,
          result_share_id: req.params.id,
          result_revision: contentRevision,
          result_access_revision: String(updatedPage.access_revision),
          receipt_encrypted: encodeOperationReceipt({
            changed: result.changed,
            sourceRevision,
            isProtected: updatedPage.is_protected === 1,
            expiresAt: updatedPage.expires_at === null || updatedPage.expires_at === undefined
              ? null
              : Number(updatedPage.expires_at)
          }),
          created_at: Date.now()
        });
      }

      return (res) => res.json({
        success: true,
        changed: result.changed,
        ...(publishingOperation ? { requestId: requestIdHeader } : {}),
        page: adminPageProjection(updatedPage)
      });
    }, { publishingOperation });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    if (error.code === 'RESTORE_SOURCE_INVALID') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    if (error.code?.startsWith('ACCESS_') || error.code === 'INVALID_ACCESS_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    if (error.code === 'CONTENT_PRECONDITION_REQUIRED' || error.code === 'INVALID_CONTENT_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    if (error.code === 'CONTENT_REVISION_CONFLICT') {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        error: error.message,
        current: error.current || null
      });
    }
    console.error('Restore page revision failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to restore revision' });
  }
});

// ---- Owner publication state (#35): unpublish/republish with unified
// public semantics (#24 §5/§8/§9). ----
//
// One atomic publishing transaction per transition: the Share row is locked,
// the expected access revision is re-checked inside the lock (412 on a stale
// baseline), and `published` + `access_revision` advance together — never
// touching password, expiry, content revisions, history, Favorite or view
// counts. An operation id in the dashboard namespace makes the whole action
// idempotent: a same-state repeat records `changed:false` without a second
// bump; a lost response replays the committed result from the ledger.
// Version-bound unlock cookies (#25) die with the bump on BOTH transitions.

function stateReplayResponse(outcome, { requestId, action }) {
  const { record, receipt } = outcome;
  return (res) => res.json({
    success: true,
    replayed: true,
    action,
    requestId,
    changed: Boolean(receipt.changed),
    published: receipt.published === true,
    accessRevision: String(record.result_access_revision)
  });
}

async function handlePublishStateRequest(req, res, action) {
  const requestIdHeader = req.get('Idempotency-Key');
  if (!isvalidRequestId(requestIdHeader)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }

  // Format-level precondition validation first (#24 §8 order); the live CAS
  // itself runs inside the transaction against the locked row.
  try {
    requireAccessRevision(req.body?.expectedAccessRevision);
  } catch (error) {
    if (error.code === 'ACCESS_PRECONDITION_REQUIRED' || error.code === 'INVALID_ACCESS_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    throw error;
  }
  const expectedAccessRevision = String(req.body.expectedAccessRevision);

  const digestInput = normalizePublishStateDigestInput({ expectedAccessRevision });
  const requestDigest = createRequestDigest(digestInput.fields, { action, targetId: req.params.id });
  const publishingOperation = {
    actorNamespace: resolveDashboardCloneNamespace(req),
    requestId: requestIdHeader,
    action,
    targetId: req.params.id,
    requestDigest
  };

  try {
    const respond = await publishing.run(async (repository, existingOperation) => {
      // Replay confirmation BEFORE the share read and the CAS: a committed
      // transition confirms its recorded result even when the retried
      // baseline is long stale (#24 §8; same discipline as #32/#33).
      if (existingOperation) {
        const outcome = await classifyOperationReplay(repository, { record: existingOperation, requestDigest });
        if (outcome.kind === 'conflict') {
          return (res) => res.status(409).json({
            success: false,
            code: 'REQUEST_ID_CONFLICT',
            requestId: requestIdHeader,
            retryable: false,
            error: '同一请求标识对应了不同的请求内容'
          });
        }
        if (outcome.kind === 'result-unavailable') {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: requestIdHeader,
            retryable: false,
            error: '该操作已提交，但其结果已被永久删除'
          });
        }
        return stateReplayResponse(outcome, { requestId: requestIdHeader, action });
      }

      const page = await repository.getById(req.params.id);
      if (!page) {
        return (res) => res.status(404).json({ success: false, code: 'SHARE_NOT_FOUND', error: 'Share not found' });
      }

      const result = await repository.setPublished(req.params.id, {
        published: action === 'republish',
        expectedAccessRevision,
        returnUpdated: true
      });
      if (!result || !result.page) {
        return (res) => res.status(404).json({ success: false, code: 'SHARE_NOT_FOUND', error: 'Share not found' });
      }
      const updatedPage = result.page;
      const accessRevision = String(updatedPage.access_revision);

      // Same-state repeat: confirm success, record the no-op result, but no
      // bump and no duplicate audit side effect.
      if (result.changed) {
        await repository.createAuditLog({
          action: action === 'unpublish' ? 'page.unpublish' : 'page.republish',
          pageId: req.params.id,
          details: JSON.stringify({ accessRevision, changed: true }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }

      if (publishingOperation) {
        // Commits in the SAME transaction as the state change and the audit
        // entry; the unique constraint is the final dedupe guard. The
        // result's content revision is recorded as owner-review metadata —
        // the transition itself never moves it.
        await repository.createPublishingOperation({
          actor_namespace: publishingOperation.actorNamespace,
          request_id: requestIdHeader,
          action,
          request_digest: requestDigest,
          target_id: req.params.id,
          result_share_id: req.params.id,
          result_revision: String(updatedPage.current_revision),
          result_access_revision: accessRevision,
          receipt_encrypted: encodeOperationReceipt({
            changed: result.changed,
            published: action === 'republish'
          }),
          created_at: Date.now()
        });
      }

      return (res) => res.json({
        success: true,
        changed: result.changed,
        requestId: requestIdHeader,
        published: action === 'republish',
        accessRevision,
        page: adminPageProjection(updatedPage)
      });
    }, { publishingOperation });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    if (error.code === 'ACCESS_PRECONDITION_REQUIRED' || error.code === 'INVALID_ACCESS_REVISION'
      || error.code === 'ACCESS_REVISION_CONFLICT') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    console.error('Publish-state transition failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to update publication state' });
  }
}

app.post('/admin/pages/:id/unpublish', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, (req, res) => {
  return handlePublishStateRequest(req, res, 'unpublish');
});

app.post('/admin/pages/:id/republish', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, (req, res) => {
  return handlePublishStateRequest(req, res, 'republish');
});

// ---- Owner revision purge (#34): dashboard session + CSRF only. ----
//
// One atomic publishing transaction: the Share row is locked, the target is
// re-checked against the CURRENT pointer (never a pre-read), the snapshot
// payload and the sensitive receipt bytes of every operation whose committed
// result is this exact Share+Revision are scrubbed, and the audit entry
// commits together with them. A repeat purge of the same tombstone confirms
// success (unchanged, no duplicate destructive effects); the purge of a
// now-purged target must never read back as a failure.
const PURGE_AUDIT_ACTION = 'page.revision.purge';

function purgeTombstoneProjection(id, revision, purgedAt) {
  return {
    shareId: id,
    revision: String(revision),
    purgedAt: Number(purgedAt)
  };
}

app.post('/admin/pages/:id/revisions/:revision/purge', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
  try {
    // Identity of intent: the confirmation string must name the exact Share
    // and revision the dialog showed. Format errors precede the transaction.
    if (!isContentRevision(req.params.revision)) {
      return res.status(400).json({ success: false, code: 'INVALID_CONTENT_REVISION', error: 'content revision must be a positive decimal string' });
    }
    const revision = String(req.params.revision);
    const confirm = req.body?.confirm;
    const expectedConfirm = `${req.params.id}:${revision}`;
    if (confirm !== expectedConfirm) {
      return res.status(400).json({
        success: false,
        code: 'PURGE_CONFIRMATION_MISMATCH',
        error: '确认信息与目标不符：必须包含准确的 Share ID 与版本号'
      });
    }

    const respond = await publishing.run(async (repository) => {
      const result = await repository.purgeContentRevision(req.params.id, revision);

      if (!result.found) {
        return (res) => res.status(404).json({ success: false, code: 'SHARE_NOT_FOUND', error: 'Share not found' });
      }
      if (result.current) {
        return (res) => res.status(409).json({
          success: false,
          code: 'CURRENT_REVISION_PURGE_FORBIDDEN',
          error: '当前版本不能清除：只能清除非当前的历史版本'
        });
      }
      if (result.revision === false) {
        return (res) => res.status(404).json({ success: false, code: 'REVISION_NOT_FOUND', error: 'Revision not found' });
      }

      // Tombstone projection: only non-content identity fields, exactly what
      // the dialog confirmed — never any surviving payload.
      const tombstone = purgeTombstoneProjection(req.params.id, revision, result.purgedAt);

      if (result.alreadyPurged) {
        // Idempotent repeat: the tombstone is confirmed, nothing happens
        // again. No duplicate audit entry, no second destructive effect, and
        // — importantly — no failure signal: the earlier purge succeeded.
        return (res) => res.status(200).json({
          success: true,
          changed: false,
          alreadyPurged: true,
          purged: tombstone,
          message: '该版本此前已清除；本次确认未产生新的清除副作用。在线保存的该版本内容已不可读取。'
        });
      }

      await repository.createAuditLog({
        action: PURGE_AUDIT_ACTION,
        pageId: req.params.id,
        // Audit carries ONLY non-content identity; never the payload.
        details: JSON.stringify({ revision, purgedAt: result.purgedAt }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return (res) => res.status(200).json({
        success: true,
        changed: true,
        alreadyPurged: false,
        purged: tombstone,
        message: '已清除在线保存的该版本内容，只保留不含正文的墓碑；其他版本、离线备份与接收者下载不受影响。'
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    if (error.code === 'INVALID_CONTENT_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    console.error('Revision purge failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to purge revision' });
  }
});

app.delete('/admin/pages/batch', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return (res) => res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
      }

      if (ids.length > 100) {
        return (res) => res.status(400).json({ success: false, error: 'Batch delete limited to 100 items' });
      }

      // Deterministic lock order: sorted Share ids, then their operation
      // rows, all in this one transaction.
      const sortedIds = [...ids].sort();
      const deleted = await repository.deletePages(sortedIds);
      await repository.clearPublishingOperationsForShares(sortedIds);

      await repository.createAuditLog({
        action: 'page.delete.batch',
        pageId: null,
        details: JSON.stringify({ count: deleted, ids: ids.slice(0, 10) }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return (res) => res.json({ success: true, deleted });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Batch delete failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete pages' });
  }
});

app.delete('/admin/pages/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const page = await repository.getById(req.params.id);

      if (!page) {
        return (res) => res.status(404).json({
          success: false,
          error: 'Page not found'
        });
      }

      await repository.deletePage(req.params.id);
      // Same transaction: drop sensitive creation receipts and leave a
      // non-content dedupe tombstone so late replays never revive the Share.
      await repository.clearPublishingOperationsForShares([req.params.id]);

      await repository.createAuditLog({
        action: 'page.delete',
        pageId: req.params.id,
        details: JSON.stringify({ title: page.title || page.id }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });

      return (res) => res.json({
        success: true
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Delete page failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete page'
    });
  }
});

app.post('/admin/pages/:id/clone', requireDashboardAdmin, parseSmallForm, requireDashboardCsrf, async (req, res) => {
  // New dashboard clones send a request id (hidden form field); a replay
  // confirms the original clone instead of copying again.
  const requestId = req.body?.requestId;
  if (requestId !== undefined && requestId !== null && requestId !== '' && !isvalidRequestId(String(requestId))) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }
  const normalizedRequestId = requestId ? String(requestId) : null;
  const actorNamespace = resolveDashboardCloneNamespace(req);
  const requestDigest = createRequestDigest({}, { action: 'clone', targetId: req.params.id });
  const publishingOperation = normalizedRequestId
    ? { actorNamespace, requestId: normalizedRequestId, action: 'clone', targetId: req.params.id, requestDigest }
    : null;

  try {
    const respond = await publishing.run(async (repository, existingOperation) => {
      if (existingOperation) {
        // Confirmed BEFORE the source re-read: a committed clone replays even
        // after its source was deleted or changed.
        const outcome = await classifyOperationReplay(repository, { record: existingOperation, requestDigest });

        if (outcome.kind === 'conflict') {
          return (res) => res.status(409).json({
            success: false,
            code: 'REQUEST_ID_CONFLICT',
            requestId: normalizedRequestId,
            retryable: false,
            error: '同一请求标识对应了不同的请求内容'
          });
        }
        if (outcome.kind === 'result-unavailable' || !outcome.cloneShareId) {
          return (res) => res.status(410).json({
            success: false,
            code: 'RESULT_UNAVAILABLE',
            requestId: normalizedRequestId,
            retryable: false,
            error: '该操作已提交，但其结果已被永久删除'
          });
        }
        if (publishingOperation) {
          // The REPLAY also completes the browser intent: without this the
          // dashboard would keep retrying the same id forever instead of
          // rotating to a fresh explicit clone on the next click.
          res.cookie(CLONE_INTENT_DONE_COOKIE, normalizedRequestId, {
            maxAge: 10 * 60 * 1000,
            sameSite: 'lax'
          });
        }
        return (res) => res.redirect('/admin/pages/' + encodeURIComponent(outcome.cloneShareId));
      }

      const page = await repository.getById(req.params.id);

      if (!page) {
        return (res) => res.status(404).json({ success: false, error: 'Page not found' });
      }

      const newId = await createPageWithRetry({
        htmlContent: page.html_content,
        passwordHash: null,
        encryptedPassword: null,
        isProtected: false,
        codeType: page.code_type,
        title: (page.title || page.id) + ' (Copy)',
        description: page.description,
        createdAt: Date.now(),
        expiresAt: null,
        markdownTheme: page.code_type === 'markdown'
          ? resolveMarkdownThemeId(page.markdown_theme)
          : null,
        actorSource: 'clone',
        actorIdentity: 'owner-dashboard'
      }, repository);

      if (publishingOperation) {
        const created = await repository.getById(newId);
        await repository.createPublishingOperation({
          actor_namespace: actorNamespace,
          request_id: normalizedRequestId,
          action: 'clone',
          request_digest: requestDigest,
          target_id: req.params.id,
          result_share_id: newId,
          result_revision: String(created.current_revision),
          result_access_revision: String(created.access_revision),
          // Clone results carry no generated secret; no receipt is stored.
          receipt_encrypted: null,
          created_at: Date.now()
        });
      }

      if (publishingOperation) {
        // Completion marker for the browser-side clone intent: a readable,
        // non-sensitive cookie naming the request id lets the dashboard
        // reconcile the persisted intent when the user returns (the only
        // signal a full-form navigation can leave behind).
        res.cookie(CLONE_INTENT_DONE_COOKIE, normalizedRequestId, {
          maxAge: 10 * 60 * 1000,
          sameSite: 'lax'
        });
      }

      return (res) => res.redirect('/admin/pages/' + encodeURIComponent(newId));
    }, { publishingOperation });
    return respond(res);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'REQUEST_ID_CONFLICT',
        requestId: normalizedRequestId,
        retryable: false,
        error: '同一请求标识对应了不同的请求内容'
      });
    }
    if (sendPublishingError(res, error)) return;
    console.error('Clone page failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to clone page' });
  }
});

app.post('/api/pages/create', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishSession, requireBrowserPublishCsrf, async (req, res) => {
  // New web creations always carry a request id (client-generated UUID); a
  // direct caller without one keeps the plain, unclaimed behavior.
  const requestId = req.get('Idempotency-Key');
  if (requestId !== undefined && !isvalidRequestId(requestId)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }

  try {
    const respond = await runIdempotentCreate({
      input: req.body,
      namespace: req.publishNamespace,
      requestId: requestId || null,
      provenance: { actorSource: 'web', actorIdentity: null },
      auditDetails: (result) => ({ codeType: result.codeType, isProtected: result.isProtected }),
      clientIp: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      buildResponse: (res, result, replayed) => res.json({
        success: true,
        urlId: result.id,
        password: result.password,
        isProtected: result.isProtected,
        codeType: result.codeType,
        title: result.title,
        description: result.description,
        expiresAt: result.expiresAt,
        markdownTheme: result.markdownTheme,
        ...(requestId ? { requestId } : {}),
        ...(replayed ? { replayed: true } : {})
      })
    });
    return respond(res);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'REQUEST_ID_CONFLICT',
        requestId: requestId || null,
        retryable: false,
        error: '同一请求标识对应了不同的请求内容'
      });
    }
    if (sendPublishingError(res, error)) return;
    console.error('Create page failed:', error);
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

app.get('/api/v1/me', privateNoStore, requireApiKey, (req, res) => {
  const origin = new URL(config.baseUrl || `${req.protocol}://${req.get('host')}`).origin;
  return res.json({ success: true, origin, ...req.apiKeyIdentity });
});

app.get('/api/v1/capabilities', privateNoStore, requireApiKey, (req, res) => {
  return res.json({ success: true, ...capabilities });
});

// ---- Read-only resource APIs (#36, X-API-Key + scope + per-Share grant) ----
// Every response below is management data: private/no-store via the
// privateNoStore middleware, no password/encrypted_password, no grant
// tables, no Favorite state. Grant-missing answers 404 identically to
// Share-missing; unpublished/locked/expired Shares stay readable because
// management authorization is independent of public visibility (#24 §6).
app.get('/api/v1/shares', privateNoStore, markApiResourceReadEndpoint, requireApiKey, requireScope(READ_SCOPE), async (req, res) => {
  const limit = parseShareListLimit(req.query.limit);
  if (limit.error) {
    return res.status(400).json({ success: false, code: 'INVALID_LIMIT', retryable: false, error: limit.error });
  }
  const cursor = parseShareListCursor(req.query.cursor);
  if (cursor.error) {
    return res.status(400).json({ success: false, code: 'INVALID_CURSOR', retryable: false, error: cursor.error });
  }

  try {
    const rows = await pageRepository.listGrantedSharePage({
      apiKeyId: req.apiKeyIdentity.id,
      limit,
      ...(cursor.cursor || {})
    });

    // A full page hints at a next one; the cursor names the last row so the
    // next read continues exactly after it even if new Shares were granted
    // in between (stable under insertion, #36 AC).
    const nextCursor = rows.length === limit ? encodeShareListCursor(rows[rows.length - 1]) : null;

    return res.json({
      success: true,
      shares: rows.map(grantedShareProjection),
      ...(nextCursor ? { nextCursor } : {})
    });
  } catch (error) {
    console.error('Granted share list failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return sendApiReadUnavailable(res);
  }
});

app.get('/api/v1/shares/:id/content', privateNoStore, markApiResourceReadEndpoint, requireApiKey, requireScope(READ_SCOPE), async (req, res) => {
  try {
    const identity = req.apiKeyIdentity;
    const grant = await pageRepository.getShareGrant(identity.id, req.params.id);
    if (!grant || grant.can_read !== true) return sendShareNotFound(res);

    const page = await pageRepository.getById(req.params.id);
    if (!page) return sendShareNotFound(res);

    const revision = String(page.current_revision);
    const etag = contentEtag(page.id, revision);

    if (ifNoneMatchMatches(req.get('if-none-match'), etag)) {
      res.set('ETag', etag);
      return res.status(304).end();
    }

    res.set('ETag', etag);
    // Full snapshot of the CURRENT revision; the materialized projection is
    // transactionally identical to that snapshot, so no history is scanned.
    return res.json({
      success: true,
      id: page.id,
      revision,
      htmlContent: page.html_content,
      codeType: page.code_type,
      title: page.title,
      description: page.description,
      markdownTheme: page.markdown_theme
    });
  } catch (error) {
    console.error('Granted share content failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return sendApiReadUnavailable(res);
  }
});

app.get('/api/v1/shares/:id/state', privateNoStore, markApiResourceReadEndpoint, requireApiKey, requireApiStateScope, async (req, res) => {
  try {
    const identity = req.apiKeyIdentity;
    const grant = await pageRepository.getShareGrant(identity.id, req.params.id);
    const scopes = identity.scopes || [];
    // State is intentionally the only intersection for a publish-only Key:
    // its publish scope must match can_publish, while read scope must match
    // can_read. One permission never implies the other.
    const canReadState = scopes.includes(READ_SCOPE) && grant?.can_read === true;
    const canPublishState = scopes.includes(PUBLISH_SCOPE) && grant?.can_publish === true;
    if (!canReadState && !canPublishState) return sendShareNotFound(res);

    const page = await pageRepository.getById(req.params.id);
    if (!page) return sendShareNotFound(res);

    const etag = accessEtag(page.id, String(page.access_revision));

    // The access ETag remains the write/CAS validator. Always return the body
    // (even when If-None-Match matches) because the canonical public URL is
    // resolved from current server configuration and must not be hidden by a
    // validator that only tracks access policy.
    res.set('ETag', etag);
    return res.json({
      success: true,
      id: page.id,
      published: page.published !== false,
      isProtected: page.is_protected === 1,
      expiresAt: page.expires_at === null || page.expires_at === undefined ? null : Number(page.expires_at),
      accessRevision: String(page.access_revision),
      url: publicPageUrl(req, page.id)
    });
  } catch (error) {
    console.error('Granted share state failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return sendApiReadUnavailable(res);
  }
});

function apiPublishStateProjection(req, page) {
  return {
    id: page.id,
    published: page.published !== false,
    isProtected: page.is_protected === 1,
    expiresAt: page.expires_at === null || page.expires_at === undefined ? null : Number(page.expires_at),
    accessRevision: String(page.access_revision),
    url: publicPageUrl(req, page.id)
  };
}

function sendApiPublishStateResult(res, req, page, { action, requestId, changed, replayed = false }) {
  const state = apiPublishStateProjection(req, page);
  res.set('ETag', accessEtag(page.id, state.accessRevision));
  return res.json({ success: true, action, requestId, changed, ...(replayed ? { replayed: true } : {}), ...state });
}

async function handleApiPublishStateRequest(req, res, action) {
  const identity = req.apiKeyIdentity;
  const requestId = req.apiPublishRequestId;
  const baseline = req.apiPublishBaseline;
  const namespace = resolveApiCredentialNamespace(identity);
  const digestInput = normalizePublishStateDigestInput({ expectedAccessRevision: baseline.revision });
  const requestDigest = createRequestDigest(digestInput.fields, { action, targetId: req.params.id });
  const publishingOperation = {
    actorNamespace: namespace,
    requestId,
    action,
    targetId: req.params.id,
    requestDigest
  };

  try {
    const respond = await publishing.run(async (repository, existingOperation) => {
      // The Key row is already locked and credential_version rechecked by
      // publishing.run. Re-read scopes under that lock, then lock the Share
      // and grant before either replay or state CAS.
      const currentKey = await repository.getApiKeyById(identity.id);
      if (!currentKey || !currentKey.scopes?.includes(PUBLISH_SCOPE)) {
        return response => sendApiPublishError(req, response, 403, 'SCOPE_REQUIRED', '当前凭据缺少所需 scope: share:publish', false, { scope: PUBLISH_SCOPE });
      }
      const authorization = await repository.getShareGrantForWrite(identity.id, req.params.id);
      if (!authorization || authorization.grant?.can_publish !== true) {
        return response => sendApiPublishError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有上下架授权');
      }

      if (existingOperation) {
        const outcome = await classifyOperationReplay(repository, { record: existingOperation, requestDigest });
        if (outcome.kind === 'conflict') {
          return response => sendApiPublishError(req, response, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
        }
        if (outcome.kind === 'result-unavailable') {
          return response => sendApiPublishError(req, response, 410, 'RESULT_UNAVAILABLE', '该操作已提交，但其结果不可用');
        }
        if (!outcome.accessUnchanged) {
          // Confirm the operation, but never present its once-current state as
          // if it were the Share's current state after a later access change.
          // The URL is independently generated from the current public URL
          // policy; it does not claim the historical state is still current.
          return response => response.json({
            success: true,
            action,
            requestId,
            changed: outcome.receipt.changed === true,
            replayed: true,
            stateChangedSinceCommit: true,
            url: publicPageUrl(req, outcome.page.id)
          });
        }
        return response => sendApiPublishStateResult(response, req, outcome.page, {
          action, requestId, changed: outcome.receipt.changed === true, replayed: true
        });
      }

      const result = await repository.setPublished(req.params.id, {
        published: action === 'republish',
        expectedAccessRevision: baseline.revision,
        returnUpdated: true
      });
      if (!result?.page) {
        return response => sendApiPublishError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有上下架授权');
      }

      const page = result.page;
      const accessRevision = String(page.access_revision);
      if (result.changed) {
        await repository.createAuditLog({
          action: action === 'unpublish' ? 'page.unpublish' : 'page.republish',
          pageId: req.params.id,
          details: JSON.stringify({ accessRevision, changed: true, actor: `api-key:${identity.id}` }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      }
      await repository.createPublishingOperation({
        actor_namespace: namespace,
        request_id: requestId,
        action,
        request_digest: requestDigest,
        target_id: req.params.id,
        result_share_id: req.params.id,
        result_revision: String(page.current_revision),
        result_access_revision: accessRevision,
        receipt_encrypted: encodeOperationReceipt({ changed: result.changed, published: action === 'republish' }),
        created_at: Date.now()
      });
      return response => sendApiPublishStateResult(response, req, page, { action, requestId, changed: result.changed });
    }, { apiKeyIdentity: identity, publishingOperation });
    return respond(res);
  } catch (error) {
    if (error.code === 'INVALID_API_KEY') return sendApiPublishError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
    if (error.code === 'PUBLISHING_MAINTENANCE') return sendApiPublishError(req, res, 503, error.code, error.message, true);
    if (['55P03', '40P01', '57014'].includes(error.code)) {
      return sendApiPublishError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share publication is temporarily unavailable', true);
    }
    if (error.code === 'ACCESS_PRECONDITION_REQUIRED' || error.code === 'INVALID_ACCESS_REVISION'
      || error.code === 'ACCESS_REVISION_CONFLICT') {
      return sendApiPublishError(req, res, error.status || 400, error.code, error.message);
    }
    if (error.code === '23505') return sendApiPublishError(req, res, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
    console.error('Managed-Key publish-state transition failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return sendApiPublishError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share publication is temporarily unavailable', true);
  }
}

app.post(SHARE_UNPUBLISH.path, privateNoStore, markApiPublishStateEndpoint({ write: true }), requireApiKey,
  requireApiPublishScope, validateApiPublishStateHeaders, parseApiPublishStateJson, validateApiPublishStateBody,
  (req, res) => handleApiPublishStateRequest(req, res, 'unpublish'));

app.post(SHARE_REPUBLISH.path, privateNoStore, markApiPublishStateEndpoint({ write: true }), requireApiKey,
  requireApiPublishScope, validateApiPublishStateHeaders, parseApiPublishStateJson, validateApiPublishStateBody,
  (req, res) => handleApiPublishStateRequest(req, res, 'republish'));

app.get('/api/v1/shares/:id/revisions', privateNoStore, markApiRevisionEndpoint(), requireApiKey,
  requireApiRevisionScopes([READ_SCOPE]), async (req, res) => {
    const limit = parseShareListLimit(req.query.limit);
    if (typeof limit !== 'number') {
      return sendApiRevisionError(req, res, 400, 'INVALID_LIMIT', limit.error);
    }
    const parsedCursor = parseRevisionHistoryCursor(req.query.cursor);
    if (parsedCursor.error) {
      return sendApiRevisionError(req, res, 400, 'INVALID_CURSOR', parsedCursor.error);
    }

    try {
      const identity = req.apiKeyIdentity;
      const grant = await pageRepository.getShareGrant(identity.id, req.params.id);
      if (!grant || grant.can_read !== true) {
        return sendApiRevisionError(req, res, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有对它的授权');
      }
      const history = await pageRepository.listContentRevisionCursorPage(req.params.id, {
        limit: limit + 1,
        beforeRevision: parsedCursor.cursor
      });
      if (!history.page) return sendApiRevisionError(req, res, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有对它的授权');
      const hasMore = history.items.length > limit;
      const selected = hasMore ? history.items.slice(0, limit) : history.items;
      const nextCursor = hasMore ? encodeRevisionHistoryCursor(selected[selected.length - 1].revision) : null;
      return res.json({
        success: true,
        shareId: history.page.id,
        revisions: selected.map(row => apiRevisionMetadata(history.page, row)),
        ...(nextCursor ? { nextCursor } : {})
      });
    } catch (error) {
      console.error('Managed-Key revision history failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
      return sendApiRevisionError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share history is temporarily unavailable', true);
    }
  });

app.get('/api/v1/shares/:id/revisions/:revision', privateNoStore, markApiRevisionEndpoint(), requireApiKey,
  requireApiRevisionScopes([READ_SCOPE]), async (req, res) => {
    try {
      const identity = req.apiKeyIdentity;
      const grant = await pageRepository.getShareGrant(identity.id, req.params.id);
      if (!grant || grant.can_read !== true) {
        return sendApiRevisionError(req, res, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有对它的授权');
      }
      if (!isContentRevision(req.params.revision)) {
        return sendApiRevisionError(req, res, 400, 'INVALID_CONTENT_REVISION', 'Revision must be a positive decimal string');
      }

      const snapshot = await pageRepository.getContentRevisionWithCurrent(req.params.id, req.params.revision);
      if (!snapshot) return sendApiRevisionError(req, res, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有对它的授权');
      if (!snapshot.revision) return sendApiRevisionError(req, res, 404, 'REVISION_NOT_FOUND', 'Revision not found');
      const { page, revision: row } = snapshot;
      const metadata = apiRevisionMetadata(page, row);
      if (metadata.purged) {
        return res.status(410).json({
          success: false,
          code: 'REVISION_PURGED',
          requestId: null,
          retryable: false,
          error: '该版本内容已被永久清除，仅保留墓碑',
          revision: { shareId: req.params.id, ...metadata }
        });
      }
      if (typeof row.html_content !== 'string') {
        return sendApiRevisionError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Revision payload is unavailable', true);
      }
      return res.json({
        success: true,
        revision: {
          shareId: page.id,
          ...metadata,
          htmlContent: row.html_content,
          codeType: row.code_type,
          title: row.title,
          description: row.description,
          markdownTheme: row.markdown_theme
        }
      });
    } catch (error) {
      console.error('Managed-Key revision read failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
      return sendApiRevisionError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share revision is temporarily unavailable', true);
    }
  });

app.post('/api/v1/shares/:id/restore', privateNoStore, markApiRevisionEndpoint({ write: true }), requireApiKey,
  requireApiRevisionScopes([READ_SCOPE, 'share:update']), validateApiRestoreHeaders, parseApiRestoreJson,
  async (req, res) => {
    const parsedInput = parseApiRestoreInput(req.body);
    if (parsedInput.error) {
      return sendApiRevisionError(req, res, 400, 'INVALID_RESTORE_INPUT', parsedInput.error);
    }
    const sourceRevision = parsedInput.revision;
    const baseline = req.apiUpdateBaseline;
    const digestInput = normalizeRestoreDigestInput({ expectedRevision: baseline.revision, sourceRevision });
    const requestId = req.apiUpdateRequestId;
    const identity = req.apiKeyIdentity;
    const namespace = resolveApiNamespace(req);
    const requestDigest = createRequestDigest(digestInput.fields, { action: 'restore', targetId: req.params.id });
    const publishingOperation = {
      actorNamespace: namespace,
      requestId,
      action: 'restore',
      targetId: req.params.id,
      requestDigest
    };
    const respondWithSnapshot = ({ revision, snapshot, changed, replayed = false }) => response => {
      const baseUrl = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
      response.set('ETag', contentEtag(req.params.id, String(revision)));
      return response.json({
        success: true,
        action: 'restore',
        requestId,
        changed,
        ...(replayed ? { replayed: true } : {}),
        url: `${baseUrl.replace(/\/+$/, '')}/view/${encodeURIComponent(req.params.id)}`,
        page: {
          id: req.params.id,
          currentRevision: String(revision),
          htmlContent: snapshot.htmlContent,
          codeType: snapshot.codeType,
          title: snapshot.title,
          description: snapshot.description,
          markdownTheme: snapshot.markdownTheme
        }
      });
    };

    try {
      const respond = await publishing.run(async (repository, existingOperation) => {
        // The Key lock and operation lock have already been acquired. Lock
        // the Share+grant before either replay confirmation or a fresh CAS so
        // a committed grant withdrawal blocks old requests and replays.
        const authorization = await repository.getShareGrantForWrite(identity.id, req.params.id);
        if (!authorization || authorization.grant?.can_read !== true || authorization.grant?.can_update !== true) {
          return response => sendApiRevisionError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有编辑授权');
        }

        if (existingOperation) {
          const outcome = await classifyOperationReplay(repository, {
            record: existingOperation,
            requestDigest,
            requireRestoreSource: true
          });
          if (outcome.kind === 'conflict') {
            return response => sendApiRevisionError(req, response, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
          }
          if (outcome.kind === 'result-unavailable' || outcome.replayPurged) {
            return response => sendApiRevisionError(req, response, 410, 'RESULT_UNAVAILABLE', '该操作已提交，但来源或结果版本已不可用');
          }
          const row = outcome.revisionRow;
          return respondWithSnapshot({
            revision: outcome.record.result_revision,
            snapshot: {
              htmlContent: row.html_content,
              codeType: row.code_type,
              title: row.title,
              description: row.description,
              markdownTheme: row.markdown_theme
            },
            changed: outcome.receipt?.changed === true,
            replayed: true
          });
        }

        const source = await repository.getContentRevision(req.params.id, sourceRevision);
        if (!source) {
          return response => sendApiRevisionError(req, response, 404, 'REVISION_NOT_FOUND', 'Restore source revision not found');
        }
        if (source.purged_at !== null && source.purged_at !== undefined || typeof source.html_content !== 'string') {
          return response => sendApiRevisionError(req, response, 410, 'REVISION_PURGED', 'Restore source revision has been purged');
        }

        const restored = await repository.restorePageRevision(req.params.id, {
          sourceRevision,
          expectedContentRevision: baseline.revision,
          actorSource: 'api-restore',
          actorIdentity: `api-key:${identity.id}`,
          returnUpdated: true
        });
        if (!restored?.page) {
          return response => sendApiRevisionError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有编辑授权');
        }
        const page = restored.page;
        const revision = String(page.current_revision);
        await repository.createAuditLog({
          action: 'page.restore',
          pageId: req.params.id,
          details: JSON.stringify({ sourceRevision, revision, changed: restored.changed, source: 'api' }),
          ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
        await repository.createPublishingOperation({
          actor_namespace: namespace,
          request_id: requestId,
          action: 'restore',
          request_digest: requestDigest,
          target_id: req.params.id,
          result_share_id: req.params.id,
          result_revision: revision,
          result_access_revision: String(page.access_revision),
          receipt_encrypted: encodeOperationReceipt({ changed: restored.changed, sourceRevision }),
          created_at: Date.now()
        });
        return respondWithSnapshot({
          revision,
          snapshot: {
            htmlContent: page.html_content,
            codeType: page.code_type || 'html',
            title: page.title,
            description: page.description,
            markdownTheme: page.markdown_theme
          },
          changed: restored.changed
        });
      }, { apiKeyIdentity: identity, publishingOperation });
      return respond(res);
    } catch (error) {
      if (error.code === 'INVALID_API_KEY') return sendApiRevisionError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
      if (error.code === 'PUBLISHING_MAINTENANCE') return sendApiRevisionError(req, res, 503, error.code, error.message, true);
      if (['55P03', '40P01', '57014'].includes(error.code)) {
        return sendApiRevisionError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share restore is temporarily unavailable', true);
      }
      if (error.code === 'CONTENT_PRECONDITION_REQUIRED' || error.code === 'INVALID_CONTENT_REVISION'
        || error.code === 'CONTENT_REVISION_CONFLICT') {
        return sendApiRevisionError(req, res, error.status || 400, error.code, error.message);
      }
      if (error.code === '23505') return sendApiRevisionError(req, res, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
      console.error('Managed-Key restore failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
      return sendApiRevisionError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share restore is temporarily unavailable', true);
    }
  });

app.put(SHARE_CONTENT_UPDATE.path, privateNoStore, (req, res, next) => {
  req.apiContentUpdateEndpoint = true;
  req.apiUpdateRequestId = req.get('Idempotency-Key');
  return next();
}, requireApiKey, requireApiContentUpdateScopes, validateApiContentUpdateHeaders, parseApiContentUpdateJson, async (req, res) => {
  const validation = validateApiContentUpdateInput(req.body);
  if (validation.error) {
    return sendApiContentUpdateError(req, res, 400, validation.code, validation.error);
  }
  const { htmlContent, title, description, markdownTheme, codeType } = req.body;
  const baseline = req.apiUpdateBaseline;
  const digestInput = normalizeContentUpdateDigestInput({
    expectedRevision: baseline.revision, htmlContent, title, description, markdownTheme, codeType
  });
  const identity = req.apiKeyIdentity;
  const namespace = resolveApiNamespace(req);
  const requestId = req.apiUpdateRequestId;
  const publishingOperation = {
    actorNamespace: namespace,
    requestId,
    action: 'content-update',
    targetId: req.params.id,
    requestDigest: createRequestDigest(digestInput.fields, {
      action: 'content-update', targetId: req.params.id, presence: digestInput.presence
    })
  };
  const buildResponse = ({ revision, snapshot, changed, replayed = false }) => response => {
    const etag = contentEtag(req.params.id, String(revision));
    const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
    const url = `${base.replace(/\/+$/, '')}/view/${encodeURIComponent(req.params.id)}`;
    response.set('ETag', etag);
    return response.json({
      success: true,
      action: 'content-update',
      requestId,
      changed,
      ...(replayed ? { replayed: true } : {}),
      url,
      page: {
        id: req.params.id,
        currentRevision: String(revision),
        htmlContent: snapshot.htmlContent,
        codeType: snapshot.codeType,
        title: snapshot.title,
        description: snapshot.description,
        markdownTheme: snapshot.markdownTheme
      }
    });
  };

  try {
    const respond = await publishing.run(async (repository, existingOperation) => {
      // The grant and Share are locked only after the Key and operation locks.
      // This makes permission revocation serialize before an in-flight write,
      // and replays remain unavailable after a grant is withdrawn.
      const authorization = await repository.getShareGrantForWrite(identity.id, req.params.id);
      if (!authorization || authorization.grant?.can_read !== true || authorization.grant?.can_update !== true) {
        return response => sendApiContentUpdateError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有编辑授权');
      }

      if (existingOperation) {
        const outcome = await classifyOperationReplay(repository, {
          record: existingOperation,
          requestDigest: publishingOperation.requestDigest
        });
        if (outcome.kind === 'conflict') {
          return response => sendApiContentUpdateError(req, response, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
        }
        if (outcome.kind === 'result-unavailable' || outcome.replayPurged) {
          return response => sendApiContentUpdateError(req, response, 410, 'RESULT_UNAVAILABLE', '该操作已提交，但其结果版本已不可用');
        }
        const revision = String(outcome.record.result_revision);
        const receipt = outcome.receipt || {};
        const row = outcome.revisionRow;
        return buildResponse({
          revision,
          snapshot: {
            htmlContent: row.html_content,
            codeType: row.code_type,
            title: row.title,
            description: row.description,
            markdownTheme: row.markdown_theme
          },
          changed: receipt.changed === true,
          replayed: true
        });
      }

      const page = authorization.page;
      const currentCodeType = page.code_type || 'html';
      if (codeType !== undefined && codeType !== currentCodeType) {
        return response => sendApiContentUpdateError(req, response, 400, 'INVALID_UPDATE_INPUT', 'Share 的 codeType 创建后固定，不能修改');
      }
      const knownThemes = new Set(getMarkdownThemeOptions().map(option => option.id));
      if ((currentCodeType === 'markdown' && (typeof markdownTheme !== 'string' || !knownThemes.has(markdownTheme)))
        || (currentCodeType !== 'markdown' && markdownTheme !== null)) {
        return response => sendApiContentUpdateError(req, response, 400, 'INVALID_UPDATE_INPUT', 'markdownTheme 必须是已知 Markdown Preset；非 Markdown 内容必须为 null');
      }

      const updateOptions = {
        htmlContent,
        title: title === null ? null : String(title).trim() || null,
        description: description === null ? null : String(description).trim() || null,
        markdownTheme: currentCodeType === 'markdown' ? markdownTheme : null,
        expectedContentRevision: baseline.revision,
        contentPrecondition: true,
        returnUpdated: true,
        actorSource: 'api-content-update',
        actorIdentity: `api-key:${identity.id}`
      };
      const previousRevision = String(page.current_revision);
      const updated = await repository.updatePage(req.params.id, updateOptions);
      if (!updated) {
        return response => sendApiContentUpdateError(req, response, 404, 'SHARE_NOT_FOUND', 'Share 不存在或没有编辑授权');
      }
      const revision = String(updated.current_revision);
      const changed = revision !== previousRevision;
      const snapshot = {
        htmlContent: updated.html_content,
        codeType: updated.code_type || 'html',
        title: updated.title,
        description: updated.description,
        markdownTheme: updated.markdown_theme || null
      };
      await repository.createAuditLog({
        action: 'page.update',
        pageId: req.params.id,
        details: JSON.stringify({
          fields: ['htmlContent', 'title', 'description', 'markdownTheme', ...(codeType !== undefined ? ['codeType'] : [])],
          revision,
          source: 'api'
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      });
      await repository.createPublishingOperation({
        actor_namespace: namespace,
        request_id: requestId,
        action: 'content-update',
        request_digest: publishingOperation.requestDigest,
        target_id: req.params.id,
        result_share_id: req.params.id,
        result_revision: revision,
        result_access_revision: String(updated.access_revision),
        receipt_encrypted: encodeOperationReceipt({ changed }),
        created_at: Date.now()
      });
      return buildResponse({ revision, snapshot, changed });
    }, { apiKeyIdentity: identity, publishingOperation });
    return respond(res);
  } catch (error) {
    if (error.code === 'INVALID_API_KEY') return sendApiContentUpdateError(req, res, 401, 'INVALID_API_KEY', 'Invalid API key');
    if (error.code === 'PUBLISHING_MAINTENANCE') return sendApiContentUpdateError(req, res, 503, 'PUBLISHING_MAINTENANCE', error.message, true);
    if (['55P03', '40P01', '57014'].includes(error.code)) {
      return sendApiContentUpdateError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share 写入暂时不可用，请稍后重试', true);
    }
    if (error.code === 'CONTENT_PRECONDITION_REQUIRED' || error.code === 'INVALID_CONTENT_REVISION' || error.code === 'CONTENT_REVISION_CONFLICT') {
      return sendApiContentUpdateError(req, res, error.status || 400, error.code, error.message);
    }
    if (error.code === '23505') return sendApiContentUpdateError(req, res, 409, 'REQUEST_ID_CONFLICT', '同一请求标识对应了不同的请求内容');
    console.error('API content update failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return sendApiContentUpdateError(req, res, 503, 'PUBLISHING_UNAVAILABLE', 'Share 写入暂时不可用，请稍后重试', true);
  }
});

app.get('/api/v1/operations/:requestId', privateNoStore, (req, res, next) => {
  req.apiRevisionEndpoint = true;
  req.apiUpdateRequestId = req.params.requestId;
  return next();
}, requireApiKey, async (req, res) => {
  const requestId = req.params.requestId;
  if (!isvalidRequestId(requestId)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', requestId: null, retryable: false, error: INVALID_REQUEST_ID_MESSAGE });
  }

  try {
    const actorNamespace = resolveApiNamespace(req);
    const respond = await publishing.run(async (repository, record) => {
      if (!record) {
        return response => response.status(404).json({ success: false, code: 'OPERATION_NOT_FOUND', requestId, retryable: false, error: '未找到该请求标识对应的操作' });
      }
      if (record.action === 'content-update' || record.action === 'restore') {
        const scopes = req.apiKeyIdentity?.scopes || [];
        const missing = [READ_SCOPE, 'share:update'].find(scope => !scopes.includes(scope));
        if (missing) {
          return response => response.status(403).json({ success: false, code: 'SCOPE_REQUIRED', scope: missing, requestId, retryable: false, error: '当前凭据缺少所需 scope' });
        }
        const authorization = await repository.getShareGrantForWrite(req.apiKeyIdentity.id, record.result_share_id);
        if (!authorization || authorization.grant?.can_read !== true || authorization.grant?.can_update !== true) {
          return response => response.status(404).json({ success: false, code: 'OPERATION_NOT_FOUND', requestId, retryable: false, error: '未找到该请求标识对应的操作' });
        }
        if (record.action === 'restore') {
          const outcome = await classifyOperationReplay(repository, {
            record,
            requestDigest: record.request_digest,
            requireRestoreSource: true
          });
          if (outcome.kind === 'result-unavailable' || outcome.replayPurged) {
            return response => response.status(410).json({ success: false, code: 'RESULT_UNAVAILABLE', requestId, retryable: false, error: '该操作已提交，但来源或结果版本已不可用' });
          }
        }
      }
      if (isPublishStateAction(record.action)) {
        const currentKey = await repository.getApiKeyById(req.apiKeyIdentity.id);
        if (!currentKey || !currentKey.scopes?.includes(PUBLISH_SCOPE)) {
          return response => response.status(403).json({
            success: false, code: 'SCOPE_REQUIRED', scope: PUBLISH_SCOPE, requestId,
            retryable: false, error: '当前凭据缺少所需 scope'
          });
        }
        const authorization = await repository.getShareGrantForWrite(req.apiKeyIdentity.id, record.result_share_id);
        if (!authorization || authorization.grant?.can_publish !== true) {
          return response => response.status(404).json({ success: false, code: 'OPERATION_NOT_FOUND', requestId, retryable: false, error: '未找到该请求标识对应的操作' });
        }
        const outcome = await classifyOperationReplay(repository, {
          record, requestDigest: record.request_digest
        });
        if (outcome.kind === 'result-unavailable') {
          return response => response.status(410).json({ success: false, code: 'RESULT_UNAVAILABLE', requestId, retryable: false, error: '该操作已提交，但其结果不可用' });
        }
        const projection = {
          ...operationStatusProjection(record),
          // This is the currently canonical public URL, not a URL persisted in
          // the operation receipt and not a historical access-state claim.
          url: publicPageUrl(req, outcome.page.id)
        };
        if (!outcome.accessUnchanged) {
          delete projection.accessRevision;
          projection.stateChangedSinceCommit = true;
        }
        return response => response.json({ success: true, requestId, operations: [projection] });
      }
      // Metadata only: no receipt, body, title/description or password.
      return response => response.json({ success: true, requestId, operations: [operationStatusProjection(record)] });
    }, {
      allowPaused: true,
      apiKeyIdentity: req.apiKeyIdentity,
      publishingOperation: { actorNamespace, requestId, action: 'status', targetId: null, requestDigest: '' }
    });
    return respond(res);
  } catch (error) {
    if (error.code === 'INVALID_API_KEY') return res.status(401).json({ success: false, code: 'INVALID_API_KEY', requestId, retryable: false, error: 'Invalid API key' });
    console.error('Operation status lookup failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return res.status(503).json({ success: false, code: 'PUBLISHING_UNAVAILABLE', requestId, retryable: true, error: '服务器暂时不可用' });
  }
});

app.post(CREATE_SHARE.path, privateNoStore, requireApiKey, parseShareJson, async (req, res) => {
  // Idempotency is opt-in by header; legacy unmarked clients keep their exact
  // behavior and are never claimed to be deduplicated.
  const requestId = req.get('Idempotency-Key');
  if (requestId !== undefined && !isvalidRequestId(requestId)) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST_ID', error: INVALID_REQUEST_ID_MESSAGE });
  }

  try {
    // Trusted actor identity: managed keys carry their logical key id;
    // legacy environment keys are recorded as such. Never the secret.
    const identity = req.apiKeyIdentity || {};
    const actorIdentity = identity.credentialKind === 'managed' ? `api-key:${identity.id}` : 'legacy-api-key';

    const respond = await runIdempotentCreate({
      input: req.body,
      namespace: resolveApiNamespace(req),
      requestId: requestId || null,
      provenance: { actorSource: 'api', actorIdentity },
      apiKeyIdentity: req.apiKeyIdentity,
      auditDetails: (result) => ({ codeType: result.codeType, isProtected: result.isProtected, source: 'api' }),
      clientIp: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      buildResponse: (res, result, replayed) => {
        const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
        const url = `${base.replace(/\/+$/, '')}/view/${result.id}`;
        return res.json({
          success: true,
          url,
          urlId: result.id,
          password: result.password,
          isProtected: result.isProtected,
          codeType: result.codeType,
          title: result.title,
          description: result.description,
          expiresAt: result.expiresAt,
          markdownTheme: result.markdownTheme,
          ...(requestId ? { requestId } : {}),
          ...(replayed ? { replayed: true } : {})
        });
      }
    });
    return respond(res);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'REQUEST_ID_CONFLICT',
        requestId: requestId || null,
        retryable: false,
        error: '同一请求标识对应了不同的请求内容'
      });
    }
    if (sendPublishingError(res, error)) return;
    console.error('Share API failed:', error);
    return res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.get('/api/pages/list/recent', requireApiAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit || '10', 10), 50);
    const pages = await pageRepository.listRecent(Number.isFinite(limit) ? limit : 10);

    return res.json({
      success: true,
      pages
    });
  } catch (error) {
    console.error('List recent pages failed:', error);
    return res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

app.get('/api/pages/:id', privateNoStore, async (req, res) => {
  try {
    const publicPage = await pageRepository.getPublicById(req.params.id, Date.now());

    const projection = publicShareProjection(publicPage, pageAccessRevision(req, req.params.id));
    if (projection.state !== 'readable') {
      return res.status(projection.status).json({ success: false, error: projection.error });
    }
    const { page } = projection;

    return res.json({
      success: true,
      page: {
        id: page.id,
        createdAt: page.created_at,
        codeType: page.code_type,
        title: page.title,
        description: page.description,
        isProtected: page.is_protected === 1,
        accessRevision: page.access_revision,
        expiresAt: page.expires_at,
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

// Read baseline for the existing protection operation, not a content-management API.
app.get('/api/pages/:id/protect', privateNoStore, requireApiAdmin, async (req, res) => {
  try {
    const baseline = await pageRepository.getProtectionBaseline(req.params.id);
    if (!baseline) return res.status(404).json({ success: false, error: '页面不存在' });
    return res.json({ success: true, accessRevision: baseline.accessRevision });
  } catch (error) {
    console.error('Get protection baseline failed:', { name: error?.name || 'Error', code: safeErrorCode(error) });
    return res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.post('/api/pages/:id/protect', privateNoStore, requireApiAdmin, parseSmallJson, requireCsrf, async (req, res) => {
  try {
    const respond = await publishing.run(async (repository) => {
      const page = await repository.getById(req.params.id);

      if (!page) {
        return (res) => res.status(404).json({
          success: false,
          error: '页面不存在'
        });
      }

      const isProtected = Boolean(req.body.isProtected);
      const customPassword = parseCustomPassword(req.body.password);

      if (customPassword.error) {
        return (res) => res.status(400).json({
          success: false,
          error: CUSTOM_PASSWORD_ERROR
        });
      }

      const expectedAccessRevision = requireAccessRevision(req.body.expectedAccessRevision);
      const password = isProtected
        ? (customPassword.provided ? customPassword.value : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
        : null;
      const passwordHash = password ? await hashSecret(password) : null;
      const encryptedPassword = password ? encryptSecret(password) : null;

      const saved = await repository.updateProtection(req.params.id, {
        isProtected,
        passwordHash,
        encryptedPassword,
        expectedAccessRevision,
        returnUpdated: true
      });
      if (!saved) return (res) => res.status(404).json({ success: false, error: 'Share not found' });

      return (res) => res.json({
        success: true,
        isProtected,
        password,
        accessRevision: saved.access_revision
      });
    });
    return respond(res);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    if (error.code?.startsWith('ACCESS_') || error.code === 'INVALID_ACCESS_REVISION') {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    console.error('Update page protection failed:', error);
    return res.status(500).json({
      success: false,
      error: '更新保护状态失败'
    });
  }
});

app.post('/view/:id/password', privateNoStore, parseSmallJson, async (req, res) => {
  try {
    const publicPage = await pageRepository.getPublicById(req.params.id, Date.now());

    if (!publicPage) {
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

    // Capture the revision with the hash before asynchronous password verification.
    const accessRevision = page.access_revision;
    const isValid = await verifySecret(req.body.password, page.password_hash || page.password);

    if (!isValid) {
      return res.status(401).json({
        valid: false
      });
    }

    setPageAccessCookie(res, req.params.id, accessRevision);
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

app.post('/view/:id/view-event', privateNoStore, async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.sendStatus(403);
  }

  try {
    const outcome = await publishing.run(repository => repository.recordViewEvent(
      req.params.id,
      Date.now(),
      pageAccessRevision(req, req.params.id)
    ), { allowPaused: true });

    if (outcome === 'not_found') {
      return res.sendStatus(404);
    }

    if (outcome === 'expired') {
      return res.sendStatus(410);
    }

    if (outcome === 'protected') {
      return res.sendStatus(403);
    }

    return outcome === 'counted' ? res.sendStatus(204) : res.sendStatus(500);
  } catch (error) {
    if (sendPublishingError(res, error)) return;
    console.error('Track page view failed:', {
      name: error?.name || 'Error',
      code: safeErrorCode(error)
    });
    return res.sendStatus(500);
  }
});

app.get('/view/:id', async (req, res) => {
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

    const projection = publicShareProjection(publicPage, pageAccessRevision(req, req.params.id));
    if (publicPage) {
      metrics.contentType = safeContentType(publicPage.page.code_type);
      metrics.protected = publicPage.page.is_protected === 1;
    }
    if (projection.state === 'missing' || projection.state === 'expired') {
      metrics.outcome = projection.state === 'missing' ? 'not_found' : 'expired';
      setTrustedUiCsp(res, { allowFraming: true });
      return res.status(projection.status).render('error', {
        title: projection.title,
        page: 'error-page',
        message: projection.message
      });
    }

    if (projection.state === 'locked') {
      metrics.outcome = 'password_required';
      setTrustedUiCsp(res, { allowFraming: true });
      return res.render('password', {
        title: projection.title,
        page: 'password-page',
        id: req.params.id,
        error: req.cookies?.[pageAccessCookieName(req.params.id)] ? '访问凭证已失效，请重新输入密码解锁。' : null
      });
    }

    const { page } = projection;
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
