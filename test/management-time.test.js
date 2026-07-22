const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'UTC';

const {
  buildManagementDailyStats,
  formatManagementDateTime,
  managementDateRange,
  parseManagementDateTimeLocal,
  toManagementDateTimeLocal
} = require('../utils/management-time');

test('Management Time Zone renders absolute instants in Beijing time under a UTC process', () => {
  const timestamp = Date.parse('2026-07-22T10:53:32.000Z');

  assert.equal(formatManagementDateTime(timestamp), '2026/7/22 18:53:32');
});

test('Management Time Zone resolves a Beijing calendar date to absolute boundaries', () => {
  assert.deepEqual(managementDateRange('2026-07-22'), {
    start: Date.parse('2026-07-21T16:00:00.000Z'),
    end: Date.parse('2026-07-22T15:59:59.999Z')
  });
});

test('Management Time Zone round-trips an expiration through datetime-local', () => {
  const timestamp = Date.parse('2026-07-22T10:53:32.123Z');
  const localValue = toManagementDateTimeLocal(timestamp);

  assert.equal(localValue, '2026-07-22T18:53:32.123');
  assert.equal(parseManagementDateTimeLocal(localValue), timestamp);
});

test('Management Time Zone assigns activity to Beijing calendar days', () => {
  const now = Date.parse('2026-07-22T16:30:00.000Z');
  const timestamps = [
    Date.parse('2026-07-21T15:59:59.999Z'),
    Date.parse('2026-07-21T16:00:00.000Z'),
    Date.parse('2026-07-22T15:59:59.999Z'),
    Date.parse('2026-07-22T16:00:00.000Z')
  ];

  assert.deepEqual(buildManagementDailyStats(timestamps, 2, now), [
    { date: '2026-07-22', label: '07/22', count: 2 },
    { date: '2026-07-23', label: '07/23', count: 1 }
  ]);
});
