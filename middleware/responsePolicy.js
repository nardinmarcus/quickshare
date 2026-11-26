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

function setPrivateNoStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

function privateNoStore(req, res, next) {
  setPrivateNoStore(res);
  return next();
}

function isTrustedUiPath(pathname) {
  return /^\/login\/?$/i.test(pathname) || /^\/admin(?:\/|$)/i.test(pathname);
}

function setTrustedUiCsp(res, { allowFraming = false } = {}) {
  res.set('Content-Security-Policy', allowFraming ? EMBEDDABLE_UI_CSP : TRUSTED_UI_CSP);
}

module.exports = {
  EMBEDDABLE_UI_CSP,
  TRUSTED_UI_CSP,
  isTrustedUiPath,
  privateNoStore,
  setPrivateNoStore,
  setTrustedUiCsp
};
