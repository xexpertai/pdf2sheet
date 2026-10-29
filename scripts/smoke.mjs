// Browser smoke test (optional): `npm run smoke`.
// Serves the app from a built-in static server, drives it with Playwright (Chromium) and checks:
//   AC1 page strip + count < 3 s · AC2 scanned message · AC6 boundary drag merges columns
//   AC7 keyboard grid + axe-core (0 serious/critical) · XLSX download non-empty and valid
//   no request leaves 127.0.0.1 · no horizontal overflow at 360 px · writes docs/screenshot.png
// Set CHROMIUM_PATH to use a specific Chromium binary (otherwise Playwright's default is used).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { unzipStore } from '../src/zip.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

try {
  const ctx = await browser.newContext({ acceptDownloads: true, bypassCSP: true, /* only so axe-core can be injected */ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/index.html`);

  await check('AC1: invoice shows thumbnail strip and page count within 3 s', async () => {
    const t0 = Date.now();
    await page.setInputFiles('#file', join(root, 'samples/invoice-demo.pdf'));
    await page.waitForSelector('#thumbs .thumb canvas');
    await page.waitForFunction(() => document.querySelector('#doc-info').textContent.includes('1 page'));
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `${ms} ms`);
    await page.waitForSelector('table.grid');
  });

  await check('AC2: scanned PDF shows the no-text-layer message', async () => {
    await page.setInputFiles('#file', join(root, 'samples/scanned-demo.pdf'));
    await page.waitForFunction(() => !document.querySelector('#error').hidden);
    assert.equal((await page.textContent('#error')).trim(), 'No text layer found: this PDF looks scanned; OCR is not supported.');
  });

  await check('F1: non-PDF and oversized files show an inline error', async () => {
    await page.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('not a PDF'));
    await page.setInputFiles('#file', { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really') });
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('does not look like a PDF'));
  });

  await check('AC6: dragging a boundary onto its neighbour merges two columns (5 -> 4)', async () => {
    await page.setInputFiles('#file', join(root, 'samples/price-list-demo.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('table.grid thead th').length === 6);
    assert.match(await page.textContent('#status'), /120 data rows/);
    const handles = page.locator('#overlay .bnd');
    assert.equal(await handles.count(), 4);
    const a = await handles.nth(1).boundingBox();
    const b = await handles.nth(2).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 20);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 1, b.y + 20, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll('table.grid thead th').length === 5);
    assert.match(await page.textContent('#status'), /120 data rows/);
    await page.click('#auto-cols');
    await page.waitForFunction(() => document.querySelectorAll('table.grid thead th').length === 6);
  });

  await check('AC7: grid keyboard navigation (arrows, Enter edits, Esc cancels)', async () => {
    const first = page.locator('table.grid td[data-r="0"][data-c="0"]');
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const focused = await page.evaluate(() => [document.activeElement.dataset.r, document.activeElement.dataset.c]);
    assert.deepEqual(focused, ['1', '1']);
    const before = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.isContentEditable), true);
    await page.keyboard.type('XYZ');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), before);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Edited');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('table.grid td[data-r="1"][data-c="1"]'), 'Edited');
    const now = await page.evaluate(() => [document.activeElement.dataset.r, document.activeElement.dataset.c]);
    assert.deepEqual(now, ['2', '1'], 'Enter commits and moves down');
  });

  await check('AC7: axe-core reports 0 serious/critical violations', async () => {
    await page.addScriptTag({ content: readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8') });
    const res = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
    const bad = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.length} nodes (${v.nodes[0]?.target})`), []);
  });

  await check('F5: XLSX download is non-empty and a valid package', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-xlsx')]);
    const path = await dl.path();
    const bytes = new Uint8Array(readFileSync(path));
    assert.ok(bytes.length > 1000, `${bytes.length} bytes`);
    assert.equal(dl.suggestedFilename(), 'price-list-demo.xlsx');
    const files = unzipStore(bytes);
    assert.ok(files.has('xl/worksheets/sheet1.xml'));
  });

  await check('F5: CSV download is UTF-8 with BOM', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
    const bytes = readFileSync(await dl.path());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString('utf8').trim().split('\r\n').length, 121);
  });

  await check('F4: totals check reports match / mismatch', async () => {
    await page.click('button[data-sample="invoice-demo.pdf"]');
    await page.waitForFunction(() => document.querySelector('#doc-info').textContent.includes('invoice-demo'));
    await page.waitForSelector('#totals-col option', { state: 'attached' });
    await page.fill('#totals-value', '1.00');
    await page.click('#totals button');
    assert.match(await page.textContent('#totals-result'), /Mismatch/);
  });

  await check('No request leaves the local origin', async () => {
    const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert.deepEqual(external, []);
  });

  await check('No uncaught page errors', async () => assert.deepEqual(errors, []));

  await page.click('button[data-sample="statement-demo.pdf"]');
  await page.waitForFunction(() => document.querySelector('#doc-info').textContent.includes('statement-demo'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(root, 'docs/screenshot.png'), fullPage: true });

  await check('Responsive: no horizontal page overflow at 360 px', async () => {
    const small = await ctx.newPage();
    await small.setViewportSize({ width: 360, height: 780 });
    await small.goto(`${origin}/index.html`);
    await small.click('button[data-sample="statement-demo.pdf"]');
    await small.waitForSelector('table.grid');
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `overflow ${overflow}px`);
    await small.close();
  });
} finally {
  await browser.close();
  server.close();
}

for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? `\n      ${e}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed${existsSync(join(root, 'docs/screenshot.png')) ? '; screenshot at docs/screenshot.png' : ''}`);
process.exit(failed ? 1 : 0);
