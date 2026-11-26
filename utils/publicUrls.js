const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SOCIAL_IMAGE_PATH = '/icon/web/icon-512.png';
const SOCIAL_IMAGE_VERSION = createHash('sha256')
  .update(fs.readFileSync(path.join(PUBLIC_DIR, SOCIAL_IMAGE_PATH)))
  .digest('hex')
  .slice(0, 12);

function createPublicUrls(config) {
  function publicPageUrl(req, id) {
    return `${publicOrigin(req)}/view/${encodeURIComponent(id)}`;
  }

  function publicOrigin(req) {
    const base = config.shareBaseUrl || config.baseUrl || `${req.protocol}://${req.get('host')}`;
    return base.replace(/\/+$/, '');
  }

  function socialImageUrl(req) {
    return `${publicOrigin(req)}${SOCIAL_IMAGE_PATH}?v=${SOCIAL_IMAGE_VERSION}`;
  }

  return {
    publicOrigin,
    publicPageUrl,
    socialImageUrl
  };
}

module.exports = {
  createPublicUrls
};
