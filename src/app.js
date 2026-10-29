/**
 * pdf2sheet UI controller. All processing happens in this tab:
 * pdf.js (vendored) reads the file, extract.js finds tables, xlsx.js / csv.js export.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import {
  DEFAULTS, extractTables, itemsFromTextContent, hasTextLayer, analyzeTable,
  totalsCheck, inferColumnTypes, normalizeBoundaries,
} from './extract.js';
import { buildXlsx } from './xlsx.js';
import { toCSV, toTSV } from './csv.js';
import {
  makePreset, savePreset, listPresets, getPreset, deletePreset, exportPresetJSON, importPresetJSON,
} from './presets.js';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;

const MAX_BYTES = 20 * 1024 * 1024;
const MSG_SCANNED = 'No text layer found: this PDF looks scanned; OCR is not supported.';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids);
  return n;
};

const state = {
  doc: null,
  task: null,
  fileName: '',
  pages: [], // PageText[] for extract.js
  pageSizes: [],
  current: 1,
  scale: 1,
  settings: { ...DEFAULTS },
  tables: [],
  active: 0,
  mode: 'columns',
  loadToken: 0,
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function showError(msg) {
  const e = $('error');
  e.textContent = msg;
  e.hidden = !msg;
}
const setStatus = (msg) => { $('status').textContent = msg; };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function openFile(file) {
  showError('');
  if (!file) return;
  const looksPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!looksPdf) return showError(`"${file.name}" is not a PDF file. Please choose a .pdf file.`);
  if (file.size > MAX_BYTES) {
    return showError(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
  }
  const data = new Uint8Array(await file.arrayBuffer());
  await openBytes(data, file.name);
}

async function openBytes(data, name) {
  const token = ++state.loadToken;
  showError('');
  const head = new TextDecoder().decode(data.subarray(0, 1024));
  if (!head.includes('%PDF-')) return showError(`"${name}" does not look like a PDF (missing %PDF header).`);
  setStatus(`Opening ${name}…`);
  if (state.task) { state.task.destroy(); state.task = null; state.doc = null; }
  let doc;
  let task;
  try {
    task = pdfjsLib.getDocument({
      data,
      enableXfa: false,
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`,
      iccUrl: `${VENDOR}iccs/`,
    });
    doc = await task.promise;
  } catch (err) {
    setStatus('');
    if (err?.name === 'PasswordException') return showError('This PDF is password-protected; protected PDFs are not supported.');
    return showError(`Could not read "${name}": ${err?.message || err}`);
  }
  if (token !== state.loadToken) return task.destroy();
  Object.assign(state, { doc, task, fileName: name, current: 1, tables: [], active: 0, pages: [], pageSizes: [] });
  state.settings = { ...state.settings, boundaries: null, region: null, pages: { from: 1, to: doc.numPages } };
  $('page-from').max = $('page-to').max = String(doc.numPages);
  syncSettingsForm();
  $('totals-value').value = '';
  $('workspace').hidden = false;
  $('doc-info').textContent = `· ${name} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  buildThumbStrip(doc.numPages);
  setStatus(`${name}: ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}. Reading text…`);

  const t0 = performance.now();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    if (token !== state.loadToken) return;
    state.pageSizes[n - 1] = { width: view.width, height: view.height };
    state.pages.push({ page: n, width: view.width, height: view.height, items: itemsFromTextContent(tc, view) });
  }
  await renderPreview();
  renderThumbs(token);
  if (!hasTextLayer(state.pages)) {
    showError(MSG_SCANNED);
    setStatus(`${name}: ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}, no text layer.`);
    state.tables = [];
    renderResults();
    return;
  }
  runExtract(`Read ${doc.numPages} page${doc.numPages === 1 ? '' : 's'} in ${Math.round(performance.now() - t0)} ms.`);
}

// ---------------------------------------------------------------------------
// Thumbnails and preview
// ---------------------------------------------------------------------------
function buildThumbStrip(count) {
  const strip = $('thumbs');
  strip.replaceChildren();
  for (let n = 1; n <= count; n++) {
    strip.append(el('button', {
      type: 'button', class: 'thumb', 'data-page': n, 'aria-label': `Page ${n}`,
      'aria-current': n === state.current ? 'page' : null,
      onclick: () => goToPage(n),
    }, el('canvas', { width: 72, height: 100, 'aria-hidden': 'true' }), el('span', { text: String(n) })));
  }
}

async function renderThumbs(token) {
  for (const btn of $('thumbs').querySelectorAll('.thumb')) {
    if (token !== state.loadToken) return;
    const page = await state.doc.getPage(Number(btn.dataset.page));
    const vp = page.getViewport({ scale: 144 / page.getViewport({ scale: 1 }).width });
    const canvas = btn.querySelector('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

async function goToPage(n) {
  state.current = n;
  for (const b of $('thumbs').querySelectorAll('.thumb')) {
    if (Number(b.dataset.page) === n) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  await renderPreview();
}

let renderTask = null;
async function renderPreview() {
  if (!state.doc) return;
  const page = await state.doc.getPage(state.current);
  const base = page.getViewport({ scale: 1 });
  const avail = Math.max(280, $('stage').clientWidth - 2);
  state.scale = Math.min(1.6, avail / base.width);
  const vp = page.getViewport({ scale: state.scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = $('page-canvas');
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  canvas.setAttribute('aria-label', `Preview of page ${state.current}`);
  const ov = $('overlay');
  ov.style.width = `${vp.width}px`;
  ov.style.height = `${vp.height}px`;
  renderTask?.cancel();
  renderTask = page.render({
    canvas, canvasContext: canvas.getContext('2d'), viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  try { await renderTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') throw e; }
  drawOverlay();
}

/** Boundaries shown for the current page, each with the vertical span it covers. */
function visibleBoundarySets() {
  const size = state.pageSizes[state.current - 1];
  if (!size) return [];
  if (state.settings.boundaries) {
    const r = state.settings.region;
    return [{ manual: true, bounds: state.settings.boundaries, y0: r ? r.y0 : 0, y1: r ? r.y1 : size.height }];
  }
  return state.tables.flatMap((t) => t.boxes.filter((b) => b.page === state.current)
    .map((b) => ({ manual: false, table: t, bounds: t.boundaries, y0: b.y0, y1: b.y1, box: b })));
}

