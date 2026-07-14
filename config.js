try {
  require('dotenv').config();
} catch (error) {
  // dotenv is optional in managed deployment environments.
}

const {
  isProductionRuntime,
  isValidAppSecret,
  isValidScryptHash
} = require('./utils/security');

const isProduction = isProductionRuntime();
const env = isProduction ? 'production' : process.env.NODE_ENV || 'development';
const defaultPort = isProduction ? 3000 : 5678;
const VALID_THEMES = ['default', 'hacker', 'cyberpunk', 'popart'];
const uiTheme = VALID_THEMES.includes(process.env.UI_THEME) ? process.env.UI_THEME : 'default';
const authEnabled = process.env.AUTH_ENABLED !== 'false';
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
const configuredAuthPassword = process.env.AUTH_PASSWORD || '';
const authPassword = isProduction ? '' : configuredAuthPassword || 'admin123';
const adminDashboardPasswordHash = process.env.ADMIN_DASHBOARD_PASSWORD_HASH || '';
const configuredDashboardPassword = process.env.ADMIN_DASHBOARD_PASSWORD || '';
const adminDashboardPassword = isProduction ? '' : configuredDashboardPassword || 'dashboard123';

if (isProduction) {
  if (configuredAuthPassword) {
    throw new Error('AUTH_PASSWORD is not allowed in production; use ADMIN_PASSWORD_HASH');
  }

  if (configuredDashboardPassword) {
    throw new Error('ADMIN_DASHBOARD_PASSWORD is not allowed in production; use ADMIN_DASHBOARD_PASSWORD_HASH');
  }

  if (adminPasswordHash && !isValidScryptHash(adminPasswordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a scrypt hash in production');
  }

  if (adminDashboardPasswordHash && !isValidScryptHash(adminDashboardPasswordHash)) {
    throw new Error('ADMIN_DASHBOARD_PASSWORD_HASH must be a scrypt hash in production');
  }

  if (authEnabled && !adminPasswordHash) {
    throw new Error('ADMIN_PASSWORD_HASH is required when auth is enabled in production');
  }

  if (authEnabled && !adminDashboardPasswordHash) {
    throw new Error('ADMIN_DASHBOARD_PASSWORD_HASH is required when auth is enabled in production');
  }

  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }

  if (!isValidAppSecret(process.env.SESSION_SECRET)) {
    throw new Error('SESSION_SECRET must be at least 32 bytes and not a placeholder in production');
  }
}

module.exports = {
  env,
  port: Number.parseInt(process.env.PORT || String(defaultPort), 10),
  logLevel: process.env.LOG_LEVEL || (isProduction ? 'combined' : 'dev'),
  authEnabled,
  adminPasswordHash,
  authPassword,
  adminDashboardPasswordHash,
  adminDashboardPassword,
  secureCookies: process.env.SECURE_COOKIES
    ? process.env.SECURE_COOKIES === 'true'
    : isProduction,
  baseUrl: process.env.BASE_URL || '',
  shareBaseUrl: process.env.SHARE_BASE_URL || process.env.BASE_URL || '',
  shareApiKey: process.env.SHARE_API_KEY || '',
  smallBodyLimit: process.env.SMALL_BODY_LIMIT || '16kb',
  shareBodyLimit: process.env.SHARE_BODY_LIMIT || '2mb',
  uiTheme
};
