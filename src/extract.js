/**
 * pdf2sheet table extraction: pure functions, no DOM and no pdf.js import.
 * Runs unchanged in the browser and in Node (tests).
 *
 * Pipeline:
 *   text items -> rows (y clustering) -> segments (adjacent items merged)
 *   -> runs of table-like rows -> columns (x clustering or user boundaries)
 *   -> wrapped-cell merge -> header detection -> cross-page merge.
 *
 * Coordinates are PDF points with the origin at the TOP-LEFT of the page
 * (y grows downward); `y` of an item is its text baseline.
 *
 * @typedef {{str:string,x:number,y:number,w:number,h:number}} Item
 * @typedef {{page:number,width:number,height:number,items:Item[]}} PageText
 * @typedef {{x0:number,y0:number,x1:number,y1:number}} Box
 * @typedef {{
 *   gap?: number,                    // column gap threshold in pt (default 8)
 *   boundaries?: number[]|null,      // manual column boundaries (x in pt); null = automatic
 *   headerMode?: 'auto'|'none',      // header detection
 *   region?: Box|null,               // only use text inside this box (every page)
 *   pages?: {from:number,to:number}|null, // 1-based inclusive page range
 *   mergeWrapped?: boolean,          // merge wrapped multi-line cells (default true)
 * }} ExtractOptions
 * @typedef {{
 *   id:number, header:string[]|null, rows:string[][], boundaries:number[],
 *   pages:number[], boxes:Array<Box & {page:number}>
 * }} Table
 */

export const DEFAULTS = Object.freeze({
  gap: 8,
  boundaries: null,
  headerMode: 'auto',
  region: null,
  pages: null,
  mergeWrapped: true,
  currency: 'strip',
});

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Convert a pdf.js `getTextContent()` result into page-local items.
 * @param {{items:Array<{str:string,transform:number[],width:number,height:number}>}} textContent
 * @param {{width:number,height:number}} view page size in points (viewport at scale 1)
 * @returns {Item[]}
 */
export function itemsFromTextContent(textContent, view) {
  const out = [];
  for (const it of textContent.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const h = it.height || Math.hypot(c, d) || Math.hypot(a, b);
    out.push({ str: it.str, x: e, y: view.height - f, w: it.width, h });
  }
  return out;
}

/** True when no page carries any non-whitespace text (e.g. a scanned PDF). */
export function hasTextLayer(pages) {
  return pages.some((p) => p.items.some((i) => i.str.trim()));
}

/**
 * Group items into rows: items whose baselines differ by at most
 * 0.5 x median glyph height belong to the same row.
 * @returns {Array<{y:number,items:Item[]}>} rows sorted top to bottom, items left to right
 */
