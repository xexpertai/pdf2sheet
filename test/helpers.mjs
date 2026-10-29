// Test helper: load a fixture PDF with the pdfjs-dist *legacy* build in Node and
// return page text in the shape extract.js expects.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { itemsFromTextContent } from '../src/extract.js';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const sample = (name) => `${root}samples/${name}`;

// Text extraction never renders, so tiny stubs satisfy pdf.js' import-time
// checks without the optional native @napi-rs/canvas package.
globalThis.DOMMatrix ??= class DOMMatrix { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } };
globalThis.ImageData ??= class ImageData {};
globalThis.Path2D ??= class Path2D {};

let pdfjsPromise;
async function pdfjs() {
  if (!pdfjsPromise) {
    // pdf.js logs a warning about the missing optional canvas package; keep test output clean.
    const { log, warn } = console;
    console.log = console.warn = () => {};
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').finally(() => { console.log = log; console.warn = warn; });
  }
  return pdfjsPromise;
}

/** @returns {Promise<{numPages:number, pages:import('../src/extract.js').PageText[]}>} */
export async function loadPdfText(name) {
  const lib = await pdfjs();
  const data = new Uint8Array(readFileSync(sample(name)));
  const task = lib.getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ page: n, width: view.width, height: view.height, items: itemsFromTextContent(tc, view) });
  }
  const numPages = doc.numPages;
  await task.destroy();
  return { numPages, pages };
}
