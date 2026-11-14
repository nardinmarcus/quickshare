// Neutral public projection for locked Shares (ticket T02, issue #26).
//
// A protected Share that the requester has not unlocked must never expose
// its real title, description, or content-derived metadata through public
// surfaces (metadata API, password page, Open Graph tags, error bodies).
// Every public surface applies the same projection: until the requester
// presents a valid access credential (T01: a signed cookie bound to the
// Share's current access_revision), the Share is described only by the
// neutral title/description below and the site-wide generic image.
//
// Public (unprotected) Shares and validly unlocked requests keep the real
// title and description. The projection is a read-time decision only; it
// never changes stored content and never grants management rights.

const NEUTRAL_PAGE_TITLE = '受保护内容';
const NEUTRAL_PAGE_DESCRIPTION = '此内容受密码保护，输入访问密码后即可查看';

function isLockedForRequester(page, hasValidAccess) {
  return page.is_protected === 1 && !hasValidAccess;
}

function projectPublicMetadata(page, hasValidAccess) {
  if (isLockedForRequester(page, hasValidAccess)) {
    return {
      title: NEUTRAL_PAGE_TITLE,
      description: NEUTRAL_PAGE_DESCRIPTION
    };
  }

  return {
    title: page.title,
    description: page.description
  };
}

module.exports = {
  NEUTRAL_PAGE_TITLE,
  NEUTRAL_PAGE_DESCRIPTION,
  isLockedForRequester,
  projectPublicMetadata
};
