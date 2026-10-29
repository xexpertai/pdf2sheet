import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPdfText, sample } from './helpers.mjs';
import { extractTables } from '../src/extract.js';
import { parseCSV } from '../src/csv.js';
import {
  makePreset, savePreset, listPresets, getPreset, deletePreset,
  exportPresetJSON, importPresetJSON, validatePreset,
} from '../src/presets.js';

class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
}

const expected = () => parseCSV(readFileSync(sample('expected/statement-demo.csv'), 'utf8'));

test('AC11: committed preset reproduces the AC4 statement output with no manual step', async () => {
  const preset = importPresetJSON(readFileSync(sample('presets/statement-monthly.json'), 'utf8'));
  const { pages } = await loadPdfText('statement-demo.pdf');
  const { tables } = extractTables(pages, preset.settings);
  assert.equal(tables.length, 1);
  assert.deepEqual([tables[0].header, ...tables[0].rows], expected());
});

test('AC11: save -> localStorage -> export JSON -> import -> apply round trip', async () => {
  const { pages } = await loadPdfText('statement-demo.pdf');
  const auto = extractTables(pages).tables[0];
  const store = new MemoryStorage();
  savePreset(store, makePreset('Monthly', { boundaries: auto.boundaries, headerMode: 'auto', region: { x0: 30, y0: 400, x1: 30, y1: 105 } }));
  savePreset(store, makePreset('Other', { boundaries: null }));
  assert.deepEqual(listPresets(store).map((p) => p.name), ['Monthly', 'Other']);
  const json = exportPresetJSON(getPreset(store, 'Monthly'));
  const fresh = new MemoryStorage();
  const imported = savePreset(fresh, importPresetJSON(json));
  assert.deepEqual(imported.settings.region, { x0: 30, y0: 105, x1: 30, y1: 400 }, 'region normalised');
  imported.settings.region = { x0: 30, y0: 105, x1: 565, y1: 420 };
  const t = extractTables(pages, imported.settings).tables[0];
  assert.deepEqual([t.header, ...t.rows], expected());
  deletePreset(store, 'Other');
  assert.deepEqual(listPresets(store).map((p) => p.name), ['Monthly']);
});

test('presets: invalid input is rejected', () => {
  assert.throws(() => importPresetJSON('{nope'), /not valid JSON/);
  assert.throws(() => validatePreset({ format: 'x', name: 'a' }), /Not a pdf2sheet preset/);
  assert.throws(() => makePreset('', {}), /name/);
  assert.throws(() => makePreset('a', { boundaries: ['1'] }), /numbers/);
  assert.throws(() => makePreset('a', { pages: { from: 3, to: 1 } }), /pages/);
  const store = new MemoryStorage();
  store.setItem('pdf2sheet.presets.v1', 'garbage');
  assert.deepEqual(listPresets(store), []);
});