function drawOverlay() {
  const ov = $('overlay');
  ov.replaceChildren();
  ov.classList.toggle('region-mode', state.mode === 'region');
  const s = state.scale;
  const size = state.pageSizes[state.current - 1];
  if (!size) return;
  for (const set of visibleBoundarySets()) {
    if (set.box) {
      ov.append(el('div', { class: 'tbox', 'aria-hidden': 'true', style: `left:${set.box.x0 * s - 4}px;top:${set.y0 * s}px;width:${(set.box.x1 - set.box.x0) * s + 8}px;height:${(set.y1 - set.y0) * s}px` }));
    }
    set.bounds.forEach((x, i) => {
      const h = el('div', {
        class: `bnd${set.manual ? '' : ' auto'}`, tabindex: 0, role: 'slider',
        'aria-label': `Column boundary ${i + 1}`, 'aria-orientation': 'horizontal',
        'aria-valuemin': 0, 'aria-valuemax': Math.round(size.width), 'aria-valuenow': Math.round(x),
        'aria-valuetext': `${Math.round(x)} points from the left edge`,
        'data-index': i,
        style: `left:${x * s}px;top:${set.y0 * s}px;height:${(set.y1 - set.y0) * s}px`,
      });
      h.addEventListener('pointerdown', (ev) => startDrag(ev, h, set, i));
      h.addEventListener('dblclick', (ev) => { ev.stopPropagation(); editBoundaries(set, (b) => b.filter((_, k) => k !== i)); });
      h.addEventListener('keydown', (ev) => boundaryKey(ev, set, i));
      ov.append(h);
    });
  }
  const r = state.settings.region;
  if (r) ov.append(el('div', { class: 'region', 'aria-hidden': 'true', style: `left:${r.x0 * s}px;top:${r.y0 * s}px;width:${(r.x1 - r.x0) * s}px;height:${(r.y1 - r.y0) * s}px` }));
}

