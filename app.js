require('dotenv').config();

const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { createPageRepository } = require('./models/pageRepository');
const { detectCodeType, extractCodeBlocks } = require('./utils/codeDetector');
const { renderContent, escapeHtml } = require('./utils/contentRenderer');
const { derivePageTitle } = require('./utils/pageTitle');
const {
  DEFAULT_PASSWORD_LENGTH,
  createCsrfToken,
  createScopedToken,
  decryptSecret,
  encryptSecret,
  generateId,
  generateNumericPassword,
  hashSecret,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
} = require('./utils/security');

const ADMIN_COOKIE = 'admin_session';
const DASHBOARD_ADMIN_COOKIE = 'dashboard_admin_session';
const ADMIN_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_CODE_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);
const timingSafeEqual = require('crypto').timingSafeEqual;

const app = express();
const pageRepository = createPageRepository();

let initPromise = null;

app.locals.config = config;
app.locals.pageRepository = pageRepository;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);

app.use(morgan(config.logLevel));
app.use(cors({ origin: false }));
app.use(bodyParser.json({ limit: '15mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDatabase() {
  if (!initPromise) {
    initPromise = pageRepository.init();
  }

  return initPromise;
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

function requireAdmin(req, res, next) {
  if (!config.authEnabled) {
    return next();
  }

  const session = getAdminSession(req);

  if (!session) {
    return res.redirect('/login');
  }

  req.adminSession = session;
  return next();
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

function requireApiKey(req, res, next) {
  if (!config.shareApiKey) {
    return res.status(503).json({ success: false, error: 'API key not configured' });
  }

  const key = req.get('x-api-key');
  if (!key) {
    return res.status(401).json({ success: false, error: 'Missing X-API-Key header' });
  }

  const expected = Buffer.from(config.shareApiKey);
  const provided = Buffer.from(key);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  return next();
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

function injectCodeTypeMeta(renderedContent, contentType) {
  if (!renderedContent.includes('</head>')) {
    return renderedContent;
  }

  return renderedContent.replace(
    '</head>',
    `<meta name="code-type" content="${escapeHtml(contentType)}">\n</head>`
  );
}

function renderSandboxedDocument(renderedContent, contentType) {
  const escapedContent = escapeHtml(renderedContent);

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="code-type" content="${escapeHtml(contentType)}">
      <title>QuickShare Viewer</title>
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
    </body>
    </html>
  `;
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

app.post('/login', async (req, res) => {
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

app.post('/admin/login', async (req, res) => {
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
  return res.redirect('/admin/stats');
});

app.get('/admin/logout', (req, res) => {
  clearDashboardAdminCookie(res);
  return res.redirect('/admin/login');
});

app.get('/', requireAdmin, (req, res) => {
  const sessionToken = req.adminSession?.token || req.cookies?.[ADMIN_COOKIE] || '';

  return res.render('index', {
    title: 'QuickShare | 粘贴代码，一键分享',
    page: 'home-page',
    csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : ''
  });
});

app.get('/admin', (req, res) => {
  if (!config.authEnabled || getDashboardAdminSession(req)) {
    return res.redirect('/admin/stats');
  }

  return res.redirect('/admin/login');
});

app.get('/admin/pages', requireDashboardAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const requestedPagination = parsePagination(req.query);
    const filterOptions = {
      search: req.query.search || '',
      codeType: req.query.type || '',
      isProtected: req.query.status || ''
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

    return res.render('admin-pages', {
      title: 'QuickShare | Admin Pages',
      page: 'admin-pages',
      pages: visiblePages,
      pagination: {
        ...pagination,
        total,
        totalPages,
        hasPrevious: pagination.page > 1,
        hasNext: pagination.page < totalPages
      },
      filters: {
        search: filterOptions.search,
        type: filterOptions.codeType,
        status: filterOptions.isProtected,
        sort: sortBy,
        order: sortOrder
      },
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

app.get('/admin/stats', requireDashboardAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const stats = enrichAdminStats(await pageRepository.getAdminStats());

    return res.render('admin-stats', {
      title: 'QuickShare | Admin Stats',
      page: 'admin-stats',
      stats
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

app.get('/admin/pages/:id', requireDashboardAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const sharedPage = await pageRepository.getById(req.params.id);

    if (!sharedPage) {
      return res.status(404).render('error', {
        title: 'Page Not Found',
        page: 'error-page',
        message: 'The requested shared page does not exist'
      });
    }

    return res.render('admin-page-detail', {
      title: `QuickShare | ${sharedPage.id}`,
      page: 'admin-page-detail',
      sharedPage: {
        id: sharedPage.id,
        htmlContent: sharedPage.html_content,
        createdAt: sharedPage.created_at,
        codeType: sharedPage.code_type,
        title: sharedPage.title,
        description: sharedPage.description,
        isProtected: sharedPage.is_protected === 1,
        password: visiblePagePassword(sharedPage),
        expiresAt: sharedPage.expires_at
      },
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

app.put('/admin/pages/:id', requireDashboardAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: 'Page not found'
      });
    }

    const { title, description, htmlContent, expiresAt, isProtected, password } = req.body;
    const updateOptions = {};

    if (title !== undefined) {
      updateOptions.title = title.trim() || null;
    }
    if (description !== undefined) {
      updateOptions.description = description.trim() || null;
    }
    if (htmlContent !== undefined) {
      updateOptions.htmlContent = htmlContent;
    }
    if (expiresAt !== undefined) {
      const parsed = Number.parseInt(expiresAt, 10);
      updateOptions.expiresAt = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    if (isProtected !== undefined) {
      const newProtected = Boolean(isProtected);
      const currentlyProtected = page.is_protected === 1;

      if (newProtected !== currentlyProtected) {
        updateOptions.isProtected = newProtected;

        if (newProtected) {
          const customPassword = password && String(password).trim();
          const finalPassword = customPassword || generateNumericPassword(DEFAULT_PASSWORD_LENGTH);
          updateOptions.passwordHash = await hashSecret(finalPassword);
          updateOptions.encryptedPassword = encryptSecret(finalPassword);
        } else {
          updateOptions.passwordHash = null;
          updateOptions.encryptedPassword = null;
        }
      } else if (newProtected && password && String(password).trim()) {
        // Protection status unchanged but password explicitly provided - update password
        const customPassword = String(password).trim();
        if (customPassword.length >= 4 && customPassword.length <= 50) {
          updateOptions.isProtected = true;
          updateOptions.passwordHash = await hashSecret(customPassword);
          updateOptions.encryptedPassword = encryptSecret(customPassword);
        }
      }
    }

    await pageRepository.updatePage(req.params.id, updateOptions);

    const updatedPage = await pageRepository.getById(req.params.id);

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

app.delete('/admin/pages/:id', requireDashboardAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: 'Page not found'
      });
    }

    await pageRepository.deletePage(req.params.id);

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

app.post('/api/pages/create', requireApiAdmin, requireCsrf, async (req, res) => {
  try {
    await ensureDatabase();

    const { htmlContent, isProtected, codeType, title, description, password: customPassword } = req.body;

    if (!htmlContent || typeof htmlContent !== 'string') {
      return res.status(400).json({
        success: false,
        error: '请提供内容'
      });
    }

    const normalizedCodeType = normalizeCodeType(htmlContent, codeType);
    const createdAt = Date.now();
    const pageTitle = derivePageTitle(htmlContent, normalizedCodeType, title, createdAt);
    const password = isProtected ? (customPassword && String(customPassword).trim() ? String(customPassword).trim() : generateNumericPassword(DEFAULT_PASSWORD_LENGTH)) : null;
    const passwordHash = password ? await hashSecret(password) : null;
    const encryptedPassword = password ? encryptSecret(password) : null;
    const id = await createPageWithRetry({
      htmlContent,
      passwordHash,
      encryptedPassword,
      isProtected: Boolean(isProtected),
      codeType: normalizedCodeType,
      title: pageTitle,
      description,
      createdAt,
      expiresAt: null
    });

    return res.json({
      success: true,
      urlId: id,
      password,
      isProtected: Boolean(password),
      codeType: normalizedCodeType
    });
  } catch (error) {
    console.error('Create page failed:', error);
    return res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

app.post('/api/v1/share', requireApiKey, async (req, res) => {
  try {
    await ensureDatabase();

    const { htmlContent, codeType, title, description, isProtected, password: customPassword } = req.body;

    if (!htmlContent || typeof htmlContent !== 'string') {
      return res.status(400).json({ success: false, error: '请提供内容' });
    }

    const normalizedCodeType = normalizeCodeType(htmlContent, codeType);
    const createdAt = Date.now();
    const pageTitle = derivePageTitle(htmlContent, normalizedCodeType, title, createdAt);
    const password = isProtected ? (customPassword && String(customPassword).trim() ? String(customPassword).trim() : generateNumericPassword(DEFAULT_PASSWORD_LENGTH)) : null;
    const passwordHash = password ? await hashSecret(password) : null;
    const encryptedPassword = password ? encryptSecret(password) : null;
    const id = await createPageWithRetry({
      htmlContent,
      passwordHash,
      encryptedPassword,
      isProtected: Boolean(isProtected),
      codeType: normalizedCodeType,
      title: pageTitle,
      description,
      createdAt,
      expiresAt: null
    });

    const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
    const url = `${base.replace(/\/+$/, '')}/view/${id}`;

    return res.json({
      success: true,
      url,
      urlId: id,
      password,
      isProtected: Boolean(password),
      codeType: normalizedCodeType
    });
  } catch (error) {
    console.error('Share API failed:', error);
    return res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.get('/api/pages/list/recent', requireApiAdmin, async (req, res) => {
  try {
    await ensureDatabase();

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
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: '页面不存在'
      });
    }

    return res.json({
      success: true,
      page: {
        id: page.id,
        createdAt: page.created_at,
        codeType: page.code_type,
        title: page.title,
        description: page.description,
        isProtected: page.is_protected === 1
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

app.post('/api/pages/:id/protect', requireApiAdmin, requireCsrf, async (req, res) => {
  try {
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: '页面不存在'
      });
    }

    const isProtected = Boolean(req.body.isProtected);
    const customPassword = req.body.password && String(req.body.password).trim();
    const password = isProtected ? (customPassword || generateNumericPassword(DEFAULT_PASSWORD_LENGTH)) : null;
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

app.post('/view/:id/password', async (req, res) => {
  try {
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page || page.is_protected !== 1) {
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

app.get('/view/:id', async (req, res) => {
  try {
    await ensureDatabase();

    const page = await pageRepository.getById(req.params.id);

    if (!page) {
      return res.status(404).render('error', {
        title: '页面未找到',
        page: 'error-page',
        message: '您请求的页面不存在或已被删除'
      });
    }

    if (page.is_protected === 1 && !hasPageAccess(req, req.params.id)) {
      return res.render('password', {
        title: 'QuickShare | 密码保护',
        page: 'password-page',
        id: req.params.id,
        passwordLength: DEFAULT_PASSWORD_LENGTH,
        error: null
      });
    }

    let processedContent = page.html_content;
    let contentType = page.code_type;
    const codeBlocks = extractCodeBlocks(page.html_content);

    if (!VALID_CODE_TYPES.has(contentType)) {
      contentType = normalizeCodeType(page.html_content, contentType);
    }

    if (codeBlocks.length === 1 && codeBlocks[0].content.length > page.html_content.length * 0.7) {
      processedContent = codeBlocks[0].content;
      contentType = codeBlocks[0].type;
    }

    if (!VALID_CODE_TYPES.has(contentType)) {
      contentType = 'html';
    }

    const renderedContent = await renderContent(processedContent, contentType);
    const contentWithTypeInfo = injectCodeTypeMeta(renderedContent, contentType);

    return res.send(renderSandboxedDocument(contentWithTypeInfo, contentType));
  } catch (error) {
    console.error('View page failed:', error);
    return res.status(500).render('error', {
      title: '服务器错误',
      page: 'error-page',
      message: '查看页面时发生错误，请稍后再试'
    });
  }
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: '页面未找到',
    page: 'error-page',
    message: '您请求的页面不存在'
  });
});

module.exports = app;