export function groupRows(items, tolerance) {
  const tol = tolerance ?? 0.5 * (median(items.map((i) => i.h)) || 10);
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.y - row.y) <= tol) {
      row.items.push(it);
      row.y = row.items.reduce((s, i) => s + i.y, 0) / row.items.length;
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Join items of one row that are separated by less than a word gap into
 * "segments" (pdf.js may split a single cell into several items).
 */
export function segmentsOf(row, mergeGap) {
  const segs = [];
  for (const it of row.items) {
    const last = segs[segs.length - 1];
    const gap = mergeGap ?? 0.5 * it.h;
    if (last && it.x - last.x1 <= gap) {
      const space = it.x - last.x1 > 0.15 * it.h ? ' ' : '';
      last.str = norm(last.str + space + it.str);
      last.x1 = Math.max(last.x1, it.x + it.w);
    } else {
      segs.push({ str: norm(it.str), x0: it.x, x1: it.x + it.w, y: row.y, h: it.h });
    }
  }
  return segs.filter((s) => s.str);
}

/**
 * Cluster segment x-positions into columns. Segments are sorted by x-start;
 * a segment joins the current column when its x-start is within `gap` pt of
 * the column's furthest x-start, or when it starts inside the column's text
 * extent (keeps right-aligned and centred columns together).
 * @returns {Array<{x0:number,x1:number}>}
 */
export function clusterColumns(segments, gap = DEFAULTS.gap) {
  const sorted = [...segments].sort((a, b) => a.x0 - b.x0);
  const cols = [];
  for (const s of sorted) {
    const c = cols[cols.length - 1];
    if (c && (s.x0 - c.maxStart <= gap || s.x0 < c.x1)) {
      c.maxStart = Math.max(c.maxStart, s.x0);
      c.x1 = Math.max(c.x1, s.x1);
    } else {
      cols.push({ x0: s.x0, x1: s.x1, maxStart: s.x0 });
    }
  }
  return cols.map(({ x0, x1 }) => ({ x0, x1 }));
}

/** Boundaries are the midpoints of the gutters between adjacent columns. */
export function boundariesFromColumns(cols) {
  const b = [];
  for (let i = 1; i < cols.length; i++) b.push(round2((cols[i - 1].x1 + cols[i].x0) / 2));
  return b;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Sort, de-duplicate (closer than 2 pt) and drop invalid boundaries. */
export function normalizeBoundaries(bounds) {
  const s = bounds.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const b of s) if (!out.length || b - out[out.length - 1] >= 2) out.push(b);
  return out;
}

function columnIndex(seg, bounds) {
  const cx = (seg.x0 + seg.x1) / 2;
  let i = 0;
  while (i < bounds.length && cx >= bounds[i]) i++;
  return i;
}

function inBox(it, box) {
  const cx = it.x + it.w / 2;
  const cy = it.y - it.h / 2;
  return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
}

/**
 * Split a page's rows into runs of table-like rows. A run breaks on a vertical
 * gap larger than 2.5 x median glyph height. Rows with a single segment are
 * kept only between multi-segment rows (wrapped cells); runs need at least
 * two multi-segment rows to count as a table.
 */
function tableRuns(rows, medH) {
  const maxGap = 2.5 * medH;
  const runs = [];
  let cur = [];
  const flush = () => {
    while (cur.length && cur[cur.length - 1].segs.length < 2) cur.pop();
    while (cur.length && cur[0].segs.length < 2) cur.shift();
    if (cur.filter((r) => r.segs.length >= 2).length >= 2) runs.push(cur);
    cur = [];
  };
  for (const r of rows) {
    const prev = cur[cur.length - 1];
    if (prev && r.y - prev.y > maxGap) flush();
    cur.push(r);
  }
  flush();
  return runs;
}

const isNumericLike = (s) => parseNumber(s) !== null || parseDate(s) !== null;

function detectHeader(rows, mode) {
  if (mode === 'none') return -1;
  for (let i = 0; i < Math.min(2, rows.length); i++) {
    const filled = rows[i].filter((c) => c !== '');
    if (filled.length >= 2 && filled.every((c) => !isNumericLike(c))) return i;
  }
  return -1;
}

const sameRow = (a, b) => a.length === b.length && a.every((c, i) => norm(c).toLowerCase() === norm(b[i]).toLowerCase());

/**
 * Turn one run of rows into a table using the given boundaries.
 * @returns {{cells:string[][], pitchOk:boolean[]}}
 */
function buildCells(run, bounds, mergeWrapped, medH) {
  const n = bounds.length + 1;
  const out = [];
  let prevY = -Infinity;
  for (const r of run) {
    const cells = Array(n).fill('');
    for (const s of r.segs) {
      const i = columnIndex(s, bounds);
      cells[i] = cells[i] ? `${cells[i]} ${s.str}` : s.str;
    }
    const last = out[out.length - 1];
    const directlyUnder = r.y - prevY <= 1.8 * medH;
    if (mergeWrapped && last && cells[0] === '' && last[0] !== '' && directlyUnder) {
      cells.forEach((c, i) => { if (c) last[i] = last[i] ? `${last[i]} ${c}` : c; });
    } else {
      out.push(cells);
    }
    prevY = r.y;
  }
  return out;
}

/**
 * Extract tables from page text.
 * @param {PageText[]} pages
 * @param {ExtractOptions} [options]
 * @returns {{hasText:boolean, tables:Table[]}}
 */
export function extractTables(pages, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  if (!hasTextLayer(pages)) return { hasText: false, tables: [] };
  const manual = Array.isArray(opt.boundaries) ? normalizeBoundaries(opt.boundaries) : null;

  const tables = [];
  for (const page of pages) {
    if (opt.pages && (page.page < opt.pages.from || page.page > opt.pages.to)) continue;
    const items = opt.region ? page.items.filter((i) => inBox(i, opt.region)) : page.items;
    if (!items.length) continue;
    const medH = median(items.map((i) => i.h)) || 10;
    const rows = groupRows(items, 0.5 * medH).map((r) => ({ y: r.y, segs: segmentsOf(r) }));
    for (const run of tableRuns(rows, medH)) {
      let bounds = manual;
      if (!bounds) {
        const segs = run.filter((r) => r.segs.length >= 2).flatMap((r) => r.segs);
        bounds = boundariesFromColumns(clusterColumns(segs, opt.gap));
      }
      let cells = buildCells(run, bounds, opt.mergeWrapped, medH);
      // Drop columns that are empty in every row (e.g. two manual boundaries side by side).
      const keep = cells[0].map((_, i) => cells.some((r) => r[i] !== ''));
      // Boundary i is the left edge of column i+1: keep it when that column is kept
      // and some kept column lies to its left.
      const keptBounds = bounds.filter((_, i) => keep[i + 1] && keep.slice(0, i + 1).some(Boolean));
      cells = cells.map((r) => r.filter((_, i) => keep[i]));
      const allSegs = run.flatMap((r) => r.segs);
      const box = {
        page: page.page,
        x0: Math.min(...allSegs.map((s) => s.x0)),
        x1: Math.max(...allSegs.map((s) => s.x1)),
        y0: run[0].y - medH,
        y1: run[run.length - 1].y + 0.3 * medH,
      };
      const hi = detectHeader(cells, opt.headerMode);
      const header = hi >= 0 ? cells[hi] : null;
      const body = cells.slice(hi + 1).filter((r) => !(header && sameRow(r, header)));
      tables.push({ header, rows: body, boundaries: manual ? manual : keptBounds, pages: [page.page], boxes: [box], first: tables.length === 0 || tables[tables.length - 1].pages.at(-1) !== page.page });
    }
  }
  return { hasText: true, tables: mergeAcrossPages(tables) };
}

/**
 * A table that starts a page continues the previous page's last table when
 * the column count matches and its header is the same (or absent).
 */
function mergeAcrossPages(tables) {
  const out = [];
  for (const t of tables) {
    const prev = out[out.length - 1];
    const width = (x) => (x.header || x.rows[0] || []).length;
    const continues = prev && t.first && prev.pages.at(-1) === t.pages[0] - 1 &&
      width(prev) === width(t) && (!t.header || (prev.header && sameRow(prev.header, t.header)));
    if (continues) {
      const hdr = prev.header;
      prev.rows.push(...t.rows.filter((r) => !(hdr && sameRow(r, hdr))));
      prev.pages.push(...t.pages);
      prev.boxes.push(...t.boxes);
    } else {
      out.push({ ...t });
    }
  }
  return out.map(({ first, ...t }, id) => ({ id, ...t }));
}

// ---------------------------------------------------------------------------
// Cell typing
// ---------------------------------------------------------------------------
const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|INR|JPY|Rs\.?)\b/gi;

