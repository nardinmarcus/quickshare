const { timingSafeEqual } = require('node:crypto');

const {
  legacyCredentialIdentity,
  managedCredentialIdentity,
  parseManagedApiKeyCredential
} = require('../utils/apiKeyIdentity');
const {
  browserOwnerNamespace,
  namespaceTag,
  publishSessionNamespace
} = require('../utils/idempotency');
const {
  createScopedToken,
  generateId,
  verifyCsrfToken,
  verifyScopedToken,
  verifySecret
} = require('../utils/security');
const { accessRevisionMatches, toAccessRevisionString } = require('../utils/shareAccess');

const ADMIN_COOKIE = 'admin_session';
const DASHBOARD_ADMIN_COOKIE = 'dashboard_admin_session';
const ADMIN_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLISH_SESSION_COOKIE = 'publish_session';
const PUBLISH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function createAuth({ config, pageRepository }) {
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

  // Scope guard for the v1 resource API (T12, parent spec #24 §6). Runs
  // after requireApiKey, so a missing/invalid credential has already been
  // answered 401; a verified credential that lacks the operation's scope
  // gets a stable 403. Authorization for a specific Share is the
  // conjunction of scope and grant — this guard checks only the scope
  // half; the grant half is judged by the repository read, whose "no
  // grant" outcome is the same 404 as "no such Share", so this surface
  // cannot be used to probe which Shares exist. The legacy credential's
  // scope list is create-only by construction, so it is refused here for
  // every management operation without a special case.
  function requireApiScope(...scopes) {
    return (req, res, next) => {
      const credential = req.apiCredential || legacyCredentialIdentity();
      const held = credential.scopes || [];

      if (scopes.some(scope => held.includes(scope))) {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: 'Insufficient scope for this operation',
        code: 'insufficient_scope',
        retryable: false
      });
    };
  }

  // Conjunctive scope guard (T13, parent spec #24 §6): the content
  // update operation requires the update scope AND the read scope —
  // update implies read at the grant level, and the spec binds the same
  // implication to scopes, so a credential holding only one of the pair
  // is refused 403 here instead of being half-authorized deeper in.
  function requireApiScopesAll(...scopes) {
    return (req, res, next) => {
      const credential = req.apiCredential || legacyCredentialIdentity();
      const held = credential.scopes || [];

      if (scopes.every(scope => held.includes(scope))) {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: 'Insufficient scope for this operation',
        code: 'insufficient_scope',
        retryable: false
      });
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

  function adminSessionToken(req) {
    return req.adminSession?.token || req.cookies?.[ADMIN_COOKIE] || '';
  }

  function dashboardSessionToken(req) {
    return req.dashboardAdminSession?.token || req.cookies?.[DASHBOARD_ADMIN_COOKIE] || '';
  }

  return {
    getAdminSession,
    getDashboardAdminSession,
    browserCreateContext,
    requireHomepageAccess,
    requireBrowserPublishAccess,
    requireBrowserPublishCsrf,
    requireApiAdmin,
    requireDashboardAdmin,
    requireDashboardApiAdmin,
    requireCsrf,
    requireDashboardCsrf,
    requireApiKey,
    requireApiScope,
    requireApiScopesAll,
    verifyAdminPassword,
    verifyDashboardAdminPassword,
    setAdminCookie,
    setDashboardAdminCookie,
    clearAdminCookie,
    clearDashboardAdminCookie,
    setPageAccessCookie,
    getPageAccess,
    hasPageAccess,
    isSameOriginRequest,
    adminSessionToken,
    dashboardSessionToken
  };
}

module.exports = {
  PUBLISH_SESSION_TTL_MS,
  createAuth
};
