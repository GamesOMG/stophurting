// StopHurting recall generator — CPSC SaferProducts feed → answer-first static pages.
//
// The whole site's promise in one pipeline: official data, fast, readable, linked to the
// source. NO AI in the loop — every field on a page comes from the CPSC record itself.
//
// Usage:
//   node tools/recalls/build.mjs                  # fetch + report what's new (dry)
//   node tools/recalls/build.mjs --write          # emit pages/hub/home/sitemap locally
//   node tools/recalls/build.mjs --commit         # --write + git commit/push + IndexNow ping
//   node tools/recalls/build.mjs --since 2026-06-01   # widen the fetch window (backfill)
//
// State: tools/recalls/state.json  (seen RecallIDs + per-recall card data; the hub and
// homepage strip are REBUILT from state every run, so they can never drift from the pages.)
// Images: first CPSC image per recall, mirrored + resized to 900px webp via sharp when
// available, raw copy otherwise. CPSC is a US federal agency; its images are public domain.
// ⚠ The homepage strip is injected between RECALLS:START/END markers — idempotent, never
// touches the hand-written article cards.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE_FILE = path.join(HERE, 'state.json');
const ORIGIN = 'https://stophurting.org';
const WRITE = process.argv.includes('--write') || process.argv.includes('--commit');
const COMMIT = process.argv.includes('--commit');
const sinceIdx = process.argv.indexOf('--since');
const DEFAULT_WINDOW_DAYS = 45; // rolling fetch window for the cron; --since overrides

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { seen: {}, indexnowKey: '' };

