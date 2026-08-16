// A branded share card for recalls whose regulator publishes no product photograph.
//
// ⭐ WHY THIS EXISTS. Jason, comparing two live Facebook posts: "the uk card looks weak, the us
// one looks nice." He was right — a US post shows the actual recalled product, and a UK post
// showed nothing, because OPSS publishes its photographs only inside PDF attachments. A link
// card with no image is a grey rectangle next to a headline, and it is competing in a feed.
//
// ⛔ THIS IS NOT A FAKE PRODUCT PHOTO. It never depicts the item, and it must not be mistaken for
// one: it is typography on the site's own colours, saying what was recalled, the hazard, and where
// the recall applies. Drawing a stand-in product would be inventing evidence, which is the one
// thing this site does not do.
//
// The card is used as the og:image ONLY — the share card, at Facebook's 1200×630. The hub keeps
// its typographic tile, which already reads correctly at thumbnail size; a 1.91:1 banner letterboxed
// into a 172px card slot would look worse than what is there now.

import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const CARD_W = 1200;
export const CARD_H = 630;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Greedy wrap on an estimated advance width. ⚠ Estimated, not measured: librsvg gives us no text
// metrics, so the factor is deliberately generous — a line that wraps one word early looks fine,
// a line that overflows the canvas is broken. Verified against the longest product name in the
// corpus rather than a guess.
function wrap(text, fontSize, maxWidth, maxLines) {
  const perChar = fontSize * 0.55;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length * perChar > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  // If it did not all fit, ellipsise the last line rather than dropping words silently.
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length && lines.length) {
    const last = lines[lines.length - 1];
    const room = Math.floor(maxWidth / perChar) - 1;
    lines[lines.length - 1] = (last.length > room ? last.slice(0, room) : last).trimEnd() + '…';
  }
  return lines;
}

const WHERE = { us: 'UNITED STATES', au: 'AUSTRALIA', ca: 'CANADA', uk: 'UNITED KINGDOM' };

export function cardSvg(rec) {
  const country = (rec.country || 'us').toUpperCase();
  const where = WHERE[rec.country || 'us'] || country;
  const prodSize = rec.prod.length > 60 ? 52 : rec.prod.length > 34 ? 62 : 72;
  const prodLines = wrap(rec.prod, prodSize, 1040, 3);
  const hazardLines = wrap(rec.hazard || '', 34, 1040, 2);
  // 🪤 A FIXED TOP THAT GROWS DOWNWARD, not a vertically-centred block. The first version centred
  // the product name on a fixed midpoint, which pushed a two-line name UP through the "PRODUCT
  // RECALL" label above it — the label was still there, just underneath the product. Caught by
  // rendering one and looking at it, which no dimension check would have done.
  // Worst case is 3 lines at 52px: last baseline 262 + 2×61 = 384, descender clear of the 422 rule.
  const prodY = 262;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#16334f"/><stop offset="100%" stop-color="#0f2438"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect width="${CARD_W}" height="10" fill="#e07b39"/>

  <!-- the shield from the site's own favicon, so the card is recognisably ours -->
  <g transform="translate(80,64) scale(1.9)">
    <path d="M12 1l10 4v7c0 6.5-4.3 11.3-10 13C6.3 23.3 2 18.5 2 12V5l10-4z" fill="#e07b39"/>
    <path d="M7.5 12.5l3 3 6-6" stroke="#16334f" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="140" y="105" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff">Stop<tspan fill="#e07b39">Hurting</tspan></text>

  <!-- country chip: the single most important thing after the product, because a recall is only
       actionable where it was issued -->
  <rect x="${CARD_W - 80 - (where.length * 15 + 44)}" y="72" rx="20" ry="20" width="${where.length * 15 + 44}" height="42" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.28)"/>
  <text x="${CARD_W - 80 - 22}" y="101" text-anchor="end" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="800" letter-spacing="2" fill="#c8d4e0">${esc(where)}</text>

  <text x="80" y="182" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" font-weight="800" letter-spacing="4" fill="#e07b39">PRODUCT RECALL</text>

${prodLines.map((l, i) => `  <text x="80" y="${prodY + i * (prodSize * 1.18)}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${prodSize}" font-weight="800" fill="#ffffff">${esc(l)}</text>`).join('\n')}

  <rect x="80" y="${CARD_H - 208}" width="86" height="5" fill="#e07b39"/>
${hazardLines.map((l, i) => `  <text x="80" y="${CARD_H - 160 + i * 44}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="34" font-weight="600" fill="#c8d4e0">${esc(l)}</text>`).join('\n')}

  <text x="80" y="${CARD_H - 48}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#8fa2b5">stophurting.org${rec.cat ? `  ·  ${esc(rec.cat)}` : ''}</text>
</svg>`;
}

// Renders to webp beside the mirrored photos. Returns the site-relative path, or null if sharp is
// unavailable — an imageless card is the existing behaviour, so a missing dependency degrades
// rather than breaks.
export async function renderCard(sharp, rec, root) {
  if (!sharp) return null;
  const rel = `/assets/img/recalls/${rec.slug}/card.webp`;
  const abs = path.join(root, rel.slice(1).split('/').join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  await sharp(Buffer.from(cardSvg(rec))).webp({ quality: 88 }).toFile(abs);
  return rel;
}
