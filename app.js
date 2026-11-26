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
  setTrustedUiCsp
} = require('./middleware/responsePolicy');
const { createBodyParsers } = require('./middleware/bodyParsers');
const { createApiV1Router } = require('./routes/apiV1');
const { createViewRouter } = require('./routes/view');
const { createPublishRouter } = require('./routes/publish');
const { createLoginRouter } = require('./routes/login');
const { createAdminRouter } = require('./routes/admin');
const { createAdminApiKeysRouter } = require('./routes/adminApiKeys');
const { createPageRepository } = require('./models/pageRepository');
const { createShareOperations } = require('./services/shareOperations');
const { FAVICON_VERSION } = require('./utils/faviconVersion');
const { createPublicUrls } = require('./utils/publicUrls');

const {
  formatManagementDateTime,
  toManagementDateTimeLocal
} = require('./utils/management-time');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FAVICON_PATH = path.join(PUBLIC_DIR, 'icon/web/favicon.ico');
const STATIC_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

const app = express();
const pageRepository = createPageRepository();
const auth = createAuth({ config, pageRepository });
const publicUrls = createPublicUrls(config);
const parsers = createBodyParsers(config);
const {
  parseSmallJson
} = parsers;
const shareOps = createShareOperations({ config, pageRepository });
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

app.use(createLoginRouter({ config, pageRepository, auth, parsers }));

app.use(createAdminApiKeysRouter({ config, pageRepository, auth, parsers }));

app.use(createAdminRouter({ config, pageRepository, auth, publicUrls, shareOps, parsers }));

app.use(createPublishRouter({ pageRepository, auth, publicUrls, shareOps, parsers }));

app.use(createApiV1Router({ config, pageRepository, auth, publicUrls, shareOps, parsers }));

app.use(createViewRouter({ config, pageRepository, auth, publicUrls, parseSmallJson }));

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
