const MANAGEMENT_TIME_ZONE = 'Asia/Shanghai';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/;

function formatManagementDateTime(timestamp) {
  return new Date(Number(timestamp)).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: MANAGEMENT_TIME_ZONE
  });
}

function managementDateKey(timestamp) {
  return new Date(Number(timestamp) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function managementDateRange(value) {
  if (!DATE_PATTERN.test(value)) return null;

  const start = Date.parse(`${value}T00:00:00.000+08:00`);
  if (!Number.isFinite(start) || managementDateKey(start) !== value) return null;

  return {
    start,
    end: start + (24 * 60 * 60 * 1000) - 1
  };
}

function toManagementDateTimeLocal(timestamp) {
  return new Date(Number(timestamp) + BEIJING_OFFSET_MS).toISOString().slice(0, 23);
}

function parseManagementDateTimeLocal(value) {
  if (!DATE_TIME_LOCAL_PATTERN.test(value)) return NaN;

  const timestamp = Date.parse(`${value}+08:00`);
  return toManagementDateTimeLocal(timestamp).slice(0, value.length) === value ? timestamp : NaN;
}

function buildManagementDailyStats(timestamps, days = 14, now = Date.now()) {
  const firstDayStart = managementRecentStart(days, now);
  const counts = new Map();

  for (let index = 0; index < days; index += 1) {
    counts.set(managementDateKey(firstDayStart + (index * DAY_MS)), 0);
  }

  timestamps.forEach((timestamp) => {
    const date = managementDateKey(timestamp);
    if (counts.has(date)) counts.set(date, counts.get(date) + 1);
  });

  return Array.from(counts, ([date, count]) => ({
    date,
    label: `${date.slice(5, 7)}/${date.slice(8, 10)}`,
    count
  }));
}

function managementRecentStart(days = 14, now = Date.now()) {
  const todayStart = managementDateRange(managementDateKey(now)).start;
  return todayStart - ((days - 1) * DAY_MS);
}

module.exports = {
  MANAGEMENT_TIME_ZONE,
  buildManagementDailyStats,
  formatManagementDateTime,
  managementDateRange,
  managementRecentStart,
  parseManagementDateTimeLocal,
  toManagementDateTimeLocal
};
