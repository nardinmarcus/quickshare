const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatShareListTime,
  groupSharesForList,
  shareTypeAbbreviation
} = require('../utils/shareListGroups');

// 北京时间 2026-11-27 10:00
const NOW = Date.parse('2026-11-27T02:00:00.000Z');
const at = (iso) => Date.parse(iso);

test('shares sorted by creation time are grouped by Beijing calendar distance', () => {
  const pages = [
    { id: 'today', created_at: at('2026-11-26T16:30:00.000Z') },
    { id: 'yesterday', created_at: at('2026-11-26T15:59:00.000Z') },
    { id: 'week', created_at: at('2026-11-21T04:00:00.000Z') },
    { id: 'older-a', created_at: at('2026-11-20T04:00:00.000Z') },
    { id: 'older-b', created_at: at('2025-01-01T04:00:00.000Z') }
  ];

  const groups = groupSharesForList(pages, 'created_at', NOW);

  assert.deepEqual(
    groups.map((group) => [group.label, group.pages.map((page) => page.id)]),
    [
      ['今天', ['today']],
      ['昨天', ['yesterday']],
      ['最近 7 天', ['week']],
      ['更早', ['older-a', 'older-b']]
    ]
  );
});

test('other sort orders group by the sorted field without reordering rows', () => {
  const pages = [
    { id: 'a', code_type: 'html', is_protected: 1 },
    { id: 'b', code_type: 'html', is_protected: 0 },
    { id: 'c', code_type: 'svg', is_protected: 0 }
  ];

  assert.deepEqual(
    groupSharesForList(pages, 'code_type', NOW).map((group) => [group.label, group.pages.length]),
    [['html', 2], ['svg', 1]]
  );
  assert.deepEqual(
    groupSharesForList(pages, 'is_protected', NOW).map((group) => [group.label, group.pages.length]),
    [['密码保护', 1], ['公开', 2]]
  );
});

test('list times shorten with distance and stay in Beijing time', () => {
  assert.equal(formatShareListTime(at('2026-11-26T17:11:00.000Z'), NOW), '01:11');
  assert.equal(formatShareListTime(at('2026-11-20T02:30:00.000Z'), NOW), '11/20 10:30');
  assert.equal(formatShareListTime(at('2025-12-31T16:30:00.000Z'), NOW), '01/01 00:30');
  assert.equal(formatShareListTime(at('2025-03-05T02:30:00.000Z'), NOW), '2025/03/05');
});

test('content types map to the fixed list abbreviations', () => {
  assert.equal(shareTypeAbbreviation('markdown'), 'MD');
  assert.equal(shareTypeAbbreviation('mermaid'), 'MMD');
  assert.equal(shareTypeAbbreviation('svg'), 'SVG');
  assert.equal(shareTypeAbbreviation(undefined), 'HTML');
});
