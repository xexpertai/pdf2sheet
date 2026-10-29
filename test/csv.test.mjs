import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, parseCSV, toTSV } from '../src/csv.js';

const tricky = [
  ['plain', 'with,comma', 'with "quotes"'],
  ['multi\nline', 'crlf\r\nline', ''],
  [' padded ', '""', 'semi;colon'],
  ['tab\there', 'unicode ₹ é 日本', '=1+1'],
];

test('AC10: CSV round trip keeps commas, quotes and newlines', () => {
  for (const delimiter of [',', ';', '\t']) {
    const text = toCSV(tricky, { delimiter });
    assert.deepEqual(parseCSV(text, { delimiter }), tricky, `delimiter ${JSON.stringify(delimiter)}`);
  }
});

test('F5: RFC 4180 quoting and CRLF records', () => {
  assert.equal(toCSV([['a', 'b,c', 'd"e']]), 'a,"b,c","d""e"\r\n');
  assert.equal(toCSV([['a;b', 'c,d']], { delimiter: ';' }), '"a;b";c,d\r\n');
});

test('F5: optional UTF-8 BOM is written and ignored on parse', () => {
  const text = toCSV([['x', 'y']], { bom: true });
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(parseCSV(text), [['x', 'y']]);
  assert.equal(new TextEncoder().encode(text).slice(0, 3).join(), '239,187,191');
});

test('F5: TSV for clipboard', () => {
  assert.equal(toTSV([['a', 'b'], ['1', 'x\ty']]), 'a\tb\n1\t"x\ty"\n');
});

test('parser rejects an unterminated quote', () => {
  assert.throws(() => parseCSV('"abc'), /Unterminated/);
});
