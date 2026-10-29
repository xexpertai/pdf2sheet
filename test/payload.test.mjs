import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { root } from './helpers.mjs';

const appFiles = () => ['index.html', 'styles.css', ...readdirSync(`${root}src`).map((f) => `src/${f}`)];

test('app payload (excluding pdf.js) is <= 150 KB', () => {
  const total = appFiles().reduce((s, f) => s + statSync(`${root}${f}`).size, 0);
  assert.ok(total <= 150 * 1024, `payload ${total} bytes`);
});

test('no external URLs are fetched at runtime (no CDNs, no analytics)', () => {
  for (const f of appFiles()) {
    const src = readFileSync(`${root}${f}`, 'utf8');
    const urls = [...src.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/g)].map((m) => m[0]);
    assert.deepEqual(urls, [], `${f} references external resources`);
    assert.ok(!/fetch\(\s*["']https?:/.test(src), `${f} fetches a remote URL`);
  }
});

test('vendored pdf.js ships with its Apache-2.0 licence', () => {
  assert.match(readFileSync(`${root}vendor/pdfjs/LICENSE`, 'utf8'), /Apache License/);
});
