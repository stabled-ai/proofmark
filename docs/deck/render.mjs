/**
 * Deck renderer. HTML to one PNG per slide plus a PDF.
 *
 * Kept in the repository so the HTML and the rendered files cannot drift. A submission where the
 * source and the distributed PDF disagree is worse than having no PDF.
 *
 * Uses the system Chrome (`channel: 'chrome'`), so no chromium download is needed.
 *
 * Usage: node docs/deck/render.mjs [--only 6,11]
 *   --only rewrites just those PNGs and leaves the rest alone. Re-rendering every slide when one
 *   changed makes it impossible to see what moved. The PDF is one file, so it always rewrites.
 */
import { chromium } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, 'deck.html');
const SLIDES = join(HERE, 'slides');
const PDF = join(HERE, 'proofmark-deck.pdf');

const WIDTH = 1280;
const HEIGHT = 720;

const onlyArg = process.argv.indexOf('--only');
const onlyList = onlyArg > -1 ? process.argv[onlyArg + 1].split(',').map(n => Number(n.trim())) : null;

if (!existsSync(HTML)) {
  process.stderr.write(`missing source: ${HTML}\n`);
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`file://${resolve(HTML)}`, { waitUntil: 'networkidle' });
// Screenshotting before the webfonts land changes every glyph width.
await page.evaluate(() => document.fonts.ready);
// The slide count comes from the document, so adding or cutting a slide never needs a code change.
const COUNT = await page.evaluate(() => document.querySelectorAll('section.slide').length);
const only = onlyList ? new Set(onlyList.filter(n => n >= 1 && n <= COUNT)) : null;
// Stale PNGs from a longer previous deck would otherwise sit next to the new ones.
for (const f of readdirSync(SLIDES)) { if (/^\d{2}\.png$/.test(f) && Number(f.slice(0, 2)) > COUNT) unlinkSync(join(SLIDES, f)); }

let written = 0;
for (let i = 1; i <= COUNT; i++) {
  if (only && !only.has(i)) continue;
  const el = await page.$(`#s${i}`);
  if (!el) { process.stderr.write(`  #s${i} not found, skipped\n`); continue; }
  const out = join(SLIDES, `${String(i).padStart(2, '0')}.png`);
  await el.screenshot({ path: out });
  process.stdout.write(`  ${String(i).padStart(2, '0')}.png\n`);
  written++;
}

await page.pdf({ path: PDF, width: `${WIDTH}px`, height: `${HEIGHT}px`,
                 printBackground: true, pageRanges: `1-${COUNT}` });

await browser.close();
process.stdout.write(`\n${written} PNG${only ? ` (--only ${[...only].join(',')})` : ''}, 1 PDF\n`);
if (errors.length) process.stdout.write(`console errors: ${errors.slice(0, 5).join(' | ')}\n`);
else process.stdout.write('console errors: none\n');
