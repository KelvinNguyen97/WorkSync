// Makes every icon file from the chosen concept. Run after changing the icon:
//   node build/icon/make-icons.mjs [a|b|c]
// Writes build/icon/icon.{png,ico,icns} for the packages and installers, and
// src/main/iconData.ts (window and tray icons) and src/shared/iconSvg.ts (the
// title bar) for the app itself.
// Needs Playwright's Chromium to draw the SVG; the outputs are committed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { concepts, trayGlyph } from './concepts.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pick = process.argv[2] ?? 'a';
const dir = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(dir, '../..');

const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  return page.screenshot({ omitBackground: true, type: 'png' });
}

const icon = concepts[pick];
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const out = {};
for (const s of sizes) out[s] = await png(icon, s);

// Windows .ico: PNG entries, 16 to 256.
function ico(list) {
  const head = Buffer.alloc(6 + 16 * list.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(list.length, 4);
  let offset = head.length;
  list.forEach(([s, data], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...list.map(([, d]) => d)]);
}
// macOS .icns: PNG entries.
function icns(list) {
  const parts = list.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

fs.writeFileSync(path.join(dir, 'icon.png'), out[512]);
fs.writeFileSync(
  path.join(dir, 'icon.ico'),
  ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, out[s]])),
);
fs.writeFileSync(
  path.join(dir, 'icon.icns'),
  icns([
    ['icp4', out[16]],
    ['icp5', out[32]],
    ['icp6', out[64]],
    ['ic07', out[128]],
    ['ic08', out[256]],
    ['ic09', out[512]],
    ['ic10', out[1024]],
    ['ic11', out[32]],
    ['ic12', out[64]],
    ['ic13', out[256]],
    ['ic14', out[512]],
  ]),
);

// Tray: the full icon on Windows and Linux; a black template glyph on macOS,
// which the menu bar recolors for light and dark.
const tray = { 1: out[16], 2: out[32] };
const tmpl = {
  1: await png(trayGlyph('#000'), 16),
  2: await png(trayGlyph('#000'), 32),
};
const b64 = (b) => b.toString('base64');
fs.writeFileSync(
  path.join(root, 'src/main/iconData.ts'),
  `// Made by build/icon/make-icons.mjs (concept ${pick}); do not edit by hand.\n` +
    `/** The window icon, 256px PNG. */\nexport const WINDOW_ICON = '${b64(out[256])}';\n` +
    `/** Tray icon, PNG at 1x (16px) and 2x (32px). */\nexport const TRAY_ICON = ['${b64(tray[1])}', '${b64(tray[2])}'];\n` +
    `/** macOS menu bar template icon, PNG at 1x and 2x. */\nexport const TRAY_TEMPLATE = ['${b64(tmpl[1])}', '${b64(tmpl[2])}'];\n`,
);
fs.writeFileSync(
  path.join(root, 'src/shared/iconSvg.ts'),
  `// Made by build/icon/make-icons.mjs (concept ${pick}); do not edit by hand.\n` +
    `/** The app icon as SVG, for the page. */\nexport const ICON_SVG =\n  ${JSON.stringify(icon.replace(/\s+/g, ' '))};\n`,
);
await browser.close();
// Keep the written code in the project's format.
execFileSync('npx', ['oxfmt', 'src/main/iconData.ts', 'src/shared/iconSvg.ts'], { cwd: root });
console.log('Icons written for concept', pick);
