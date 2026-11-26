const config = require('../config');
const express = require('express');

function createLoginRouter({ config, pageRepository, auth, parsers }) {
  const router = express.Router();
  const {
    clearAdminCookie,
    clearDashboardAdminCookie,
    getAdminSession,
    getDashboardAdminSession,
    setAdminCookie,
    setDashboardAdminCookie,
    verifyAdminPassword,
    verifyDashboardAdminPassword
  } = auth;
  const {
    parseSmallForm
  } = parsers;

  router.get('/login', (req, res) => {
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

  router.post('/login', parseSmallForm, async (req, res) => {
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

  router.get('/logout', (req, res) => {
    clearAdminCookie(res);
    return res.redirect('/login');
  });

  router.get('/admin/login', (req, res) => {
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

  router.post('/admin/login', parseSmallForm, async (req, res) => {
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

  router.get('/admin/logout', (req, res) => {
    clearDashboardAdminCookie(res);
    return res.redirect('/admin/login');
  });

  router.get('/admin', (req, res) => {
    if (!config.authEnabled || getDashboardAdminSession(req)) {
      return res.redirect('/admin/stats');
    }

    return res.redirect('/admin/login');
  });

  return router;
}

module.exports = {
  createLoginRouter
};