/**
 * Parse an accounting-style number: `1,234.50` -> 1234.5, `(45.00)` -> -45,
 * `-12` -> -12. Currency symbols are allowed unless `currency === 'text'`.
 * @returns {number|null}
 */
export function parseNumber(raw, { currency = 'strip' } = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  CURRENCY.lastIndex = 0;
  const hasCur = CURRENCY.test(s);
  if (hasCur) {
    if (currency === 'text') return null;
    s = s.replace(CURRENCY, '').trim();
  }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
  if (/^\+/.test(s)) s = s.slice(1).trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? (n === 0 ? 0 : -n) : n;
}

/**
 * Recognise `DD/MM/YYYY` and `YYYY-MM-DD`.
 * @returns {{y:number,m:number,d:number,iso:string}|null}
 */
export function parseDate(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  let y, mo, d;
  if (m) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m: mo, d, iso };
}

/** Excel serial day number (1900 date system) for a parsed date. */
export function excelSerial({ y, m, d }) {
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}

/**
 * Type one cell. Returns `{type:'number', value}`, `{type:'date', value:{y,m,d,iso}}`,
 * `{type:'empty'}` or `{type:'text', value}`.
 */
export function inferCell(raw, opts = {}) {
  const s = (raw ?? '').trim();
  if (!s) return { type: 'empty', value: '' };
  const d = parseDate(s);
  if (d) return { type: 'date', value: d };
  const n = parseNumber(s, opts);
  if (n !== null) return { type: 'number', value: n };
  return { type: 'text', value: s };
}