/** Switch to manual boundaries (seeded from the shown table) and apply `fn`. */
function editBoundaries(set, fn, focusIndex = null) {
  const base = set?.bounds ?? state.settings.boundaries ?? [];
  const size = state.pageSizes[state.current - 1];
  const next = normalizeBoundaries(fn([...base])).filter((x) => x > 0 && x < size.width);
  state.settings.boundaries = next;
  runExtract();
  if (focusIndex != null) {
    const target = $('overlay').querySelectorAll('.bnd')[Math.min(focusIndex, next.length - 1)];
    target?.focus();
  }
}

function startDrag(ev, handle, set, i) {
  if (state.mode !== 'columns' || ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  handle.setPointerCapture(ev.pointerId);
  handle.classList.add('dragging');
  const ovRect = $('overlay').getBoundingClientRect();
  let x = set.bounds[i];
  const move = (e) => {
    x = Math.max(0, (e.clientX - ovRect.left) / state.scale);
    handle.style.left = `${x * state.scale}px`;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    handle.classList.remove('dragging');
    if (Math.abs(x - set.bounds[i]) < 0.5) return;
    // Dropping a line onto a neighbour (within 6 px) merges the two columns.
    const snap = 6 / state.scale;
    editBoundaries(set, (b) => {
      const others = b.filter((_, k) => k !== i);
      return others.some((o) => Math.abs(o - x) < snap) ? others : [...others, x];
    });
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function boundaryKey(ev, set, i) {
  const step = ev.shiftKey ? 10 : 1;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    const d = ev.key === 'ArrowLeft' ? -step : step;
    editBoundaries(set, (b) => b.map((x, k) => (k === i ? x + d : x)), i);
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    editBoundaries(set, (b) => b.filter((_, k) => k !== i), i);
  }
}

function setupOverlay() {
  const ov = $('overlay');
  let box = null;
  const pt = (e) => {
    const r = ov.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  };
  ov.addEventListener('click', (e) => {
    if (state.mode !== 'columns' || e.target !== ov || !state.pages.length) return;
    const { x, y } = pt(e);
    const sets = visibleBoundarySets();
    const set = sets.find((s) => y >= s.y0 && y <= s.y1) ?? sets[0];
    editBoundaries(set, (b) => [...b, x]);
  });
  ov.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'region' || e.button !== 0) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    const start = pt(e);
    box = el('div', { class: 'region' });
    ov.append(box);
    const move = (ev) => {
      const p = pt(ev);
      const r = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) };
      Object.assign(box.style, { left: `${r.x0 * state.scale}px`, top: `${r.y0 * state.scale}px`, width: `${(r.x1 - r.x0) * state.scale}px`, height: `${(r.y1 - r.y0) * state.scale}px` });
      box.r = r;
    };
    const up = () => {
      ov.removeEventListener('pointermove', move);
      ov.removeEventListener('pointerup', up);
      if (box?.r && box.r.x1 - box.r.x0 > 5 && box.r.y1 - box.r.y0 > 5) {
        const r = box.r;
        state.settings.region = { x0: round1(r.x0), y0: round1(r.y0), x1: round1(r.x1), y1: round1(r.y1) };
        runExtract();
      } else drawOverlay();
      box = null;
    };
    ov.addEventListener('pointermove', move);
    ov.addEventListener('pointerup', up);
  });
}
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
function runExtract(prefix = '') {
  if (!state.pages.length || !hasTextLayer(state.pages)) return;
  const t0 = performance.now();
  const { tables } = extractTables(state.pages, state.settings);
  const ms = performance.now() - t0;
  state.tables = tables.map((t, i) => ({ ...t, name: `Table ${i + 1}` }));
  state.active = Math.min(state.active, Math.max(0, state.tables.length - 1));
  const rows = state.tables.reduce((s, t) => s + t.rows.length, 0);
  const msg = state.tables.length
    ? `${state.tables.length} table${state.tables.length === 1 ? '' : 's'}, ${rows} data rows (extracted in ${ms.toFixed(0)} ms).`
    : 'No tables found with these settings. Try clearing the region, widening the page range or lowering the column gap.';
  setStatus([prefix, msg].filter(Boolean).join(' '));
  drawOverlay();
  renderResults();
}

// ---------------------------------------------------------------------------
// Results grid
// ---------------------------------------------------------------------------
const activeTable = () => state.tables[state.active] ?? null;

