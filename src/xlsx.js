/**
 * Minimal XLSX (Office Open XML SpreadsheetML) writer, no dependencies.
 * Features: one sheet per table, bold header row, typed number/date cells,
 * shared strings, auto column widths and a frozen top row.
 */
import { zipStore } from './zip.js';
import { typedRows } from './extract.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Escape text for XML and drop characters XML 1.0 forbids. */
export function xmlEscape(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel sheet names: max 31 chars, no []:*?/\ , unique, not empty. */
export function sheetNames(names) {
  const used = new Set();
  return names.map((raw, i) => {
    let base = String(raw || `Table ${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || `Table ${i + 1}`;
    base = base.slice(0, 31);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Style indexes in styles.xml (cellXfs): 0 normal, 1 bold header, 2 date.
const S_HEADER = 1;
const S_DATE = 2;

function stylesXml() {
  return `${XML}<styleSheet xmlns="${NS}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

function sheetXml(table, sst, opts) {
  const header = table.header || null;
  const body = typedRows(table.rows, opts);
  const width = Math.max(header ? header.length : 0, ...table.rows.map((r) => r.length), 1);
  const widths = Array(width).fill(8);
  const fit = (c, text) => { widths[c] = Math.min(60, Math.max(widths[c], String(text).length + 2)); };

  const rowsXml = [];
  let r = 1;
  const str = (ref, text, style) => {
    const idx = sst.add(text);
    return `<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${idx}</v></c>`;
  };
  if (header) {
    const cells = header.map((h, c) => { fit(c, h); return str(`${colName(c)}${r}`, h, S_HEADER); });
    rowsXml.push(`<row r="${r}">${cells.join('')}</row>`);
    r++;
  }
  for (const row of body) {
    const cells = [];
    row.forEach((cell, c) => {
      const ref = `${colName(c)}${r}`;
      if (cell.t === 'n') { fit(c, table.rows[r - (header ? 2 : 1)][c]); cells.push(`<c r="${ref}" t="n"><v>${cell.v}</v></c>`); }
      else if (cell.t === 'd') { fit(c, '0000-00-00'); cells.push(`<c r="${ref}" t="n" s="${S_DATE}"><v>${cell.v}</v></c>`); }
      else if (cell.v !== '') { fit(c, cell.v); cells.push(str(ref, cell.v)); }
    });
    rowsXml.push(`<row r="${r}">${cells.join('')}</row>`);
    r++;
  }
  const lastRef = `${colName(width - 1)}${Math.max(1, r - 1)}`;
  const pane = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}"><dimension ref="A1:${lastRef}"/>${pane}` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowsXml.join('')}</sheetData></worksheet>`;
}

/**
 * Build an .xlsx file.
 * @param {Array<{name?:string, header:string[]|null, rows:string[][]}>} tables
 * @param {{currency?:'strip'|'text'}} [opts] cell typing options
 * @returns {Uint8Array}
 */
export function buildXlsx(tables, opts = {}) {
  if (!tables.length) throw new Error('Nothing to export');
  const strings = [];
  const index = new Map();
  const sst = {
    count: 0,
    add(s) {
      this.count++;
      if (!index.has(s)) { index.set(s, strings.length); strings.push(s); }
      return index.get(s);
    },
  };
  const names = sheetNames(tables.map((t) => t.name));
  const sheets = tables.map((t) => sheetXml(t, sst, opts));

  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'docProps/app.xml',
      data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>pdf2sheet</Application></Properties>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>` +
        names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheets.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    {
      name: 'xl/sharedStrings.xml',
      data: `${XML}<sst xmlns="${NS}" count="${sst.count}" uniqueCount="${strings.length}">` +
        strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('') + '</sst>',
    },
  ];
  return zipStore(files);
}
