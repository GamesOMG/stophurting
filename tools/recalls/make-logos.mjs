#!/usr/bin/env node
// StopHurting — render the brand mark to PNG files.
//
// WHY THIS EXISTS: the mark only ever existed as inline SVG paths pasted into every page's
// HTML. There was no image file anywhere in the repo, so every time something external wanted a
// logo — the Facebook page avatar, the Pinterest app icon — it had to be redrawn by hand, and
// two hand-drawings are never quite the same mark. This makes the SVG the single source and the
// PNGs a build artefact of it.
//
// 🪤 Lives in tools/recalls/ rather than a tidier tools/brand/ purely because `sharp` is
// installed here. A separate folder would mean a second ~100MB dependency tree to render four
// PNGs, which is a worse trade than a slightly odd filename.
//
// ⛔ THE PATHS BELOW ARE THE SOURCE OF TRUTH and are duplicated in build.mjs's SEAL/FAVICON
// constants. If the mark ever changes, change it in both or the site and its icons drift.
//
// Usage: node tools/recalls/make-logos.mjs
// Output: assets/img/brand/*.png  (committed — these are what external platforms consume)

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'assets', 'img', 'brand');

let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('❌ sharp is required — run npm i inside tools/recalls'); process.exit(1); }

const SHIELD = 'M12 1l10 4v7c0 6.5-4.3 11.3-10 13C6.3 23.3 2 18.5 2 12V5l10-4z';
const CHECK = 'M7.5 12.5l3 3 6-6';
const NAVY_DEEP = '#0f2438', NAVY = '#16334f', ORANGE = '#e07b39', WHITE = '#ffffff';

// The seal is drawn on a 24x26 viewBox. Pad it into a square canvas so the circular masks that
// Pinterest and Facebook apply to avatars cannot clip the shield's shoulders.
function svg({ bg, shieldFill, checkStroke, size }) {
  const s = size, pad = s * 0.16, inner = s - pad * 2, scale = inner / 26;
  const w = 24 * scale, x = (s - w) / 2, y = pad;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  ${bg ? `<rect width="${s}" height="${s}" fill="${bg}"/>` : ''}
  <g transform="translate(${x} ${y}) scale(${scale})">
    <path d="${SHIELD}" fill="${shieldFill}"/>
    <path d="${CHECK}" stroke="${checkStroke}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`);
}

// 🪤 The check is WHITE on the dark variants, not the site's navy. Navy-on-navy vanishes at the
// 32px an app icon is actually rendered at — the one job the file has.
const JOBS = [
  ['icon-navy-512.png', { bg: NAVY_DEEP, shieldFill: ORANGE, checkStroke: WHITE, size: 512 }],
  ['icon-navy-1024.png', { bg: NAVY_DEEP, shieldFill: ORANGE, checkStroke: WHITE, size: 1024 }],
  ['icon-white-512.png', { bg: WHITE, shieldFill: ORANGE, checkStroke: NAVY, size: 512 }],
  ['icon-orange-512.png', { bg: ORANGE, shieldFill: NAVY, checkStroke: WHITE, size: 512 }],
  ['mark-transparent-1024.png', { bg: null, shieldFill: ORANGE, checkStroke: NAVY, size: 1024 }],
];

mkdirSync(OUT, { recursive: true });
for (const [name, opt] of JOBS) {
  await sharp(svg(opt), { density: 384 }).png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
  console.log(`  + assets/img/brand/${name}`);
}
console.log(`\n${JOBS.length} files written. icon-navy is the one to hand to Pinterest and Facebook.`);