/**
 * Column type: 'number' or 'date' when at least 80% of the non-empty cells
 * parse as that type, otherwise 'text'.
 */
export function inferColumnTypes(rows, opts = {}) {
  const n = Math.max(0, ...rows.map((r) => r.length));
  const types = [];
  for (let c = 0; c < n; c++) {
    const counts = { number: 0, date: 0, text: 0, empty: 0 };
    for (const r of rows) counts[inferCell(r[c], opts).type]++;
    const filled = counts.number + counts.date + counts.text;
    if (filled && counts.number / filled >= 0.8) types.push('number');
    else if (filled && counts.date / filled >= 0.8) types.push('date');
    else types.push('text');
  }
  return types;
}

/**
 * Data checks for the side panel.
 * @returns {{rowCount:number, columns:Array<{name:string,type:string,empty:number}>,
 *            badCells:Array<{row:number,col:number,value:string}>}}
 */
export function analyzeTable({ header, rows }, opts = {}) {
  const types = inferColumnTypes(rows, opts);
  const width = Math.max(types.length, header ? header.length : 0);
  const columns = [];
  const badCells = [];
  for (let c = 0; c < width; c++) {
    const type = types[c] || 'text';
    columns.push({
      name: (header && header[c]) || `Column ${c + 1}`,
      type,
      empty: rows.filter((r) => !(r[c] ?? '').trim()).length,
    });
    if (type === 'number' || type === 'date') {
      rows.forEach((r, i) => {
        const t = inferCell(r[c], opts).type;
        if (t !== 'empty' && t !== type) badCells.push({ row: i, col: c, value: r[c] });
      });
    }
  }
  return { rowCount: rows.length, columns, badCells };
}

/** Sum a column and compare with a user-entered total (to the cent). */
export function totalsCheck(rows, col, expected, opts = {}) {
  let sum = 0;
  for (const r of rows) {
    const n = parseNumber(r[col] ?? '', opts);
    if (n !== null) sum += n;
  }
  sum = Math.round(sum * 100) / 100;
  const exp = typeof expected === 'number' ? expected : parseNumber(String(expected), opts);
  if (exp === null || !Number.isFinite(exp)) return { sum, expected: null, diff: null, match: false };
  const diff = Math.round((sum - exp) * 100) / 100;
  return { sum, expected: exp, diff, match: Math.abs(diff) < 0.005 };
}

/**
 * Convert table rows to typed cells for export.
 * @returns {Array<Array<{t:'n'|'d'|'s', v:number|string}>>}
 */
export function typedRows(rows, opts = {}) {
  return rows.map((r) => r.map((raw) => {
    const c = inferCell(raw, opts);
    if (c.type === 'number') return { t: 'n', v: c.value };
    if (c.type === 'date') return { t: 'd', v: excelSerial(c.value), iso: c.value.iso };
    return { t: 's', v: raw ?? '' };
  }));
}
