const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

try {
  require('dotenv').config();
} catch (error) {
  // dotenv is optional in managed deployment environments.
}

const defaultPort = isProduction ? 3000 : 5678;
const VALID_THEMES = ['default', 'hacker', 'cyberpunk'];
const uiTheme = VALID_THEMES.includes(process.env.UI_THEME) ? process.env.UI_THEME : 'default';
const authEnabled = process.env.AUTH_ENABLED !== 'false';
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
const authPassword = process.env.AUTH_PASSWORD || (isProduction ? '' : 'admin123');
const adminDashboardPasswordHash = process.env.ADMIN_DASHBOARD_PASSWORD_HASH || '';
const adminDashboardPassword = process.env.ADMIN_DASHBOARD_PASSWORD || (isProduction ? '' : 'dashboard123');

if (isProduction && authEnabled && !adminPasswordHash && !authPassword) {
  throw new Error('ADMIN_PASSWORD_HASH or AUTH_PASSWORD is required when auth is enabled in production');
}

if (isProduction && authEnabled && !adminDashboardPasswordHash && !adminDashboardPassword) {
  throw new Error('ADMIN_DASHBOARD_PASSWORD_HASH or ADMIN_DASHBOARD_PASSWORD is required when auth is enabled in production');
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
  uiTheme
};