// ---------- helpers ----------
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const slugify = (s) => String(s).toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .split('-').slice(0, 8).join('-');
const isoDay = (s) => String(s || '').slice(0, 10);
const monthYear = (s) => new Date(isoDay(s) + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const clamp = (s, n) => { s = String(s ?? '').trim(); return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'; };

// Product part of a CPSC title. Handles both forms — "Product Recalled Due to X" and
// "Company Recalls Product Due to X" — and prepends the brand when the product alone is
// one generic word ("Mattresses"), because brand+product is the query people type.
function productName(rec) {
  let t = String(rec.Title).split(/\s+(?:Due to|Because)\b/i)[0].split(/;|—/)[0];
  t = t.replace(/\s+Recall(?:s|ed)?\b/i, ' ').replace(/\s+/g, ' ').trim();
  if (t.split(' ').length <= 1) {
    const brand = (rec.Manufacturers?.[0]?.Name || rec.Importers?.[0]?.Name || '').split(',')[0].trim();
    if (brand && !t.toLowerCase().includes(brand.toLowerCase())) t = `${brand} ${t}`.trim();
  }
  return t;
}
// Short hazard phrase: CPSC titles carry "Due to X Hazard(s)"; fall back to the Hazards field.
function hazardShort(rec) {
  const m = String(rec.Title).match(/Due to (?:Serious )?(?:Risk of )?(.*?)(?:;|$)/i);
  if (m) return m[1].replace(/\s*Hazards?\s*$/i, ' hazard').trim();
  const h = rec.Hazards?.[0]?.Name || '';
  return clamp(h, 80) || 'safety hazard';
}
function soldAt(rec) {
  const r = (rec.Retailers || []).map((x) => x.Name).filter(Boolean).join(' · ');
  return r || rec.SoldAtLabel || '';
}
function unitCount(rec) {
  return (rec.Products || []).map((p) => p.NumberOfUnits).filter(Boolean).join(' + ') || '';
}
function remedyText(rec) {
  const kinds = (rec.Remedies || []).map((r) => r.Name).filter(Boolean).join(' / ');
  const opts = (rec.RemedyOptions || []).map((r) => r.Name).filter(Boolean).join(' / ');
  return opts || kinds || '';
}

// ---------- image mirror ----------
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* raw copy fallback */ }
async function mirrorImage(rec, slug) {
  const src = rec.Images?.[0]?.URL;
  if (!src) return null;
  const dir = path.join(ROOT, 'assets', 'img', 'recalls', slug);
  const rel = `/assets/img/recalls/${slug}/1.webp`;
  const relRaw = `/assets/img/recalls/${slug}/1${path.extname(new URL(src).pathname) || '.png'}`;
  for (const r of [rel, relRaw]) {
    const onDisk = path.join(ROOT, r.slice(1).split('/').join(path.sep));
    if (existsSync(onDisk)) return { rel: r, caption: rec.Images[0].Caption || '' };
  }
  try {
    const res = await fetch(src, { headers: { 'user-agent': 'stophurting-recalls/1.0' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dir, { recursive: true });
    if (sharp) {
      await sharp(buf).resize({ width: 900, withoutEnlargement: true }).webp({ quality: 82 })
        .toFile(path.join(ROOT, rel.slice(1).split('/').join(path.sep)));
      return { rel, caption: rec.Images[0].Caption || '' };
    }
    writeFileSync(path.join(ROOT, relRaw.slice(1).split('/').join(path.sep)), buf);
    return { rel: relRaw, caption: rec.Images[0].Caption || '' };
  } catch { return null; }
}

// ---------- page template ----------
function recallPage(rec, slug, img) {
  const prod = productName(rec);
  const hz = hazardShort(rec);
  const date = isoDay(rec.RecallDate);
  const units = unitCount(rec);
  const remedy = remedyText(rec);
  const sold = soldAt(rec);
  // ≤60 chars total, and the word "Recall" is the query — it must never be the part that
  // truncates. No brand suffix: at DR 0 the brand buys nothing and costs 14 chars.
  const shortMY = new Date(isoDay(rec.RecallDate) + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const title = `${clamp(prod, 42)} Recall (${shortMY})`;
  const desc = clamp(`${prod} recalled${units ? ` (about ${units} units)` : ''}: ${hz}. What was sold, what to do, and how to get the ${remedy ? remedy.toLowerCase() : 'remedy'} — from the official CPSC notice.`, 158);
  const rows = [
    ['What', prod],
    units && ['How many', `About ${units} units`],
    ['The hazard', rec.Hazards?.[0]?.Name || hz],
    sold && ['Sold at', sold],
    remedy && ['Remedy', remedy],
    rec.ConsumerContact && ['Contact', rec.ConsumerContact],
    ['Recall date', date + ` (recall no. ${rec.RecallNumber})`],
  ].filter(Boolean);
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: `${prod} Recall (${monthYear(rec.RecallDate)})`,
    description: desc,
    author: { '@type': 'Organization', name: 'StopHurting', url: ORIGIN },
    publisher: { '@type': 'Organization', name: 'StopHurting', url: ORIGIN },
    mainEntityOfPage: `${ORIGIN}/recalls/${slug}/`,
    datePublished: date, dateModified: isoDay(rec.LastPublishDate) || date,
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${ORIGIN}/recalls/${slug}/" />
  <meta property="og:title" content="${esc(`${prod} Recall (${monthYear(rec.RecallDate)})`)}" />
  <meta property="og:description" content="${esc(desc)}" />
${img ? `  <meta property="og:image" content="${ORIGIN}${esc(img.rel)}" />\n` : ''}  <meta property="og:type" content="article" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
  ${HEADER}
  <main>
    <article class="article-wrap">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/recalls/">Recalls</a></div>
      <header class="article-header">
        <span class="chip chip-recall">Recall</span>
        <h1>${esc(prod)} Recall (${esc(monthYear(rec.RecallDate))})</h1>
        <p class="dek">${esc(clamp(hz.charAt(0).toUpperCase() + hz.slice(1), 160))}${units ? ` — about ${esc(units)} units.` : '.'}</p>
      </header>
      <table class="recall-facts">
        <tbody>
${rows.map(([k, v]) => `          <tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}
        </tbody>
      </table>
${img ? `      <figure class="recall-img"><img src="${esc(img.rel)}" alt="${esc(img.caption || prod + ' — recalled product')}" loading="lazy" />${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}</figure>\n` : ''}      <div class="prose">
        <h2>What was recalled</h2>
        <p>${esc(rec.Description)}</p>
${remedy ? `        <h2>What to do</h2>\n        <p>Stop using the product. The listed remedy is: <strong>${esc(remedy)}</strong>. ${esc(rec.ConsumerContact || '')}</p>\n` : ''}        <p class="recall-source">Source: <a href="${esc(rec.URL)}" target="_blank" rel="noopener">the official CPSC recall notice</a>, published ${esc(date)}. Every fact on this page comes from that notice — if anything here disagrees with it, the notice wins.</p>
      </div>
    </article>
  </main>
  ${FOOTER}
</body>
</html>
`;
}

// ---------- hub + homepage + sitemap ----------
const SEAL = `<svg viewBox="0 0 24 26" aria-hidden="true"><path d="M12 1l10 4v7c0 6.5-4.3 11.3-10 13C6.3 23.3 2 18.5 2 12V5l10-4z" fill="#e07b39"/><path d="M7.5 12.5l3 3 6-6" stroke="#16334f" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const HEADER = `<header class="site-header"><div class="wrap header-inner"><a class="brand" href="/"><span class="brand-mark">${SEAL}</span><span class="brand-name">Stop<span class="brand-accent">Hurting</span></span></a><nav class="nav"><a href="/recalls/">Recalls</a><a href="/myths/">Myth Checks</a><a href="/about/">About</a></nav></div></header>`;
const FOOTER = `<footer class="site-footer"><div class="wrap">© StopHurting — recall data from the U.S. Consumer Product Safety Commission (public domain). Not legal or medical advice.</div></footer>`;
const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 26'><path d='M12 1l10 4v7c0 6.5-4.3 11.3-10 13C6.3 23.3 2 18.5 2 12V5l10-4z' fill='%23e07b39'/><path d='M7.5 12.5l3 3 6-6' stroke='%2316334f' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" />`;

function row(r) {
  return `        <li><a class="r-row" href="/recalls/${r.slug}/"><span class="r-date">${esc(r.date)}</span><span class="r-prod">${esc(r.prod)}</span><span class="r-hazard">${esc(clamp(r.hazard, 90))}</span></a></li>`;
}
function ticker(items) {
  const five = items.slice(0, 5)
    .map((r) => `<a href="/recalls/${r.slug}/">${esc(r.prod)} — ${esc(clamp(r.hazard, 60))}</a>`)
    .join('<span class="ticker-sep">•</span>');
  return `<div class="ticker" aria-label="Latest recalls"><span class="ticker-label">LATEST</span><div class="ticker-clip"><div class="ticker-track">${five}<span class="ticker-sep">•</span>${five}</div></div></div>`;
}
function hubPage(items) {
  const rows = items.map(row).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Product Recalls, Tracked Daily — StopHurting</title>
  <meta name="description" content="Every U.S. consumer product recall, posted as it drops — what was recalled, the hazard, and what to do, straight from the official CPSC notices. ${items.length} tracked." />
  <link rel="canonical" href="${ORIGIN}/recalls/" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  ${ticker(items)}
  <main>
    <section class="wrap section">
      <h1 class="section-title">Product recalls, tracked daily</h1>
      <p class="section-sub">Straight from the official CPSC notices — what was recalled, why it's dangerous, and what to do about it. Newest first, updated automatically. ${items.length} tracked since June 2026.</p>
      <div class="search-box" style="margin:0 0 1.2rem"><input id="q" type="search" placeholder="Search a brand, product, or model number…" autocomplete="off" style="border:1px solid var(--light)" /></div>
      <ul class="r-list" id="hub-list">
${rows}
      </ul>
    </section>
  </main>
  ${FOOTER}
  <script>
  (function () {
    var q = document.getElementById('q'); var host = document.getElementById('hub-list');
    if (!q || !host) return;
    var idx = null, original = host.innerHTML;
    function load() { if (!idx) fetch('/recalls-index.json').then(function (r) { return r.json(); }).then(function (j) { idx = j; }); }
    q.addEventListener('focus', load, { once: true });
    q.addEventListener('input', function () {
      var t = q.value.trim().toLowerCase();
      if (!t) { host.innerHTML = original; return; }
      if (!idx) { load(); return; }
      var hits = idx.filter(function (r) { return r.t.indexOf(t) > -1; }).slice(0, 40);
      host.innerHTML = hits.length
        ? hits.map(function (r) { return '<li><a class="r-row" href="/recalls/' + r.slug + '/"><span class="r-date">' + r.date + '</span><span class="r-prod">' + r.prod + '</span><span class="r-hazard">' + r.hazard + '</span></a></li>'; }).join('')
        : '<li class="r-empty">No tracked recall matches that — we cover CPSC recalls from June 2026 onward.</li>';
    });
  })();
  </script>
</body>
</html>
`;
}
function injectHome(items) {
  const home = path.join(ROOT, 'index.html');
  let html = readFileSync(home, 'utf8');
  const strip = `<!-- RECALLS:START (generated by tools/recalls/build.mjs — do not hand-edit this block) -->
      <ul class="r-list">
${items.slice(0, 20).map(row).join('\n')}
      </ul>
      <!-- RECALLS:END -->`;
  html = html.replace(/<!-- RECALLS:START[\s\S]*?<!-- RECALLS:END -->/, strip);
  const tick = `<!-- TICKER:START -->\n  ${ticker(items)}\n  <!-- TICKER:END -->`;
  html = html.replace(/<!-- TICKER:START -->[\s\S]*?<!-- TICKER:END -->/, tick);
  writeFileSync(home, html);
}
function writeSearchIndex(items) {
  const idx = items.map((r) => ({
    slug: r.slug, date: r.date, prod: r.prod, hazard: clamp(r.hazard, 90),
    t: `${r.prod} ${r.hazard} ${r.models || ''} ${r.num}`.toLowerCase(),
  }));
  writeFileSync(path.join(ROOT, 'recalls-index.json'), JSON.stringify(idx));
}
function sitemap(items) {
  const staticPages = ['', 'about/', 'recalls/',
    ...execSync('git ls-files', { cwd: ROOT }).toString().split('\n')
      .filter((f) => /^[a-z0-9-]+\/index\.html$/.test(f) && !f.startsWith('recalls'))
      .map((f) => f.replace('index.html', ''))];
  const urls = [
    ...staticPages.map((p) => `  <url><loc>${ORIGIN}/${p}</loc></url>`),
    ...items.map((r) => `  <url><loc>${ORIGIN}/recalls/${r.slug}/</loc><lastmod>${r.modified || r.date}</lastmod></url>`),
  ];
  writeFileSync(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  if (!existsSync(path.join(ROOT, 'robots.txt'))) {
    writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  }
}

// ---------- IndexNow ----------
async function indexNow(newUrls) {
  if (!newUrls.length) return 'no new urls';
  if (!state.indexnowKey) {
    state.indexnowKey = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    writeFileSync(path.join(ROOT, `${state.indexnowKey}.txt`), state.indexnowKey);
  }
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: 'stophurting.org', key: state.indexnowKey, urlList: newUrls }),
    });
    return `indexnow ${res.status}`;
  } catch (e) { return `indexnow failed: ${e.message}`; }
}

// ---------- main ----------
const REBUILD = process.argv.includes('--rebuild');
const earliestSeen = Object.values(state.seen).map((r) => r.date).sort()[0];
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1]
  : REBUILD && earliestSeen ? earliestSeen
  : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
const res = await fetch(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${since}`);
if (!res.ok) { console.error(`CPSC feed HTTP ${res.status} — aborting, state untouched.`); process.exit(1); }
const feed = await res.json();
const fresh = REBUILD ? feed : feed.filter((r) => !state.seen[r.RecallID]);
console.log(`feed: ${feed.length} recalls since ${since} · ${REBUILD ? 'REBUILD all' : 'new'}: ${fresh.length}`);
if (!fresh.length && !WRITE) process.exit(0);

const newUrls = [];
for (const rec of fresh) {
  const slug = `${slugify(productName(rec))}-recall-${rec.RecallNumber}`;
  if (!WRITE) { console.log(`  would add: ${slug}`); continue; }
  const img = await mirrorImage(rec, slug);
  const dir = path.join(ROOT, 'recalls', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), recallPage(rec, slug, img));
  const models = [
    ...(rec.Products || []).map((p) => p.Model).filter(Boolean),
    ...(rec.ProductUPCs || []).map((u) => (typeof u === 'string' ? u : u?.UPC)).filter(Boolean),
  ].join(' ');
  const wasSeen = !!state.seen[rec.RecallID];
  state.seen[rec.RecallID] = {
    slug, prod: productName(rec), hazard: hazardShort(rec),
    date: isoDay(rec.RecallDate), modified: isoDay(rec.LastPublishDate), num: rec.RecallNumber,
    models,
  };
  if (!wasSeen) newUrls.push(`${ORIGIN}/recalls/${slug}/`);
  console.log(`  + ${slug}`);
}

if (WRITE) {
  const items = Object.values(state.seen).sort((a, b) => b.date.localeCompare(a.date));
  mkdirSync(path.join(ROOT, 'recalls'), { recursive: true });
  writeFileSync(path.join(ROOT, 'recalls', 'index.html'), hubPage(items));
  injectHome(items);
  writeSearchIndex(items);
  sitemap(items);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`hub: ${items.length} recalls · home strip + ticker + search index + sitemap rebuilt`);
}

if (COMMIT && newUrls.length) {
  execSync('git add -A', { cwd: ROOT });
  execSync(`git commit -m "recalls: ${newUrls.length} new (auto)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`, { cwd: ROOT });
  execSync('git push', { cwd: ROOT });
  console.log(await indexNow(newUrls));
  console.log(`pushed ${newUrls.length} new recall page(s)`);
} else if (COMMIT) {
  console.log('nothing new — no commit');
}
