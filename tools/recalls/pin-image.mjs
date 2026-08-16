#!/usr/bin/env node
// StopHurting — compose a Pinterest pin image for a recall.
//
// WHY THIS EXISTS: Pinterest is a 2:3 vertical medium (1000x1500 is the reference size) and the
// CPSC product photos are whatever aspect the manufacturer shot them in — mostly wide. Pinning
// og:image directly gets a squat, cropped, unreadable card. So pins are COMPOSED: the product
// photo on a paper field up top, the facts in a navy band underneath.
//
// NO AI IN THE LOOP, same promise as build.mjs and fb-post.mjs. Every word on the pin comes from
// the stored CPSC card fields. Nothing is invented, nothing is embellished, and a missing field
// omits its line rather than being filled in.
//
// ⛔ The image is CONTAINED, never cropped to fill. A recall pin whose whole job is "do you own
// this thing?" must not slice the product in half to suit a layout.
//
// Usage:
//   node tools/recalls/pin-image.mjs                     # build pins for recalls missing one
//   node tools/recalls/pin-image.mjs --slug <slug>       # just this one
//   node tools/recalls/pin-image.mjs --force             # rebuild even if it exists
//
// Output: assets/img/pins/<slug>.jpg  (1000x1500, committed like the recall images)

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE_FILE = path.join(HERE, 'state.json');
const OUT_DIR = path.join(ROOT, 'assets', 'img', 'pins');

const W = 1000, H = 1500;
const NAVY = '#16334f', NAVY_DEEP = '#0f2438', ORANGE = '#e07b39', PAPER = '#f6f8fa', WHITE = '#ffffff';
// BAND_Y is computed per pin in buildPin() — it follows the photo, see the trap note there.

const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ONLY = argOf('--slug', null);
const FORCE = process.argv.includes('--force');

let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('❌ sharp is required: npm i sharp (in tools/recalls)'); process.exit(1); }

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Wrap on WIDTH, not character count — "DUMOS Nine-Drawer Dressers" and "Goody King Magnetic
// Building Cubes and Blocks" need very different break points at the same font size.
function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) { lines.push(cur); cur = w; } else cur = next;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[,;:]?$/, '') + '…';
  }
  return lines;
}

function overlay(rec, BAND_Y) {
  const prodLines = wrap(rec.prod, 26, 3);
  // build.mjs's hazardShort() always ends in "hazard"; the label supplies that word already.
  const hazard = String(rec.hazard || '').replace(/\s+hazards?$/i, '');
  const hazLines = wrap(hazard, 34, 2);
  const prodY = BAND_Y + 132;
  const hazY = prodY + prodLines.length * 62 + 54;

  // 🪤 The upper field is WHITE, not paper. CPSC product shots are almost all on white, and a
  // wide photo contained into a tall box pads with white — against a paper background that
  // padding reads as a misaligned box. White makes the photo and the field the same surface, so
  // the letterboxing is invisible whatever aspect the manufacturer shot in.
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${WHITE}"/>
  <rect x="0" y="${BAND_Y}" width="${W}" height="${H - BAND_Y}" fill="${NAVY}"/>
  <rect x="0" y="${BAND_Y}" width="${W}" height="8" fill="${ORANGE}"/>

  <rect x="60" y="${BAND_Y + 46}" width="168" height="46" rx="23" fill="${ORANGE}"/>
  <text x="144" y="${BAND_Y + 78}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="24" font-weight="700" letter-spacing="3" fill="${NAVY_DEEP}">RECALL</text>

  ${prodLines.map((l, i) => `<text x="60" y="${prodY + i * 62}" font-family="Segoe UI, Arial, sans-serif"
        font-size="54" font-weight="800" fill="${WHITE}">${esc(l)}</text>`).join('\n  ')}

  ${hazLines.map((l, i) => `<text x="60" y="${hazY + i * 42}" font-family="Segoe UI, Arial, sans-serif"
        font-size="32" font-weight="400" fill="#b9c7d6">${esc(l)}</text>`).join('\n  ')}

  <text x="60" y="${H - 52}" font-family="Segoe UI, Arial, sans-serif" font-size="28"
        font-weight="700" letter-spacing="1" fill="${ORANGE}">stophurting.org</text>
  <text x="${W - 60}" y="${H - 52}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif"
        font-size="24" fill="#8494a7">Official CPSC notice</text>
</svg>`);
}

async function buildPin(rec) {
  const src = path.join(ROOT, 'assets', 'img', 'recalls', rec.slug, '1.webp');
  if (!existsSync(src)) return { slug: rec.slug, skipped: 'no product image' };
  const out = path.join(OUT_DIR, `${rec.slug}.jpg`);
  if (existsSync(out) && !FORCE) return { slug: rec.slug, skipped: 'exists' };

  // CONTAIN on white — the product must never be cropped. A pin that slices the recalled item in
  // half fails at the one job it has.
  const FIELD_W = 900, PHOTO_TOP = 60;
  // 🪤 THE BAND FOLLOWS THE PHOTO. A fixed band leaves a pool of white under a wide product shot
  // (most CPSC photos are wide) and crushes a tall one. Measure the source, compute how tall it
  // will actually render at 900px wide, and put the band just below it — clamped so there is
  // always room for the text block and the pin never stops being 2:3.
  // 🪤 TRIM FIRST. CPSC product shots frequently ship with white padding baked into the file, so
  // the gap under the product is INSIDE the source image and no amount of layout maths closes it.
  // Trimming the uniform border makes the measurement honest before anything is positioned.
  // Falls back to the untrimmed image if trim throws (it does on a solid-colour image).
  let base;
  try { base = await sharp(src).trim({ threshold: 25 }).toBuffer(); }
  catch { base = await sharp(src).toBuffer(); }

  const meta = await sharp(base).metadata();
  const scaledH = Math.round(FIELD_W * (meta.height / meta.width));
  const bandY = Math.max(820, Math.min(1060, PHOTO_TOP + Math.min(scaledH, 880) + 70));

  const photo = await sharp(base)
    .resize({ width: FIELD_W, height: 880, fit: 'inside', background: WHITE, withoutEnlargement: false })
    .toBuffer();

  mkdirSync(OUT_DIR, { recursive: true });
  await sharp(overlay(rec, bandY), { density: 96 })
    .composite([{ input: photo, top: PHOTO_TOP, left: Math.round((W - FIELD_W) / 2) }])
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(out);
  return { slug: rec.slug, built: true };
}

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
let items = Object.values(state.seen);
if (ONLY) items = items.filter((r) => r.slug === ONLY);
if (!items.length) { console.error(`no recall matches ${ONLY ? `--slug ${ONLY}` : 'state'}`); process.exit(1); }
items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

let built = 0, skipped = 0;
for (const rec of items) {
  const r = await buildPin(rec);
  if (r.built) { built++; console.log(`  + ${r.slug}.jpg`); }
  else { skipped++; if (ONLY) console.log(`  - ${r.slug}: ${r.skipped}`); }
}
const have = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.jpg')).length : 0;
console.log(`\nbuilt ${built} · skipped ${skipped} · ${have} pin image(s) on disk`);
