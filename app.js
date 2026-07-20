require('dotenv').config();

const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { performance } = require('node:perf_hooks');

const config = require('./config');
const { createPageRepository } = require('./models/pageRepository');
const { detectCodeType, extractCodeBlocks } = require('./utils/codeDetector');
const { renderContent, escapeHtml, resolveTheme } = require('./utils/contentRenderer');
const { derivePageTitle } = require('./utils/pageTitle');
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
const VALID_CODE_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);
const PUBLIC_DIR = path.join(__dirname, 'public');
const FAVICON_PATH = path.join(PUBLIC_DIR, 'icon/web/favicon.ico');
const STATIC_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
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
const { randomBytes, timingSafeEqual } = require('crypto');
let nextViewRequestIsColdStart = true;

const app = express();
const pageRepository = createPageRepository();
const parseSmallJson = bodyParser.json({ limit: config.smallBodyLimit });
const parseSmallForm = bodyParser.urlencoded({ extended: true, limit: config.smallBodyLimit });
const parseShareJson = bodyParser.json({ limit: config.shareBodyLimit });

app.locals.config = config;
app.locals.pageRepository = pageRepository;
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
      return next();
    }
  }

  const match = /^qs\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,})$/.exec(key);

  if (!match) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  try {
    const apiKey = await pageRepository.getApiKeyById(match[1]);
    const isValid = apiKey && await verifySecret(match[2], apiKey.key_hash);

    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    req.managedApiKey = {
      id: apiKey.id,
      name: apiKey.name
    };

    pageRepository.touchApiKey(apiKey.id).catch((error) => {
      console.error('API key usage update failed:', error);
    });

    return next();
  } catch (error) {
    console.error('API key validation failed:', error);
    return res.status(503).json({ success: false, error: 'API authentication unavailable' });
  }
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

function setPageAccessCookie(res, id) {
  const token = createScopedToken('page-access', { id }, PAGE_ACCESS_TTL_MS);

  res.cookie(pageAccessCookieName(id), token, {
    maxAge: PAGE_ACCESS_TTL_MS,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax'
  });
}

