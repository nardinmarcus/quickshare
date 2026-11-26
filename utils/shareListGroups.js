const { managementDateKey, managementDateRange } = require('./management-time');

const DAY_MS = 24 * 60 * 60 * 1000;
const TYPE_ABBREVIATIONS = { html: 'HTML', markdown: 'MD', svg: 'SVG', mermaid: 'MMD' };

function shareTypeAbbreviation(codeType) {
  return TYPE_ABBREVIATIONS[codeType] || 'HTML';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// 列表里的短时间：今天只显示时刻，今年显示月日加时刻，更早补上年份。均为北京时间。
function formatShareListTime(timestamp, now = Date.now()) {
  const key = managementDateKey(timestamp);
  const local = new Date(Number(timestamp) + 8 * 60 * 60 * 1000);
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const todayKey = managementDateKey(now);

  if (key === todayKey) return time;
  if (key.slice(0, 4) === todayKey.slice(0, 4)) return `${key.slice(5, 7)}/${key.slice(8, 10)} ${time}`;
  return `${key.slice(0, 4)}/${key.slice(5, 7)}/${key.slice(8, 10)}`;
}

function dateGroupLabel(timestamp, now) {
  const todayStart = managementDateRange(managementDateKey(now)).start;
  const value = Number(timestamp);

  if (value >= todayStart) return '今天';
  if (value >= todayStart - DAY_MS) return '昨天';
  if (value >= todayStart - 6 * DAY_MS) return '最近 7 天';
  return '更早';
}

function groupLabel(sharedPage, sort, now) {
  if (sort === 'code_type') return sharedPage.code_type || 'html';
  if (sort === 'is_protected') return sharedPage.is_protected === 1 ? '密码保护' : '公开';
  return dateGroupLabel(sharedPage.created_at, now);
}

// 把已排好序的一页分享切成相邻的分组；不重排，所以分组顺序跟随当前排序。
function groupSharesForList(pages, sort = 'created_at', now = Date.now()) {
  const groups = [];

  pages.forEach((sharedPage) => {
    const label = groupLabel(sharedPage, sort, now);
    const last = groups[groups.length - 1];

    if (last && last.label === label) last.pages.push(sharedPage);
    else groups.push({ label, pages: [sharedPage] });
  });

  return groups;
}

module.exports = {
  formatShareListTime,
  groupSharesForList,
  shareTypeAbbreviation
};
