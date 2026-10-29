import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPdfText, sample } from './helpers.mjs';
import {
  extractTables, parseNumber, parseDate, inferCell, groupRows, clusterColumns,
  analyzeTable, totalsCheck, inferColumnTypes, excelSerial, hasTextLayer,
} from '../src/extract.js';
import { parseCSV } from '../src/csv.js';

test('F1/AC2: scanned (image-only) PDF has no text layer', async () => {
  const { numPages, pages } = await loadPdfText('scanned-demo.pdf');
  assert.equal(numPages, 1);
  assert.equal(hasTextLayer(pages), false);
  const r = extractTables(pages);
  assert.equal(r.hasText, false);
  assert.deepEqual(r.tables, []);
});

test('AC3: price list -> 120 data rows x 5 columns, repeated headers removed', async () => {
  const { numPages, pages } = await loadPdfText('price-list-demo.pdf');
  assert.equal(numPages, 3);
  const { tables } = extractTables(pages);
  assert.equal(tables.length, 1);
  const [t] = tables;
  assert.deepEqual(t.header, ['SKU', 'Product', 'Unit', 'Stock', 'Price']);
  assert.equal(t.rows.length, 120);
  assert.ok(t.rows.every((r) => r.length === 5));
  assert.ok(!t.rows.some((r) => r[0] === 'SKU'), 'no repeated header rows');
  assert.deepEqual(t.pages, [1, 2, 3]);
  assert.equal(t.rows[0][0], 'NW-0001');
  assert.equal(t.rows[119][0], 'NW-0120');
  // SKUs are consecutive: nothing lost or duplicated at page breaks.
  t.rows.forEach((r, i) => assert.equal(r[0], `NW-${String(i + 1).padStart(4, '0')}`));
});

test('AC4: statement wrapped descriptions merged; matches expected CSV cell for cell', async () => {
  const { pages } = await loadPdfText('statement-demo.pdf');
  const { tables } = extractTables(pages);
  assert.equal(tables.length, 1);
  const expected = parseCSV(readFileSync(sample('expected/statement-demo.csv'), 'utf8'));
  assert.deepEqual([tables[0].header, ...tables[0].rows], expected);
});

test('AC5: number parsing', () => {
  assert.equal(parseNumber('1,234.50'), 1234.5);
  assert.equal(parseNumber('(45.00)'), -45);
  assert.equal(parseNumber('-12'), -12);
  assert.equal(parseNumber('$1,200.00'), 1200);
  assert.equal(parseNumber('($45.00)'), -45);
  assert.equal(parseNumber('-$7.25'), -7.25);
  assert.equal(parseNumber('€ 3.10'), 3.1);
  assert.equal(parseNumber('0.5'), 0.5);
  assert.equal(parseNumber('12,34'), null);
  assert.equal(parseNumber('NW-0001'), null);
  assert.equal(parseNumber('12 mm'), null);
  assert.equal(parseNumber(''), null);
});

test('AC5: currency "keep as text" option', () => {
  assert.equal(parseNumber('$1,200.00', { currency: 'text' }), null);
  assert.equal(parseNumber('1,200.00', { currency: 'text' }), 1200);
  assert.deepEqual(inferCell('$5.00', { currency: 'text' }), { type: 'text', value: '$5.00' });
  assert.deepEqual(inferCell('$5.00'), { type: 'number', value: 5 });
});

test('AC5: dates DD/MM/YYYY and YYYY-MM-DD', () => {
  assert.equal(parseDate('12/03/2026').iso, '2026-03-12');
  assert.equal(parseDate('2026-09-30').iso, '2026-09-30');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(inferCell('01/09/2026').type, 'date');
  assert.equal(excelSerial(parseDate('1900-03-01')), 61);
  assert.equal(excelSerial(parseDate('2026-01-01')), 46023);
});

