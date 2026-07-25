/**
 * 网站图标版本号
 * 取四个站点图标文件内容哈希前 12 位，作为 ?v= 查询参数追加到所有图标链接，
 * 强制浏览器在图标更新后重新拉取（浏览器 favicon 缓存无视 HTTP 缓存头）。
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ICON_FILES = [
  'favicon.ico',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png'
];

const iconHash = createHash('sha256');
for (const file of ICON_FILES) {
  iconHash.update(fs.readFileSync(path.join(__dirname, '..', 'public', 'icon', 'web', file)));
}

const FAVICON_VERSION = iconHash.digest('hex').slice(0, 12);

module.exports = { FAVICON_VERSION };
