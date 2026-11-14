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
const { createPageRepository } = require('./models/pageRepository');
const { detectCodeType, extractCodeBlocks } = require('./utils/codeDetector');
const { renderContent, escapeHtml } = require('./utils/contentRenderer');
const { FAVICON_VERSION } = require('./utils/faviconVersion');
const {
  getMarkdownThemeOptions,
  resolveMarkdownThemeId
} = require('./utils/markdownThemeCatalog');
const { derivePageTitle } = require('./utils/pageTitle');
const {
  accessRevisionMatches,
  parseExpectedAccessRevision,
  toAccessRevisionString
} = require('./utils/shareAccess');
const { projectPublicMetadata } = require('./utils/publicProjection');
const {
  formatContentEtag,
  isSnapshotPurged,
  parseContentIfMatch,
  toContentRevisionString
} = require('./utils/contentRevision');
const { isPublishingGateError } = require('./utils/publishing');
const {
  API_CONTENT_TYPES,
  CREATE_ONLY_SCOPES,
  buildCapabilities
} = require('./utils/apiCapabilities');
const {
  isApiKeyCredentialChangedError,
  legacyCredentialIdentity,
  managedCredentialIdentity,
  parseManagedApiKeyCredential,
  toCredentialVersionString
} = require('./utils/apiKeyIdentity');
const {
  browserOwnerNamespace,
  computeRequestHmac,
  dashboardNamespace,
  isIdempotencyConflictError,
  legacyKeyNamespace,
  managedKeyNamespace,
  namespaceKind,
  namespaceTag,
  parseIdempotencyKey,
  publishSessionNamespace
} = require('./utils/idempotency');
const { normalizeTitle } = require('./utils/pageTitle');
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
const ADMIN_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
// The accepted Share content types come from the shared capabilities
// definition (T05), so /api/v1/capabilities can never advertise a type the
// creation route would reject.
const VALID_CODE_TYPES = new Set(API_CONTENT_TYPES);
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
const parseSmallJson = bodyParser.json({ limit: config.smallBodyLimit });
const parseSmallForm = bodyParser.urlencoded({ extended: true, limit: config.smallBodyLimit });
const parseShareJson = bodyParser.json({ limit: config.shareBodyLimit });

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

function sendPublishingMaintenance(res) {
  return res.status(503).json({
    success: false,
    error: 'Publishing is paused for maintenance',
    code: 'maintenance',
    retryable: true
  });
}