function hasPageAccess(req, id) {
  const token = req.cookies?.[pageAccessCookieName(id)];
  const payload = verifyScopedToken(token, 'page-access');

  return payload?.id === id;
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

async function createPageWithRetry(data) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateId();

    try {
      await pageRepository.create({
        ...data,
        id
      });

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

async function createPageFromInput(input) {
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

  const createdAt = Date.now();
  const expiry = parseFutureExpiry(expiresAt, createdAt);

  if (expiry.error) {
    return { error: expiry.error };
  }

  const normalizedCodeType = normalizeCodeType(htmlContent, codeType);
  const pageTitle = derivePageTitle(htmlContent, normalizedCodeType, title, createdAt);
  const pageDescription = description === undefined || description === null
    ? null
    : String(description).trim() || null;
  const password = Boolean(isProtected)
    ? (customPassword.provided ? customPassword.value : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
    : null;
  const passwordHash = password ? await hashSecret(password) : null;
  const encryptedPassword = password ? encryptSecret(password) : null;
  const resolvedTheme = normalizedCodeType === 'markdown'
    ? resolveTheme(markdownTheme || 'random')
    : null;
  const id = await createPageWithRetry({
    htmlContent,
    passwordHash,
    encryptedPassword,
    isProtected: Boolean(password),
    codeType: normalizedCodeType,
    title: pageTitle,
    description: pageDescription,
    createdAt,
    expiresAt: expiry.value,
    markdownTheme: resolvedTheme
  });

  return {
    error: null,
    id,
    password,
    isProtected: Boolean(password),
    codeType: normalizedCodeType,
    title: pageTitle,
    description: pageDescription,
    expiresAt: expiry.value,
    markdownTheme: resolvedTheme
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
      <meta property="og:title" content="${pageTitle}">
      <meta property="og:description" content="${ogDescription}">
      <meta property="og:type" content="article">
      ${ogUrl ? `<meta property="og:url" content="${ogUrl}">` : ''}
      <meta property="og:image" content="/icon/web/icon-512.png">
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
  const base = config.shareBaseUrl || config.baseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/+$/, '')}/view/${encodeURIComponent(id)}`;
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

  return res.render('index', {
    title: 'QuickShare | 粘贴代码，一键分享',
    page: 'home-page',
    csrfToken: req.homepageAccessMode === 'locked' ? createCsrfToken(sessionToken) : ''
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
        secret: `qs.${id}.${secret}`
      }
    });
  } catch (error) {
    console.error('Create API key failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create API key'
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
    return res.status(500).json({
      success: false,
      error: 'Failed to delete API key'
    });
  }
});

app.get('/admin/pages/export', requireDashboardAdmin, async (req, res) => {
  try {
    const pages = await pageRepository.listAdminPages({ limit: 10000, offset: 0 });
    const exportData = pages.map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      codeType: page.code_type,
      isProtected: page.is_protected === 1,
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
      expiresAt: sharedPage.expires_at,
      markdownTheme: sharedPage.markdown_theme
    };
    const sessionToken = req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';

    return res.render('admin-page-detail', {
      title: `QuickShare | ${sharedPage.id}`,
      page: 'admin-page-detail',
      csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : '',
      sharedPage: pageData,
      pageDataJson: serializeJsonForHtml(pageData),
      publicUrl: publicPageUrl(req, sharedPage.id)
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
    return res.status(500).json({
      success: false,
      error: 'Failed to update favorite'
    });
  }
});

app.put('/admin/pages/:id', requireDashboardAdmin, parseShareJson, requireDashboardCsrf, async (req, res) => {
  try {
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
    if (markdownTheme !== undefined) {
      updateOptions.markdownTheme = markdownTheme ? resolveTheme(markdownTheme) : null;
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

    await pageRepository.updatePage(req.params.id, updateOptions);

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
        markdownTheme: updatedPage.markdown_theme,
        createdAt: updatedPage.created_at
      }
    });
  } catch (error) {
    console.error('Update page failed:', error);
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
    return res.status(500).json({
      success: false,
      error: 'Failed to delete page'
    });
  }
});

app.post('/admin/pages/:id/clone', requireDashboardAdmin, parseSmallForm, requireDashboardCsrf, async (req, res) => {
  try {
    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).json({ success: false, error: 'Page not found' });
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
      markdownTheme: page.markdown_theme
    });

    return res.redirect('/admin/pages/' + encodeURIComponent(newId));
  } catch (error) {
    console.error('Clone page failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to clone page' });
  }
});

app.post('/api/pages/create', privateNoStore, requireBrowserPublishAccess, parseShareJson, requireBrowserPublishCsrf, async (req, res) => {
  try {
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
      markdownTheme: result.markdownTheme
    });
  } catch (error) {
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
        description: description ? String(description).trim() : null
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

app.post('/api/v1/share', privateNoStore, requireApiKey, parseShareJson, async (req, res) => {
  try {
    const result = await createPageFromInput(req.body);

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
      markdownTheme: result.markdownTheme
    });
  } catch (error) {
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

    return res.json({
      success: true,
      page: {
        id: page.id,
        createdAt: page.created_at,
        codeType: page.code_type,
        title: page.title,
        description: page.description,
        isProtected: page.is_protected === 1,
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

    const password = isProtected
      ? (customPassword.provided ? customPassword.value : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
      : null;
    const passwordHash = password ? await hashSecret(password) : null;
    const encryptedPassword = password ? encryptSecret(password) : null;

    await pageRepository.updateProtection(req.params.id, {
      isProtected,
      passwordHash,
      encryptedPassword
    });

    return res.json({
      success: true,
      isProtected,
      password
    });
  } catch (error) {
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

    const isValid = await verifySecret(req.body.password, page.password_hash || page.password);

    if (!isValid) {
      return res.status(401).json({
        valid: false
      });
    }

    setPageAccessCookie(res, req.params.id);
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
    const outcome = await pageRepository.recordViewEvent(
      req.params.id,
      Date.now(),
      hasPageAccess(req, req.params.id)
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

    return outcome === 'counted' ? res.sendStatus(204) : res.sendStatus(500);
  } catch (error) {
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

    if (page.is_protected === 1 && !hasPageAccess(req, req.params.id)) {
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
