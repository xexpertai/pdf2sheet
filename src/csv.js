/**
 * RFC 4180 CSV writer and parser (also used for TSV clipboard copies).
 */

/**
 * Serialise rows. Fields containing the delimiter, a quote, CR or LF are
 * quoted, and quotes are doubled. Records end with CRLF.
 * @param {string[][]} rows
 * @param {{delimiter?:string, bom?:boolean, eol?:string}} [opts]
 */
export function toCSV(rows, { delimiter = ',', bom = false, eol = '\r\n' } = {}) {
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new Error('Invalid delimiter');
  const needs = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&')}]`);
  const field = (v) => {
    const s = v == null ? '' : String(v);
    return needs.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => r.map(field).join(delimiter)).join(eol);
  return (bom ? '﻿' : '') + (rows.length ? body + eol : '');
}

/** Tab-separated text for pasting into Excel / Google Sheets. */
export const toTSV = (rows) => toCSV(rows, { delimiter: '\t', eol: '\n' });

/**
 * Parse CSV text (handles quoted fields, doubled quotes, embedded newlines,
 * CRLF/LF line endings and a leading BOM).
 * @returns {string[][]}
 */
export function parseCSV(text, { delimiter = ',' } = {}) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
