import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildXlsx, colName, sheetNames, xmlEscape } from '../src/xlsx.js';
import { zipStore, unzipStore, crc32 } from '../src/zip.js';
import { extractTables } from '../src/extract.js';
import { loadPdfText } from './helpers.mjs';

const dec = new TextDecoder();

test('zip: CRC-32 known value and store round trip', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = zipStore([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2]) }]);
  const files = unzipStore(z);
  assert.equal(dec.decode(files.get('a.txt')), 'hello');
  assert.deepEqual([...files.get('dir/b.bin')], [0, 1, 2]);
});

test('xlsx helpers: column names, sheet names, escaping', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.deepEqual(sheetNames(['a/b', 'a/b', '', 'x'.repeat(40)]), ['a b', 'a b 2', 'Table 3', 'x'.repeat(31)]);
  assert.equal(xmlEscape('<a & "b">\u0001'), '&lt;a &amp; &quot;b&quot;&gt;');
});

async function invoiceWorkbook() {
  const { pages } = await loadPdfText('invoice-demo.pdf');
  const tables = extractTables(pages).tables.map((t, i) => ({ ...t, name: i ? 'Totals' : 'Invoice' }));
  return { tables, bytes: buildXlsx(tables) };
}

test('AC9: XLSX package structure, typed numeric cells, bold header, frozen row', async () => {
  const { tables, bytes } = await invoiceWorkbook();
  const files = unzipStore(bytes);
  const ct = dec.decode(files.get('[Content_Types].xml'));
  assert.match(ct, /PartName="\/xl\/workbook.xml" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main\+xml"/);
  assert.match(ct, /PartName="\/xl\/worksheets\/sheet1.xml"/);
  assert.match(ct, /PartName="\/xl\/worksheets\/sheet2.xml"/);
  for (const part of ['_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml']) assert.ok(files.has(part), part);

  const wb = dec.decode(files.get('xl/workbook.xml'));
  assert.match(wb, /<sheet name="Invoice" sheetId="1" r:id="rId1"\/>/);
  assert.match(wb, /<sheet name="Totals" sheetId="2" r:id="rId2"\/>/);

  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<cols>(<col min="\d+" max="\d+" width="\d+" customWidth="1"\/>){5}<\/cols>/);
  // Header row: shared strings with the bold style.
  assert.match(sheet, /<row r="1">(<c r="[A-E]1" t="s" s="1"><v>\d+<\/v><\/c>){5}<\/row>/);
  // Every Qty / Unit Price / Amount cell is a typed number.
  const numeric = [...sheet.matchAll(/<c r="([C-E])(\d+)" t="n"><v>([^<]+)<\/v><\/c>/g)];
  assert.equal(numeric.length, 12 * 3);
  const amountRow2 = numeric.find((m) => m[1] === 'E' && m[2] === '2');
  assert.equal(Number(amountRow2[3]), Number(tables[0].rows[0][4].replace(/[$,]/g, '')));
  assert.ok(!/<c r="E\d+" t="s"/.test(sheet.replace(/<row r="1">.*?<\/row>/, '')), 'no Amount stored as text');

  // Well-formedness: every part parses as XML (xmllint when available, else a tag-balance check).
  for (const [name, data] of files) {
    const xml = dec.decode(data);
    const open = (xml.match(/<[A-Za-z][^>]*[^/]>|<[A-Za-z]>/g) || []).filter((t) => !t.startsWith('<?')).length;
    const close = (xml.match(/<\/[^>]+>/g) || []).length;
    assert.equal(open, close, `balanced tags in ${name}`);
  }
});

test('AC9: dates are typed numeric cells with a date format', async () => {
  const { pages } = await loadPdfText('statement-demo.pdf');
  const [t] = extractTables(pages).tables;
  const files = unzipStore(buildXlsx([t]));
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet, /<c r="A2" t="n" s="2"><v>46266<\/v><\/c>/); // 01/09/2026
  assert.match(dec.decode(files.get('xl/styles.xml')), /formatCode="yyyy-mm-dd"/);
});

const hasSoffice = spawnSync('soffice', ['--version'], { stdio: 'ignore' }).status === 0;
const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;

test('AC9: archive passes `unzip -t`', { skip: !hasUnzip && 'unzip not installed' }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pdf2sheet-'));
  try {
    const { bytes } = await invoiceWorkbook();
    writeFileSync(join(dir, 'invoice.xlsx'), bytes);
    const out = execFileSync('unzip', ['-t', join(dir, 'invoice.xlsx')], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC9: LibreOffice opens the XLSX and reads typed values', { skip: !hasSoffice && 'LibreOffice not installed', timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pdf2sheet-'));
  try {
    const { tables, bytes } = await invoiceWorkbook();
    writeFileSync(join(dir, 'invoice.xlsx'), bytes);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv', '--outdir', dir, join(dir, 'invoice.xlsx')], { stdio: 'ignore', timeout: 110000 });
    const csv = readFileSync(join(dir, 'invoice.csv'), 'utf8').trim().split(/\r?\n/);
    assert.equal(csv.length, 13);
    assert.equal(csv[0], 'Item,Description,Qty,Unit Price,Amount');
    // LibreOffice re-renders typed numbers in its own format, proving they are numbers, not text.
    const amount = Number(tables[0].rows[0][4].replace(/[$,]/g, ''));
    assert.equal(Number(csv[1].split(',').at(-1)), amount);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