// Write entrypoints answer a publishing-gate rejection (writes paused, or
// the gate busy draining) with the explicit maintenance 503 (T04) instead
// of a generic failure. Returns true when the response was sent.
function respondIfPublishingGate(res, error) {
  if (isPublishingGateError(error)) {
    sendPublishingMaintenance(res);
    return true;
  }

  return false;
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

// --- Anonymous publish sessions (T08, issue #32) --------------------------
//
// The homepage's unsigned publishing flow still needs a stable identity
// scope for idempotent creates, so the server mints a signed publish
// session (scoped token, 24h) and hands the browser a short fingerprint
// tag of the resulting namespace rather than the session value itself.
// The session grants nothing but a dedup scope: it cannot read a Share
// password, manage Shares, or call any Key-only endpoint — a request
// identifier alone never becomes an access credential.
const PUBLISH_SESSION_COOKIE = 'publish_session';
const PUBLISH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getPublishSession(req) {
  const token = req.cookies?.[PUBLISH_SESSION_COOKIE];
  const payload = verifyScopedToken(token, 'publish-session');

  if (!payload || typeof payload.sid !== 'string' || !payload.sid) {
    return null;
  }

  return { sid: payload.sid };
}

function mintPublishSessionCookie(res) {
  const sid = generateId(18);
  const token = createScopedToken('publish-session', { sid }, PUBLISH_SESSION_TTL_MS);
  res.cookie(PUBLISH_SESSION_COOKIE, token, {
    maxAge: PUBLISH_SESSION_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
  return { sid };
}

// The idempotency namespace + browser-visible tag for a homepage create:
// the signed-in owner's scope when a homepage admin session is present,
// else the anonymous publish session (minted on demand so even the very
// first submission is already namespaced). Anonymous sessions rotate
// when the cookie expires; a pending operation from an older session
// rebinds only through the explicit orphan choice on the page, never by
// silently claiming the old request identifier under a new namespace.
function browserCreateContext(req, res) {
  if (getAdminSession(req)) {
    const namespace = browserOwnerNamespace();
    return { namespace, sessionTag: namespaceTag(namespace) };
  }

  const session = getPublishSession(req) || mintPublishSessionCookie(res);
  const namespace = publishSessionNamespace(session.sid);
  return { namespace, sessionTag: namespaceTag(namespace) };
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

async function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');

  if (!key) {
    return res.status(401).json({ success: false, error: 'Missing X-API-Key header' });
  }

  if (config.shareApiKey) {
    const expected = Buffer.from(config.shareApiKey);
    const provided = Buffer.from(key);

    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      // The legacy environment credential has no database identity; the
      // request records only its kind (T05).
      req.apiCredential = legacyCredentialIdentity();
      return next();
    }
  }

  const parsed = parseManagedApiKeyCredential(key);

  if (!parsed) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  try {
    const apiKey = await pageRepository.getApiKeyById(parsed.id);
    const isValid = apiKey && await verifySecret(parsed.secret, apiKey.key_hash);

    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    req.managedApiKey = {
      id: apiKey.id,
      name: apiKey.name
    };
    // Record the credential identity exactly as first verified, including
    // the credential version. Publishing writes re-check this version
    // inside their transaction (T05), so a rotation or delete that commits
    // after this point invalidates the pending write.
    req.apiCredential = managedCredentialIdentity(apiKey);

    pageRepository.touchApiKey(apiKey.id).catch((error) => {
      console.error('API key usage update failed:', error);
    });

    return next();
  } catch (error) {
    console.error('API key validation failed:', error);
    return res.status(503).json({ success: false, error: 'API authentication unavailable' });
  }
}

// The instance's canonical origin for identity responses (T05): the
// configured public base URL when one exists, otherwise the origin this
// request actually arrived on.
function instanceOrigin(req) {
  if (config.baseUrl) {
    return config.baseUrl.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
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
  // The signed cookie binds the Share ID with the access revision that was
  // current when the password was verified (T01). Advancing the revision
  // therefore revokes this cookie immediately, even before its 24h TTL ends.
  const token = createScopedToken('page-access', {
    id,
    accessRevision: toAccessRevisionString(accessRevision)
  }, PAGE_ACCESS_TTL_MS);

  res.cookie(pageAccessCookieName(id), token, {
    maxAge: PAGE_ACCESS_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
}

function getPageAccess(req, id) {
  const token = req.cookies?.[pageAccessCookieName(id)];
  const payload = verifyScopedToken(token, 'page-access');

  // Legacy cookies issued before T01 carry no accessRevision and are no
  // longer accepted; the visitor is asked to unlock again.
  if (!payload || payload.id !== id || typeof payload.accessRevision !== 'string') {
    return null;
  }

  return payload;
}

function hasPageAccess(req, id, currentAccessRevision) {
  const payload = getPageAccess(req, id);

  if (!payload) {
    return false;
  }

  if (currentAccessRevision === undefined || currentAccessRevision === null) {
    return true;
  }

  return accessRevisionMatches(payload.accessRevision, currentAccessRevision);
}

// Shared expectedAccessRevision precondition handling for access-policy
// writes (T01): a missing precondition is 428, a stale one is 412, and an
// invalid format is 400. The latest revision is never filled in silently.
function checkAccessPrecondition(req, res, page) {
  const expected = parseExpectedAccessRevision(req.body?.expectedAccessRevision);

  if (!expected.provided) {
    res.status(428).json({
      success: false,
      error: '缺少 expectedAccessRevision，请刷新后重试'
    });
    return null;
  }

  if (!expected.valid) {
    res.status(400).json({
      success: false,
      error: 'expectedAccessRevision 必须为十进制字符串'
    });
    return null;
  }

  if (!accessRevisionMatches(page.access_revision, expected.value)) {
    res.status(412).json({
      success: false,
      error: '访问策略已被更新，请刷新后重试',
      accessRevision: toAccessRevisionString(page.access_revision)
    });
    return null;
  }

  return expected.value;
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

async function createPageWithRetry(data, { apiCredential, revisionMeta } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateId();

    try {
      await pageRepository.create({
        ...data,
        id
      }, { apiCredential, revisionMeta });

      return id;
    } catch (error) {
      lastError = error;

      if (!String(error.message || '').includes('UNIQUE') &&
          !String(error.code || '').includes('23505')) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Failed to create a unique page id');
}

function parseFutureExpiry(expiresAt, now) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
    return { value: null, error: null };
  }

  const value = Number(expiresAt);

  if (!Number.isSafeInteger(value) || value <= now) {
    return { value: null, error: '到期时间必须晚于当前时间' };
  }

  return { value, error: null };
}

// --- Idempotent create pipeline (T08, issue #32) --------------------------
//
// A create is split into three deterministic stages:
//   1. prepareCreateInput — format validation and the normalized request
//      view (field presence + the exact values the create will store).
//      Nothing derived exists yet: no Share ID, no generated password,
//      no creation time. The request digest (parent spec §8) is computed
//      over exactly this view, so a retry produces the same digest.
//   2. deriveCreateValues — the only place derived values come into
//      existence (creation time, expiry validation against that time,
//      auto title, generated password + hashes). For an idempotent
//      create it runs inside the repository transaction, after the
//      operation lookup missed, so a replay never derives anything.
//   3. The repository commits Share + Revision 1 + create audit +
//      operation record atomically (or replays the committed record).
//
// The expiry FUTURE check deliberately lives in stage 2, not stage 1:
// the spec's fixed order is format → permission → lookup → timeliness,
// so an operation that committed while its expiry was still in the
// future stays confirmable after the expiry passes.

class CreateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreateValidationError';
  }
}

function isCreateValidationError(error) {
  return Boolean(error) && error.name === 'CreateValidationError';
}

function prepareCreateInput(input) {
  const {
    htmlContent,
    codeType,
    title,
    description,
    expiresAt,
    isProtected,
    password: requestedPassword,
    markdownTheme
  } = input || {};

  if (!htmlContent || typeof htmlContent !== 'string') {
    return { error: '请提供内容' };
  }

  const customPassword = parseCustomPassword(requestedPassword);

  if (customPassword.error) {
    return { error: customPassword.error };
  }

  // Expiry FORMAT only at this stage (a present value must be an
  // epoch-ms integer); whether it is still in the future is a stage-2
  // timeliness check.
  const expiryPresent = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';
  let expiryValue = null;

  if (expiryPresent) {
    const parsed = Number(expiresAt);

    if (!Number.isSafeInteger(parsed)) {
      return { error: '到期时间必须晚于当前时间' };
    }

    expiryValue = parsed;
  }

  const present = (value) => value !== undefined && value !== null;
  const normalizedCodeType = normalizeCodeType(htmlContent, codeType);
  // The digest view mirrors exactly what the create stores: title in its
  // normalized form, description trimmed, code type and markdown theme
  // resolved. Presence is tracked separately from values so "field
  // absent" and "field present with an empty/neutral value" do not fold
  // into the same digest. A JSON null counts as absent for the optional
  // fields (create treats null and absent identically today).
  const presence = {
    codeType: present(codeType) ? 1 : 0,
    title: present(title) ? 1 : 0,
    description: present(description) ? 1 : 0,
    expiresAt: expiryPresent ? 1 : 0,
    isProtected: present(isProtected) ? 1 : 0,
    password: customPassword.provided ? 1 : 0,
    markdownTheme: present(markdownTheme) ? 1 : 0
  };
  const values = {
    htmlContent,
    codeType: normalizedCodeType,
    title: present(title) ? normalizeTitle(title) : null,
    description: present(description) ? String(description).trim() || null : null,
    expiresAt: expiryValue,
    isProtected: Boolean(isProtected),
    password: customPassword.provided ? customPassword.value : null,
    markdownTheme: normalizedCodeType === 'markdown'
      ? resolveMarkdownThemeId(markdownTheme)
      : null
  };

  return { error: null, presence, values, customPassword };
}

async function deriveCreateValues(prepared) {
  const { values } = prepared;
  const createdAt = Date.now();
  const expiry = parseFutureExpiry(values.expiresAt, createdAt);

  if (expiry.error) {
    throw new CreateValidationError(expiry.error);
  }

  const pageTitle = derivePageTitle(values.htmlContent, values.codeType, values.title, createdAt);
  const password = values.isProtected
    ? (prepared.customPassword.provided
      ? prepared.customPassword.value
      : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
    : null;
  const passwordHash = password ? await hashSecret(password) : null;
  const encryptedPassword = password ? encryptSecret(password) : null;

  return {
    pageData: {
      htmlContent: values.htmlContent,
      passwordHash,
      encryptedPassword,
      isProtected: Boolean(password),
      codeType: values.codeType,
      title: pageTitle,
      description: values.description,
      createdAt,
      expiresAt: expiry.value,
      markdownTheme: values.markdownTheme
    },
    password,
    pageTitle
  };
}

// The original-result receipt stored (encrypted) with the operation
// record: exactly the fields the create response returns, never the
// body. A replay serves these original values — not the Share's current
// state — subject to the policy checks in replayedCreatePayload.
function createResultReceipt(derived, id) {
  return {
    kind: 'share.create',
    shareId: id,
    password: derived.password,
    isProtected: derived.pageData.isProtected,
    codeType: derived.pageData.codeType,
    title: derived.pageTitle,
    description: derived.pageData.description,
    expiresAt: derived.pageData.expiresAt,
    markdownTheme: derived.pageData.markdownTheme,
    contentRevision: '1',
    contentEtag: formatContentEtag(id, '1')
  };
}

function createRevisionMeta(apiCredential) {
  // Every creation entry writes the Revision 1 baseline with the new
  // Share (T06); the snapshot provenance records which entry and actor
  // produced it.
  return apiCredential
    ? {
      source: 'api-create',
      actorType: 'api_key',
      actorId: apiCredential.keyId || null
    }
    : { source: 'web-create', actorType: 'owner', actorId: null };
}

// Runs an idempotent create through the repository. Returns the
// repository outcome: { outcome: 'created', result } for a first
// execution, { outcome: 'replayed' | 'unavailable', operation,
// shareState } for a repeat submission.
async function executeIdempotentCreate(req, { namespace, requestId, source, apiCredential }) {
  const prepared = prepareCreateInput(req.body);

  if (prepared.error) {
    throw new CreateValidationError(prepared.error);
  }

  const requestHmac = computeRequestHmac({
    action: 'share.create',
    targetId: null,
    presence: prepared.presence,
    values: prepared.values
  });

  return pageRepository.createIdempotent({
    operation: {
      actorNamespace: namespace,
      requestId,
      action: 'share.create',
      targetId: null,
      requestHmac
    },
    apiCredential,
    revisionMeta: createRevisionMeta(apiCredential),
    audit: {
      action: 'page.create',
      details: JSON.stringify({
        codeType: prepared.values.codeType,
        isProtected: prepared.values.isProtected,
        source,
        requestId
      }),
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    },
    prepare: async () => {
      const derived = await deriveCreateValues(prepared);
      const id = generateId();
      return {
        page: { ...derived.pageData, id },
        result: createResultReceipt(derived, id)
      };
    }
  });
}

// Turns a repository outcome into the create response payload, or null
// when the original result is no longer available (the caller answers
// 410). Replay payloads come from the encrypted receipt — the ORIGINAL
// result — re-checked against current state (parent spec §8):
//   - result Share gone / record tombstoned → unavailable;
//   - the result Revision's snapshot is gone (history storage cleared)
//     → the version's title/description are withheld, and so is the
//     password, which describes that protected version;
//   - access policy changed since (unprotected now, or the access
//     revision moved) → the generated password is NOT returned again;
//     only an untouched policy gets it back, per "敏感字段先核对当前
//     身份、目标和策略状态再决定是否重显".
function createOutcomePayload(outcome) {
  if (!outcome) {
    return null;
  }

  if (outcome.outcome === 'created') {
    return { ...outcome.result };
  }

  if (outcome.outcome !== 'replayed' || !outcome.shareState || !outcome.operation) {
    return null;
  }

  let receipt = null;

  try {
    const decrypted = outcome.operation.receiptEncrypted
      ? decryptSecret(outcome.operation.receiptEncrypted)
      : null;
    receipt = decrypted ? JSON.parse(decrypted) : null;
  } catch {
    receipt = null;
  }

  if (!receipt || receipt.kind !== 'share.create' || !receipt.shareId) {
    return null;
  }

  const payload = { ...receipt };

  if (!outcome.shareState.revisionExists) {
    payload.title = null;
    payload.description = null;
    payload.password = null;
    return payload;
  }

  if (payload.password) {
    const policyIntact = outcome.shareState.isProtected
      && accessRevisionMatches(
        outcome.shareState.accessRevision,
        outcome.operation.resultAccessRevision
      );

    if (!policyIntact) {
      payload.password = null;
    }
  }

  return payload;
}

// Decrypts the stored receipt of a committed publish operation (T08/T09).
// Receipts carry only the fields the original response needed — never a
// content body and, for the save/restore actions, no secret material at
// all — so a replay can return them verbatim as the operation's result.
function operationReceipt(operation) {
  if (!operation || !operation.receiptEncrypted) {
    return null;
  }

  try {
    const decrypted = decryptSecret(operation.receiptEncrypted);
    return decrypted ? JSON.parse(decrypted) : null;
  } catch {
    return null;
  }
}

// Parses the content If-Match of a save/restore request into the triple
// the repository judges inside its transaction (T09): the expected
// revision when the tag is one concrete strong content tag, or the
// missing/invalid markers otherwise. `digestValue` is what the request
// digest binds as the caller's expected version (parent spec §8): the
// revision itself, null when absent, or the raw malformed header, so a
// retry reproduces the digest exactly while any other expectation —
// including a now-current tag — is a different request.
function contentPreconditionState(req, shareId) {
  const parsed = parseContentIfMatch(req.get('if-match'), shareId);

  if (parsed.status === 'missing') {
    return {
      expectedContentRevision: null,
      contentPreconditionMissing: true,
      contentPreconditionInvalid: false,
      digestValue: null
    };
  }

  if (parsed.status !== 'ok') {
    return {
      expectedContentRevision: null,
      contentPreconditionMissing: false,
      contentPreconditionInvalid: true,
      digestValue: `invalid:${String(req.get('if-match'))}`
    };
  }

  return {
    expectedContentRevision: parsed.revision,
    contentPreconditionMissing: false,
    contentPreconditionInvalid: false,
    digestValue: parsed.revision
  };
}

async function createPageFromInput(input, { apiCredential } = {}) {
  const prepared = prepareCreateInput(input);

  if (prepared.error) {
    return { error: prepared.error };
  }

  let derived;

  try {
    derived = await deriveCreateValues(prepared);
  } catch (error) {
    if (isCreateValidationError(error)) {
      return { error: error.message };
    }

    throw error;
  }

  const id = await createPageWithRetry(derived.pageData, {
    apiCredential,
    revisionMeta: createRevisionMeta(apiCredential)
  });
  const receipt = createResultReceipt(derived, id);

  return {
    error: null,
    id,
    password: receipt.password,
    isProtected: receipt.isProtected,
    codeType: receipt.codeType,
    title: receipt.title,
    description: receipt.description,
    expiresAt: receipt.expiresAt,
    markdownTheme: receipt.markdownTheme,
    contentRevision: receipt.contentRevision,
    contentEtag: receipt.contentEtag
  };
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
  const sessionToken = req.adminSession?.token || req.cookies?.[ADMIN_COOKIE] || '';
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

app.get('/admin/apis', requireDashboardAdmin, async (req, res) => {
  try {
    const apiKeys = await pageRepository.listApiKeys();
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-apis', {
      title: 'QuickShare | API 管理',
      page: 'admin-apis',
      apiKeys,
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
    const name = String(req.body?.name || '').trim();

    if (!name || name.length > 80) {
      return res.status(400).json({
        success: false,
        error: 'Key name must be between 1 and 80 characters'
      });
    }

    const id = generateId(12);
    const secret = randomBytes(32).toString('base64url');
    const apiKey = await pageRepository.createApiKey({
      id,
      name,
      keyHash: await hashSecret(secret),
      keyPrefix: `qs.${id.slice(0, 8)}…`,
      createdAt: Date.now()
    });

    pageRepository.createAuditLog({
      action: 'api_key.create',
      pageId: null,
      details: JSON.stringify({ apiKeyId: apiKey.id, name: apiKey.name }),
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    }).catch((err) => { console.error('Audit log failed:', err); });

    return res.status(201).json({
      success: true,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        key_prefix: apiKey.key_prefix,
        created_at: apiKey.created_at,
        last_used_at: apiKey.last_used_at,
        credential_version: toCredentialVersionString(apiKey.credential_version),
        secret: `qs.${id}.${secret}`
      }
    });
  } catch (error) {
    console.error('Create API key failed:', error);
    if (respondIfPublishingGate(res, error)) {
      return;
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to create API key'
    });
  }
});

// Rotation (T05): the logical Key keeps its ID, name and creation time; a
// fresh secret replaces the old one and the credential version advances in
// the same gated write, so the old secret stops working the moment this
// succeeds — including for requests that already verified it but have not
// written yet. The new secret is shown only in this success response. A Key
// is a credential, not a Share owner: rotation changes nothing about any
// Share.
app.post('/admin/apis/keys/:id/rotate', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
  try {
    const secret = randomBytes(32).toString('base64url');
    const rotated = await pageRepository.rotateApiKey(req.params.id, {
      keyHash: await hashSecret(secret),
      keyPrefix: `qs.${req.params.id.slice(0, 8)}…`
    });

    if (!rotated) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }

    pageRepository.createAuditLog({
      action: 'api_key.rotate',
      pageId: null,
      details: JSON.stringify({
        apiKeyId: rotated.id,
        credentialVersion: toCredentialVersionString(rotated.credential_version)
      }),
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    }).catch((err) => { console.error('Audit log failed:', err); });

    return res.json({
      success: true,
      apiKey: {
        id: rotated.id,
        name: rotated.name,
        key_prefix: rotated.key_prefix,
        created_at: rotated.created_at,
        last_used_at: rotated.last_used_at,
        credential_version: toCredentialVersionString(rotated.credential_version),
        secret: `qs.${rotated.id}.${secret}`
      }
    });
  } catch (error) {
    console.error('Rotate API key failed:', error);
    if (respondIfPublishingGate(res, error)) {
      return;
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to rotate API key'
    });
  }
});

