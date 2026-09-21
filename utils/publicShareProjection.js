// Public reads share one access decision. Denied projections never retain a Share row.
function publicShareProjection(publicShare, accessRevision) {
  if (!publicShare) {
    return { state: 'missing', status: 404, title: '页面未找到', message: '您请求的页面不存在或已被删除', error: '页面不存在' };
  }
  if (publicShare.expired) {
    return { state: 'expired', status: 410, title: '分享已失效', message: '此分享已失效，无法继续访问', error: '此分享已失效' };
  }
  const { page } = publicShare;
  if (page.is_protected === 1 && accessRevision !== page.access_revision) {
    return { state: 'locked', status: 403, title: 'QuickShare | 受保护内容', message: '输入访问密码后即可查看分享内容', error: '此内容受密码保护' };
  }
  return { state: 'readable', status: 200, page };
}

module.exports = { publicShareProjection };
