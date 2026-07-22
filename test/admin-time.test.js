const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'UTC';

function loadAdminTime() {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/admin-time.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, Date });
  return window.AdminTime;
}

test('admin browser time helpers stay on Beijing time under a UTC browser', () => {
  const adminTime = loadAdminTime();
  const timestamp = Date.parse('2026-07-22T10:53:32.123Z');

  assert.equal(adminTime.format(timestamp), '2026/7/22 18:53:32');
  assert.equal(adminTime.toDateTimeLocal(timestamp), '2026-07-22T18:53:32.123');
  assert.equal(adminTime.parseDateTimeLocal('2026-07-22T18:53:32.123'), timestamp);
});
