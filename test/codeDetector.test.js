const test = require('node:test');
const assert = require('node:assert/strict');

const { detectCodeType, extractCodeBlocks } = require('../utils/codeDetector');

test('detectCodeType detects common content types', () => {
  assert.equal(detectCodeType('<!DOCTYPE html><html><body>Hello</body></html>'), 'html');
  assert.equal(detectCodeType('# Title\n\n- item'), 'markdown');
  assert.equal(detectCodeType('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'svg');
  assert.equal(detectCodeType('graph TD\nA-->B'), 'mermaid');
});

test('extractCodeBlocks extracts fenced mermaid blocks', () => {
  const fence = '`'.repeat(3);
  const blocks = extractCodeBlocks(`${fence}mermaid\ngraph TD\nA-->B\n${fence}`);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'mermaid');
});