test('AC8: invoice Amount column sums to the printed subtotal', async () => {
  const { pages } = await loadPdfText('invoice-demo.pdf');
  const { tables } = extractTables(pages);
  const inv = tables.find((t) => t.header?.includes('Amount'));
  assert.ok(inv, 'invoice line-item table found');
  assert.equal(inv.rows.length, 12);
  // Read the printed subtotal straight from the PDF text, independent of table detection.
  const rows = groupRows(pages[0].items);
  const subRow = rows.find((r) => r.items.some((i) => i.str.trim() === 'Subtotal'));
  const printed = parseNumber(subRow.items.at(-1).str);
  assert.ok(printed > 0);
  const col = inv.header.indexOf('Amount');
  const check = totalsCheck(inv.rows, col, printed);
  assert.equal(check.match, true, `sum ${check.sum} vs printed ${printed}`);
  assert.equal(check.diff, 0);
});

test('F2: column clustering keeps right-aligned columns together', () => {
  const segs = [
    { x0: 40, x1: 60 }, { x0: 40, x1: 90 }, // left-aligned
    { x0: 200, x1: 230 }, { x0: 180, x1: 230 }, { x0: 215, x1: 230 }, // right-aligned
  ];
  const cols = clusterColumns(segs, 8);
  assert.equal(cols.length, 2);
  assert.deepEqual(cols[1], { x0: 180, x1: 230 });
});

test('F2: header detection can be switched off', async () => {
  const { pages } = await loadPdfText('statement-demo.pdf');
  const { tables } = extractTables(pages, { headerMode: 'none' });
  assert.equal(tables[0].header, null);
  assert.deepEqual(tables[0].rows[0], ['Date', 'Description', 'Debit', 'Credit', 'Balance']);
});

test('F3/AC6: merging two columns by moving a boundary yields 4 columns', async () => {
  const { pages } = await loadPdfText('price-list-demo.pdf');
  const auto = extractTables(pages).tables[0];
  assert.equal(auto.boundaries.length, 4);
  const b = [...auto.boundaries];
  b[2] = b[1]; // drag the Unit|Stock boundary onto the Product|Unit boundary
  const t = extractTables(pages, { boundaries: b }).tables[0];
  assert.equal(t.header.length, 4);
  assert.ok(t.rows.every((r) => r.length === 4));
  assert.equal(t.rows.length, 120);
  const removed = extractTables(pages, { boundaries: auto.boundaries.filter((_, i) => i !== 0) }).tables[0];
  assert.equal(removed.header[0], 'SKU Product');
});

test('F3: re-extraction of 120 rows takes < 300 ms', async () => {
  const { pages } = await loadPdfText('price-list-demo.pdf');
  const b = extractTables(pages).tables[0].boundaries;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) extractTables(pages, { boundaries: b.slice(1) });
  const per = (performance.now() - t0) / 10;
  assert.ok(per < 300, `took ${per.toFixed(1)} ms`);
});

test('F3: page range and region limit extraction', async () => {
  const { pages } = await loadPdfText('price-list-demo.pdf');
  const p2 = extractTables(pages, { pages: { from: 2, to: 2 } }).tables;
  assert.equal(p2.length, 1);
  assert.equal(p2[0].rows.length, 40);
  assert.equal(p2[0].rows[0][0], 'NW-0041');
  // Region covering the header plus the first ten rows of each page.
  const r = extractTables(pages, { pages: { from: 1, to: 1 }, region: { x0: 0, y0: 80, x1: 595, y1: 113 + 15 * 9 + 2 } }).tables;
  assert.equal(r[0].rows.length, 10);
});

test('F4: data checks: types, empty counts and unparseable numeric cells', () => {
  const table = {
    header: ['Date', 'Item', 'Amount'],
    rows: [['01/09/2026', 'a', '1.00'], ['02/09/2026', '', '2.50'], ['03/09/2026', 'c', 'n/a'],
      ['04/09/2026', 'd', '4'], ['05/09/2026', 'e', '(1.00)'], ['06/09/2026', 'f', '7']],
  };
  const a = analyzeTable(table);
  assert.equal(a.rowCount, 6);
  assert.deepEqual(a.columns.map((c) => c.type), ['date', 'text', 'number']);
  assert.deepEqual(a.columns.map((c) => c.empty), [0, 1, 0]);
  assert.deepEqual(a.badCells, [{ row: 2, col: 2, value: 'n/a' }]);
  const tc = totalsCheck(table.rows, 2, '10.00');
  assert.equal(tc.sum, 13.5);
  assert.equal(tc.match, false);
  assert.equal(tc.diff, 3.5);
  assert.deepEqual(inferColumnTypes([['x', '']]), ['text', 'text']);
});
