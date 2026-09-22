const test = require('node:test');
const assert = require('node:assert/strict');
const { derivePageTitle } = require('../utils/pageTitle');

function isWellFormedUnicode(value) {
  // A string is well formed when it round-trips through UTF-8 unchanged;
  // lone surrogates cannot be encoded as UTF-8 and become replacement
  // characters, which would silently change the stored title.
  return Buffer.from(value, 'utf8').toString('utf8') === value
    && ![...value].some(char => char >= '\uD800' && char <= '\uDFFF' && !/\uD800[\uDC00-\uDFFF]|[\uDC00-\uDFFF]/.test(char));
}

test('explicit title within the 160 code-unit limit is kept verbatim', () => {
  const title = 'a'.repeat(160);
  assert.equal(derivePageTitle('<p>x</p>', 'html', title, 0), title);
});

test('explicit title beyond 160 code units is still capped at 160 code units', () => {
  const title = 'a'.repeat(200);
  assert.equal(derivePageTitle('<p>x</p>', 'html', title, 0).length, 160);
});

test('capping never splits a surrogate pair into a lone high surrogate', () => {
  // Regression probe (preflight32-title-utf8-probe.json): 159 ASCII 'a' plus
  // one astral emoji is 161 code units; the old slice(0, 160) kept the lone
  // high surrogate D83D and produced a title that does not survive UTF-8
  // transport into PostgreSQL.
  const title = 'a'.repeat(159) + '\u{1F600}';
  const derived = derivePageTitle('<p>x</p>', 'html', title, 0);

  assert.ok(derived.length <= 160, 'the 160 code-unit cap is preserved');
  assert.equal(
    Buffer.from(derived, 'utf8').toString('utf8'),
    derived,
    'the capped title must round-trip UTF-8 unchanged'
  );
  assert.ok(!/[\uD800-\uDBFF]$/.test(derived), 'no lone high surrogate may remain at the end');
  assert.ok(derived.startsWith('a'.repeat(159)), 'leading ASCII content is preserved');
});

test('an astral emoji entirely inside the limit is preserved intact', () => {
  const title = 'a'.repeat(158) + '\u{1F600}';
  const derived = derivePageTitle('<p>x</p>', 'html', title, 0);

  assert.equal(derived, title);
  assert.equal(derived.length, 160);
  assert.equal(Buffer.from(derived, 'utf8').toString('utf8'), derived);
});

test('a title made only of astral characters is capped without corruption', () => {
  const title = '\u{1F600}'.repeat(120); // 240 code units, all astral
  const derived = derivePageTitle('<p>x</p>', 'html', title, 0);

  assert.ok(derived.length <= 160);
  assert.ok(derived.length % 2 === 0, 'pairs must remain complete');
  assert.equal(Buffer.from(derived, 'utf8').toString('utf8'), derived);
  assert.equal(derived, '\u{1F600}'.repeat(derived.length / 2));
});

test('content-derived titles never end in a lone surrogate either', () => {
  const content = `<title>${'a'.repeat(159)}\u{1F600}</title>`;
  const derived = derivePageTitle(content, 'html', '', 0);

  assert.ok(derived.length <= 160);
  assert.equal(Buffer.from(derived, 'utf8').toString('utf8'), derived);
});

test('derived titles are well formed for every supported content type', () => {
  const samples = [
    ['html', `<title>${'t'.repeat(155)}\u{1F680}\u{1F680}</title>`],
    ['markdown', `# ${'m'.repeat(158)}\u{1F600}\n\nbody`],
    ['mermaid', `graph TD;\u{1F600}${'x'.repeat(160)}`]
  ];

  for (const [codeType, content] of samples) {
    const derived = derivePageTitle(content, codeType, '', 0);
    assert.ok(derived.length <= 160, `${codeType} title respects the cap`);
    assert.equal(
      Buffer.from(derived, 'utf8').toString('utf8'),
      derived,
      `${codeType} title must survive UTF-8 transport`
    );
  }
});
