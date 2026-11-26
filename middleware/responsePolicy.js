const { isPublishingGateError } = require('../utils/publishing');

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

function respondOperationUnavailable(res, requestId) {
  return res.status(410).json({
    success: false,
    error: '该请求已提交，但其结果已不可用',
    code: 'operation_result_unavailable',
    requestId,
    retryable: false
  });
}

module.exports = {
  EMBEDDABLE_UI_CSP,
  TRUSTED_UI_CSP,
  isTrustedUiPath,
  privateNoStore,
  respondIfPublishingGate,
  respondOperationUnavailable,
  sendPublishingMaintenance,
  setPrivateNoStore,
  setTrustedUiCsp
};