function renderResults(focus) {
  renderTabs();
  renderGrid(focus);
  renderChecks();
  const has = !!activeTable();
  for (const id of ['export-xlsx', 'export-csv', 'copy-tsv', 'demote-header']) $(id).disabled = !has;
  if (has) $('demote-header').disabled = !activeTable().header;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...state.tables.map((t, i) => el('button', {
    type: 'button', class: 'btn', role: 'tab', id: `tab-${i}`,
    'aria-selected': i === state.active ? 'true' : 'false', tabindex: i === state.active ? 0 : -1,
    text: `${t.name} · p${t.pages[0]}${t.pages.length > 1 ? `–${t.pages.at(-1)}` : ''} · ${t.rows.length} rows`,
    onclick: () => { state.active = i; renderResults(); },
    onkeydown: (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      state.active = (i + d + state.tables.length) % state.tables.length;
      renderResults();
      $(`tab-${state.active}`).focus();
    },
  })));
  $('grid-wrap').setAttribute('aria-labelledby', state.tables.length ? `tab-${state.active}` : 'results-h');
}

const width = (t) => Math.max(t.header?.length ?? 0, ...t.rows.map((r) => r.length), 0);

function renderGrid(focus) {
  const wrap = $('grid-wrap');
  const t = activeTable();
  if (!t) {
    wrap.replaceChildren(el('p', { class: 'muted', style: 'padding:.6rem', text: state.pages.length ? 'No table to show.' : '' }));
    return;
  }
  const n = width(t);
  const types = inferColumnTypes(t.rows, state.settings);
  const bad = new Set(analyzeTable(t, state.settings).badCells.map((b) => `${b.row}:${b.col}`));
  const headRow = el('tr', {}, el('th', { scope: 'col', class: 'rowhead', text: '#' }));
  for (let c = 0; c < n; c++) {
    const name = t.header?.[c] ?? `Column ${c + 1}`;
    headRow.append(el('th', { scope: 'col' }, el('div', { class: 'hcell' },
      el('span', { class: 'hname', 'data-r': -1, 'data-c': c, tabindex: -1, text: name }),
      el('button', { type: 'button', class: 'icon', 'aria-label': `Delete column ${name}`, title: 'Delete column', text: '×', onclick: () => deleteColumn(c) }))));
  }
  const body = el('tbody');
  t.rows.forEach((row, r) => {
    const tr = el('tr', {}, el('th', { scope: 'row', class: 'rowhead' },
      `${r + 1} `,
      el('button', { type: 'button', class: 'icon', 'aria-label': `Delete row ${r + 1}`, title: 'Delete row', text: '×', onclick: () => deleteRow(r) }),
      el('button', { type: 'button', class: 'icon', 'aria-label': `Use row ${r + 1} as header`, title: 'Use as header', text: 'H', onclick: () => promoteRow(r) })));
    for (let c = 0; c < n; c++) {
      const cls = [types[c] === 'number' ? 'num' : '', bad.has(`${r}:${c}`) ? 'bad' : ''].filter(Boolean).join(' ');
      tr.append(el('td', { 'data-r': r, 'data-c': c, tabindex: -1, class: cls || null, title: bad.has(`${r}:${c}`) ? 'Does not parse as this column\'s type' : null, text: row[c] ?? '' }));
    }
    body.append(tr);
  });
  const table = el('table', { class: 'grid', role: 'grid', 'aria-label': `${t.name} data`, 'aria-rowcount': t.rows.length + 1, 'aria-colcount': n + 1 },
    el('thead', {}, headRow), body);
  table.addEventListener('keydown', gridKey);
  table.addEventListener('dblclick', (e) => { const c = e.target.closest('[data-r]'); if (c) startEdit(c); });
  table.addEventListener('focusin', (e) => { const c = e.target.closest('[data-r]'); if (c) setRoving(c); });
  wrap.replaceChildren(table);
  const want = focus ? table.querySelector(`[data-r="${focus.r}"][data-c="${focus.c}"]`) : null;
  const first = want ?? table.querySelector('[data-r]');
  if (first) { first.tabIndex = 0; if (want) want.focus(); }
}

function setRoving(cell) {
  for (const c of $('grid-wrap').querySelectorAll('[data-r][tabindex="0"]')) if (c !== cell) c.tabIndex = -1;
  cell.tabIndex = 0;
}