app.delete('/admin/apis/keys/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
  try {
    const deleted = await pageRepository.deleteApiKey(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }

    pageRepository.createAuditLog({
      action: 'api_key.delete',
      pageId: null,
      details: JSON.stringify({ apiKeyId: req.params.id }),
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    }).catch((err) => { console.error('Audit log failed:', err); });

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete API key failed:', error);
    if (respondIfPublishingGate(res, error)) {
      return;
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to delete API key'
    });
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
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

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

app.get('/admin/pages/:id/revisions', requireDashboardApiAdmin, async (req, res) => {
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

app.get('/admin/pages/:id/revisions/:revision', requireDashboardApiAdmin, async (req, res) => {
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

app.get('/admin/pages/:id/revisions/:revision/preview', requireDashboardAdmin, async (req, res) => {
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
app.post('/admin/pages/:id/revisions/:revision/restore', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
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
app.post('/admin/pages/:id/revisions/:revision/purge', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
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

app.put('/admin/pages/:id/favorite', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
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

app.post('/admin/pages/:id/revoke-access', requireDashboardApiAdmin, parseSmallJsonBody, requireDashboardCsrf, async (req, res) => {
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

app.put('/admin/pages/:id', requireDashboardAdmin, parseShareJson, requireDashboardCsrf, async (req, res) => {
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

app.delete('/admin/pages/batch', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
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

app.delete('/admin/pages/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
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

function respondOperationUnavailable(res, requestId) {
  return res.status(410).json({
    success: false,
    error: '该请求已提交，但其结果已不可用',
    code: 'operation_result_unavailable',
    requestId,
    retryable: false
  });
}

app.post('/admin/pages/:id/clone', requireDashboardAdmin, parseSmallForm, requireDashboardCsrf, async (req, res) => {
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

// Connection identity (T05): who this credential is, verified at request
// start. Returns the instance origin, the credential kind and — for managed
// Keys — the logical Key ID, name and current credential version. Never
// returns any secret or hash. This is a read: it stays available while
// publishing writes are paused for maintenance.
app.get('/api/v1/me', privateNoStore, requireApiKey, (req, res) => {
  const credential = req.apiCredential || legacyCredentialIdentity();

  return res.json({
    success: true,
    origin: instanceOrigin(req),
    credential: {
      type: credential.type,
      keyId: credential.keyId,
      name: credential.name,
      credentialVersion: credential.credentialVersion,
      scopes: [...CREATE_ONLY_SCOPES]
    }
  });
});

// Connection capabilities (T05): the API surface this instance and
// credential actually support, serialized from the single definition in
// utils/apiCapabilities.js that the routes themselves enforce. Contains no
// secret material and no per-resource data. Also a read: available during
// write maintenance, so an agent can still check its connection.
app.get('/api/v1/capabilities', privateNoStore, requireApiKey, (req, res) => {
  const credential = req.apiCredential || legacyCredentialIdentity();

  return res.json({
    success: true,
    origin: instanceOrigin(req),
    capabilities: buildCapabilities({ credentialType: credential.type })
  });
});

// Operation confirmation (T08): after a create response is lost, the
// caller confirms the outcome by its request identifier. The lookup is
// scoped to the caller's own credential namespace — a legacy Key can
// confirm its own creates, and this confirmation belongs to the create
// capability rather than granting any Share management. Only status and
// resource/version identifiers are returned: never a password, title,
// description or body, and never under a share-access authorization.
// This is a read: it stays available while writes are paused.
app.get('/api/v1/operations/:requestId', privateNoStore, requireApiKey, async (req, res) => {
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
    const credential = req.apiCredential || legacyCredentialIdentity();
    const namespace = credential.type === 'managed'
      ? managedKeyNamespace(credential.keyId)
      : legacyKeyNamespace(config.shareApiKey);
    const record = await pageRepository.getOperation(namespace, parsed.value);

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
      status: record.resultState,
      shareId: record.resultShareId,
      contentRevision: record.resultRevision,
      accessRevision: record.resultAccessRevision,
      createdAt: record.createdAt
    });
  } catch (error) {
    console.error('Operation lookup failed:', error);
    return res.status(500).json({ success: false, error: '服务器错误' });
  }
});

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

app.post('/api/v1/share', privateNoStore, requireApiKey, parseShareJson, async (req, res) => {
  // Idempotency-Key (T08): with the header, the create runs in the
  // caller's credential namespace — same key + same input replays the
  // original result, same key + different input is a 409. Without the
  // header the historical create runs unchanged (HTTP 200, same fields)
  // and is NOT idempotent.
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
      const credential = req.apiCredential || legacyCredentialIdentity();
      const namespace = credential.type === 'managed'
        ? managedKeyNamespace(credential.keyId)
        : legacyKeyNamespace(config.shareApiKey);
      const outcome = await executeIdempotentCreate(req, {
        namespace,
        requestId: idem.value,
        source: 'api',
        apiCredential: credential
      });
      const payload = createOutcomePayload(outcome);

      if (!payload) {
        return respondOperationUnavailable(res, idem.value);
      }

      const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
      const url = `${base.replace(/\/+$/, '')}/view/${payload.shareId}`;

      return res.json({
        success: true,
        url,
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

    const result = await createPageFromInput(req.body, { apiCredential: req.apiCredential });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
    const url = `${base.replace(/\/+$/, '')}/view/${result.id}`;

    pageRepository.createAuditLog({
      action: 'page.create',
      pageId: result.id,
      details: JSON.stringify({ codeType: result.codeType, isProtected: result.isProtected, source: 'api' }),
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
    }).catch((err) => { console.error('Audit log failed:', err); });

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
      contentRevision: result.contentRevision,
      contentEtag: result.contentEtag
    });
  } catch (error) {
    console.error('Share API failed:', error);
    // The credential was rotated or deleted after this request verified
    // it: the write was refused inside its transaction (T05). From the
    // client's side the presented credential is simply no longer valid.
    if (isApiKeyCredentialChangedError(error)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key',
        code: 'api_key_credential_changed',
        retryable: false
      });
    }
    if (isCreateValidationError(error)) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (isIdempotencyConflictError(error)) {
      return res.status(409).json({
        success: false,
        error: 'Idempotency-Key was already used with a different request',
        code: 'idempotency_conflict',
        requestId: idem.provided ? idem.value : null,
        retryable: false
      });
    }
    if (respondIfPublishingGate(res, error)) {
      return;
    }
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

app.get('/api/pages/:id', async (req, res) => {
  try {
    const publicPage = await pageRepository.getPublicById(req.params.id, Date.now());

    if (!publicPage) {
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

app.post('/view/:id/view-event', privateNoStore, async (req, res) => {
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
