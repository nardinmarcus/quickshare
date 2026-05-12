const { verifyScopedToken } = require('../utils/security');

const ADMIN_COOKIE = 'admin_session';

function isAuthenticated(req, res, next) {
  const config = req.app.locals.config;

  if (!config || !config.authEnabled) {
    return next();
  }

  const payload = verifyScopedToken(req.cookies?.[ADMIN_COOKIE], 'admin');

  if (!payload) {
    return res.redirect('/login');
  }

  return next();
}

module.exports = {
  isAuthenticated
};
