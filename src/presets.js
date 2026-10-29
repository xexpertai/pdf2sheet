/**
 * Named extraction presets (column boundaries, header settings, region,
 * page range). Stored in a localStorage-compatible object; exportable as JSON.
 */

export const STORAGE_KEY = 'pdf2sheet.presets.v1';
const FORMAT = 'pdf2sheet-preset';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Validate and normalise a preset. Throws on invalid input.
 * @returns {{format:string, version:1, name:string, settings:object}}
 */
export function validatePreset(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Preset must be an object');
  if (obj.format !== FORMAT) throw new Error('Not a pdf2sheet preset');
  const name = String(obj.name ?? '').trim();
  if (!name) throw new Error('Preset needs a name');
  const s = obj.settings ?? {};
  const settings = {};
  if (s.boundaries != null) {
    if (!Array.isArray(s.boundaries) || !s.boundaries.every(isNum)) throw new Error('boundaries must be numbers');
    settings.boundaries = [...s.boundaries].sort((a, b) => a - b);
  } else settings.boundaries = null;
  if (s.gap != null) {
    if (!isNum(s.gap) || s.gap <= 0) throw new Error('gap must be a positive number');
    settings.gap = s.gap;
  }
  settings.headerMode = s.headerMode === 'none' ? 'none' : 'auto';
  settings.currency = s.currency === 'text' ? 'text' : 'strip';
  settings.mergeWrapped = s.mergeWrapped !== false;
  if (s.region != null) {
    const r = s.region;
    if (![r.x0, r.y0, r.x1, r.y1].every(isNum)) throw new Error('region must be {x0,y0,x1,y1}');
    settings.region = { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
  } else settings.region = null;
  if (s.pages != null) {
    const { from, to } = s.pages;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error('pages must be {from,to}');
    settings.pages = { from, to };
  } else settings.pages = null;
  return { format: FORMAT, version: 1, name, settings };
}

/** Create a preset from current extraction settings. */
export const makePreset = (name, settings) => validatePreset({ format: FORMAT, name, settings });

export const exportPresetJSON = (preset) => JSON.stringify(validatePreset(preset), null, 2);

export function importPresetJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Preset file is not valid JSON'); }
  return validatePreset(obj);
}

/** @param {Storage} storage */
export function listPresets(storage) {
  try {
    const all = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(all) ? all.flatMap((p) => { try { return [validatePreset(p)]; } catch { return []; } }) : [];
  } catch {
    return [];
  }
}

/** Save (or replace by name) a preset. */
export function savePreset(storage, preset) {
  const p = validatePreset(preset);
  const all = listPresets(storage).filter((x) => x.name !== p.name);
  all.push(p);
  all.sort((a, b) => a.name.localeCompare(b.name));
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
  return p;
}

export function deletePreset(storage, name) {
  storage.setItem(STORAGE_KEY, JSON.stringify(listPresets(storage).filter((p) => p.name !== name)));
}

export const getPreset = (storage, name) => listPresets(storage).find((p) => p.name === name) ?? null;