function gridKey(e) {
  const cell = e.target.closest('[data-r]');
  if (!cell) return;
  if (cell.isContentEditable) {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(cell); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(cell, 1); }
    else if (e.key === 'Tab') { commitEdit(cell, 0, false); }
    return;
  }
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -Infinity], End: [0, Infinity] };
  if (moves[e.key]) {
    e.preventDefault();
    const t = activeTable();
    const nr = Math.max(-1, Math.min(t.rows.length - 1, r + moves[e.key][0]));
    const nc = Math.max(0, Math.min(width(t) - 1, c + moves[e.key][1]));
    const next = $('grid-wrap').querySelector(`[data-r="${nr}"][data-c="${nc}"]`);
    if (next) { setRoving(next); next.focus(); }
  } else if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault();
    startEdit(cell);
  }
}

function startEdit(cell) {
  cell.dataset.orig = cell.textContent;
  cell.contentEditable = 'true';
  cell.setAttribute('aria-label', `Editing: ${cell.textContent || 'empty cell'}`);
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  cell.addEventListener('blur', () => { if (cell.isContentEditable) commitEdit(cell, 0, false); }, { once: true });
}

function cancelEdit(cell) {
  cell.textContent = cell.dataset.orig ?? cell.textContent;
  endEdit(cell);
  cell.focus();
}

function endEdit(cell) {
  cell.contentEditable = 'false';
  cell.removeAttribute('contenteditable');
  cell.removeAttribute('aria-label');
  delete cell.dataset.orig;
}

function commitEdit(cell, down, refocus = true) {
  const t = activeTable();
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const value = cell.innerText.replace(/\n$/, '');
  const changed = value !== cell.dataset.orig;
  endEdit(cell);
  if (!changed) { if (refocus) cell.focus(); return; }
  if (r === -1) {
    t.header = t.header ? [...t.header] : Array.from({ length: width(t) }, (_, i) => `Column ${i + 1}`);
    t.header[c] = value;
  } else {
    t.rows[r] = [...t.rows[r]];
    t.rows[r][c] = value;
  }
  const nr = Math.min(t.rows.length - 1, r + down);
  renderResults(refocus ? { r: nr, c } : null);
}

function deleteColumn(c) {
  const t = activeTable();
  if (t.header) t.header = t.header.filter((_, i) => i !== c);
  t.rows = t.rows.map((r) => r.filter((_, i) => i !== c));
  renderResults({ r: -1, c: Math.max(0, c - 1) });
}

function deleteRow(r) {
  const t = activeTable();
  t.rows = t.rows.filter((_, i) => i !== r);
  renderResults(t.rows.length ? { r: Math.min(r, t.rows.length - 1), c: 0 } : null);
}

function promoteRow(r) {
  const t = activeTable();
  t.header = [...t.rows[r]];
  t.rows = t.rows.filter((_, i) => i !== r);
  renderResults({ r: -1, c: 0 });
}

function demoteHeader() {
  const t = activeTable();
  if (!t?.header) return;
  t.rows = [t.header, ...t.rows];
  t.header = null;
  renderResults({ r: 0, c: 0 });
}

