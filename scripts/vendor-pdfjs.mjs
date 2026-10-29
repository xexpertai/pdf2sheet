// Copy the browser build of pdfjs-dist from node_modules into vendor/pdfjs/.
// Run after `npm install` when upgrading pdf.js: `npm run vendor`.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const out = join(root, 'vendor', 'pdfjs');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The legacy build bundles core-js polyfills, so it works in all current browsers (incl. Safari).
for (const f of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs']) cpSync(join(pkgDir, f), join(out, f.split('/').pop()));
for (const d of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) cpSync(join(pkgDir, d), join(out, d), { recursive: true });
cpSync(join(pkgDir, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(join(out, 'VERSION'), `pdfjs-dist ${version} (Apache-2.0, https://github.com/mozilla/pdf.js)\n`);
console.log(`Vendored pdfjs-dist ${version} into vendor/pdfjs`);