// ---------------------------------------------------------------------------
// Data checks
// ---------------------------------------------------------------------------
function renderChecks() {
  const box = $('checks');
  const t = activeTable();
  const sel = $('totals-col');
  $('totals-result').textContent = '';
  if (!t) { box.replaceChildren(el('p', { class: 'muted', text: 'No table selected.' })); sel.replaceChildren(); return; }
  const a = analyzeTable(t, state.settings);
  const table = el('table', { class: 'checks-table' },
    el('caption', { class: 'visually-hidden', text: 'Column summary' }),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Column' }), el('th', { scope: 'col', text: 'Type' }), el('th', { scope: 'col', text: 'Empty' }))),
    el('tbody', {}, ...a.columns.map((c) => el('tr', {}, el('td', { text: c.name }), el('td', { text: c.type }), el('td', { text: String(c.empty) })))));
  const kids = [el('p', {}, el('strong', { text: String(a.rowCount) }), ' data rows'), table];
  if (a.badCells.length) {
    kids.push(el('p', { class: 'mismatch', text: `${a.badCells.length} cell${a.badCells.length === 1 ? '' : 's'} fail to parse (highlighted in the grid):` }),
      el('ul', { class: 'bad-list' }, ...a.badCells.slice(0, 8).map((b) => el('li', { text: `Row ${b.row + 1}, ${a.columns[b.col].name}: "${b.value}"` }))));
  } else {
    kids.push(el('p', { class: 'match', text: 'All numeric and date cells parse.' }));
  }
  box.replaceChildren(...kids);
  const prev = sel.value;
  const numeric = a.columns.map((c, i) => ({ ...c, i })).filter((c) => c.type === 'number');
  sel.replaceChildren(...numeric.map((c) => el('option', { value: c.i, text: c.name })));
  if (numeric.some((c) => String(c.i) === prev)) sel.value = prev;
  else if (numeric.length) sel.value = String(numeric.at(-1).i);
  $('totals').querySelector('button').disabled = !numeric.length;
}

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function runTotalsCheck(e) {
  e.preventDefault();
  const t = activeTable();
  const out = $('totals-result');
  if (!t || $('totals-col').value === '') return;
  const res = totalsCheck(t.rows, Number($('totals-col').value), $('totals-value').value, state.settings);
  if (res.expected === null) { out.className = 'mismatch'; out.textContent = `Enter a number to compare. Column sum is ${fmt(res.sum)}.`; return; }
  out.className = res.match ? 'match' : 'mismatch';
  out.textContent = res.match
    ? `Match ✓ Column sum ${fmt(res.sum)} equals the expected total.`
    : `Mismatch ✗ Column sum ${fmt(res.sum)}, expected ${fmt(res.expected)}, difference ${fmt(res.diff)}.`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const baseName = () => (state.fileName || 'tables').replace(/\.pdf$/i, '');

function download(bytesOrText, name, type) {
  const url = URL.createObjectURL(new Blob([bytesOrText], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportXlsx() {
  if (!state.tables.length) return;
  const bytes = buildXlsx(state.tables, state.settings);
  download(bytes, `${baseName()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setStatus(`Saved ${baseName()}.xlsx (${state.tables.length} sheet${state.tables.length === 1 ? '' : 's'}).`);
}

const rowsWithHeader = (t) => (t.header ? [t.header, ...t.rows] : t.rows);

function exportCsv() {
  const t = activeTable();
  if (!t) return;
  const d = $('csv-delim').value;
  const text = toCSV(rowsWithHeader(t), { delimiter: d === 'tab' ? '\t' : d, bom: $('csv-bom').checked });
  const suffix = state.tables.length > 1 ? `-table${state.active + 1}` : '';
  download(text, `${baseName()}${suffix}.${d === 'tab' ? 'tsv' : 'csv'}`, 'text/csv;charset=utf-8');
}

async function copyTsv() {
  const t = activeTable();
  if (!t) return;
  const text = toTSV(rowsWithHeader(t));
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  setStatus(`Copied ${t.rows.length + (t.header ? 1 : 0)} rows as TSV. Paste into Excel or Google Sheets.`);
}

// ---------------------------------------------------------------------------
// Settings and presets
// ---------------------------------------------------------------------------
function syncSettingsForm() {
  const s = state.settings;
  $('gap').value = s.gap;
  const total = state.doc?.numPages ?? 1;
  $('page-from').value = s.pages?.from ?? 1;
  $('page-to').value = Math.min(s.pages?.to ?? total, total);
  $('header-mode').value = s.headerMode;
  $('currency').value = s.currency;
  $('merge-wrapped').checked = s.mergeWrapped;
}

let debounce;
function readSettingsForm() {
  const total = state.doc?.numPages ?? 1;
  const clamp = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
  const from = clamp(parseFloat($('page-from').value), 1, total, 1);
  const to = clamp(parseFloat($('page-to').value), from, total, total);
  const gap = parseFloat($('gap').value);
  Object.assign(state.settings, {
    gap: Number.isFinite(gap) && gap > 0 ? gap : DEFAULTS.gap,
    pages: { from, to },
    headerMode: $('header-mode').value,
    currency: $('currency').value,
    mergeWrapped: $('merge-wrapped').checked,
  });
  clearTimeout(debounce);
  debounce = setTimeout(() => runExtract(), 120);
}

function refreshPresetList(select) {
  const list = listPresets(localStorage);
  $('preset-list').replaceChildren(...(list.length
    ? list.map((p) => el('option', { value: p.name, text: p.name }))
    : [el('option', { value: '', text: 'No saved presets' })]));
  if (select) $('preset-list').value = select;
  for (const id of ['preset-apply', 'preset-delete', 'preset-export']) $(id).disabled = !list.length;
}

function applyPreset(p) {
  const total = state.doc?.numPages ?? 1;
  state.settings = { ...DEFAULTS, ...p.settings };
  if (!state.settings.pages) state.settings.pages = { from: 1, to: total };
  syncSettingsForm();
  runExtract(`Applied preset "${p.name}".`);
}

function setupPresets() {
  refreshPresetList();
  $('preset-save').addEventListener('click', () => {
    const name = $('preset-name').value.trim();
    if (!name) { $('preset-name').focus(); return setStatus('Type a name for the preset first.'); }
    const t = activeTable();
    const total = state.doc?.numPages ?? 1;
    const s = state.settings;
    const pages = s.pages && !(s.pages.from === 1 && s.pages.to === total) ? s.pages : null;
    const p = savePreset(localStorage, makePreset(name, {
      ...s, pages, boundaries: s.boundaries ?? t?.boundaries ?? null,
    }));
    refreshPresetList(p.name);
    setStatus(`Saved preset "${p.name}".`);
  });
  $('preset-apply').addEventListener('click', () => {
    const p = getPreset(localStorage, $('preset-list').value);
    if (p) applyPreset(p);
  });
  $('preset-delete').addEventListener('click', () => {
    const name = $('preset-list').value;
    if (!name) return;
    deletePreset(localStorage, name);
    refreshPresetList();
    setStatus(`Deleted preset "${name}".`);
  });
  $('preset-export').addEventListener('click', () => {
    const p = getPreset(localStorage, $('preset-list').value);
    if (p) download(exportPresetJSON(p), `${p.name.replace(/[^\w.-]+/g, '_')}.pdf2sheet.json`, 'application/json');
  });
  $('preset-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const p = savePreset(localStorage, importPresetJSON(await f.text()));
      refreshPresetList(p.name);
      showError('');
      if (state.pages.length) applyPreset(p); else setStatus(`Imported preset "${p.name}".`);
    } catch (err) {
      showError(`Could not import preset: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setup() {
  $('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 1) showError('Please drop one PDF at a time.');
    else openFile(files[0]);
  });
  // Dropping outside the zone must not navigate away from the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); openFile(e.dataTransfer?.files?.[0]); } });

  for (const b of document.querySelectorAll('[data-sample]')) {
    b.addEventListener('click', async () => {
      try {
        const res = await fetch(`samples/${b.dataset.sample}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await openBytes(new Uint8Array(await res.arrayBuffer()), b.dataset.sample);
      } catch (err) {
        showError(`Could not load the demo file (${err.message}). Serve the folder over HTTP, e.g. "python3 -m http.server".`);
      }
    });
  }

  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => {
      state.mode = r.value;
      $('hint').textContent = state.mode === 'region'
        ? 'Drag a box around the table to limit extraction to that area (applies to every page in the range).'
        : 'Click the page to add a column boundary, drag a line to move it, double-click (or press Delete) to remove it.';
      drawOverlay();
    });
  }
  $('clear-region').addEventListener('click', () => { state.settings.region = null; runExtract(); });
  $('auto-cols').addEventListener('click', () => { state.settings.boundaries = null; runExtract(); });
  for (const id of ['gap', 'page-from', 'page-to', 'header-mode', 'currency', 'merge-wrapped']) {
    $(id).addEventListener(id.startsWith('page') || id === 'gap' ? 'input' : 'change', readSettingsForm);
  }
  $('totals').addEventListener('submit', runTotalsCheck);
  $('export-xlsx').addEventListener('click', exportXlsx);
  $('export-csv').addEventListener('click', exportCsv);
  $('copy-tsv').addEventListener('click', copyTsv);
  $('demote-header').addEventListener('click', demoteHeader);
  setupOverlay();
  setupPresets();

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPreview, 150); });
}

setup();
// Exposed for the automated smoke test only.
window.pdf2sheet = { state, openBytes };
