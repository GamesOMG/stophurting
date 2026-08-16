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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, COUNTRIES, sourceFor, isoDay, clamp } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE_FILE = path.join(HERE, 'state.json');
const ORIGIN = 'https://stophurting.org';
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

// ---------- country ----------
// ⭐ Pages live under /<cc>/recalls/. Moved while there were only 134 of them: the same change at
// 5,000 pages is a project.
// ⛔ /assets/img/recalls/<slug>/ is an ASSET path and deliberately does NOT move — it is not a
// page URL, and rewriting it would orphan 134 mirrored photos for no reader benefit.
// The old /recalls/... URLs 301 to /us/recalls/... via _redirects, so the published Facebook
// link and anything already indexed keep working.
//
// ⭐⭐ THE DEFAULT IS EVERY COUNTRY, and that is the whole point of the Australian adapter.
// The ACCC publishes a rolling 25 items with NO archive: a recall that scrolls off before we
// poll is gone permanently, from them and from us. A default of "us" would have meant the 4-hourly
// scheduled task kept polling only the US until somebody remembered to edit the task — which is
// the same shape as a check that is in no gate. `--country us` still exists for a targeted run.
const COUNTRY_ARG = argOf('--country', 'all');
const TARGETS = COUNTRY_ARG === 'all' ? COUNTRIES : COUNTRY_ARG.split(',').map((s) => s.trim());
for (const t of TARGETS) sourceFor(t);   // fail loudly on a typo, before any fetching
// The country a record belongs to. Records written before Australia existed have no `country`
// field, so US is the migration default — no state rewrite needed.
const cc = (r) => (r && r.country) || 'us';
const recallPath = (r) => `/${cc(r)}/recalls/${r.slug}/`;
const hubPath = (c) => `/${c}/recalls/`;
// ⚠ The nav is rewritten onto EVERY html file in the repo by syncFooters(). It therefore cannot
// depend on which country this run happens to be building, or a `--country au` run would silently
// repoint all 182 pages at the Australian hub. It has to be one constant for the whole site.
//
// ⭐ Which is why it points at the HOMEPAGE and not at a country hub. It used to be /us/recalls/,
// which stranded readers: someone on an Australian recall page clicking "Recalls" landed in the
// United States, and the nav being a constant meant no per-page fix was possible. The homepage is
// the right target on its own merits now — it is the recall index, carrying the search box, the
// newest from every country and the switcher, so "Recalls" lands you where you choose a country
// rather than inside one of them.
// ⛔ Do not "fix" this by serving a page at /recalls/: `/recalls/*` in _redirects matches the bare
// path too, so the 301 protecting the published Facebook post and everything submitted to
// IndexNow would have to be unpicked to make room for it. Not worth it for a nav link.
const NAV_HUB = '/';
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
const monthYear = (s) => new Date(isoDay(s) + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ⭐ Every per-regulator detail — how a product name is derived, what a hazard phrase is, which
// fact rows a notice carries, whether the feed returns a complete window — now lives in
// sources.mjs, one adapter per country. This file renders CANONICAL records and knows nothing
// about CPSC or the ACCC. That split is what makes the third country a config value instead of
// another pass of surgery through the templates.

// ---------- image mirror ----------
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* raw copy fallback */ }
async function mirrorImage(rec, slug) {
  const src = rec.image?.src;
  if (!src) return null;
  const dir = path.join(ROOT, 'assets', 'img', 'recalls', slug);
  const rel = `/assets/img/recalls/${slug}/1.webp`;
  const relRaw = `/assets/img/recalls/${slug}/1${path.extname(new URL(src).pathname) || '.png'}`;
  const caption = rec.image.caption || '';
  for (const r of [rel, relRaw]) {
    const onDisk = path.join(ROOT, r.slice(1).split('/').join(path.sep));
    if (existsSync(onDisk)) return { rel: r, caption };
  }
  try {
    const res = await fetch(src, { headers: { 'user-agent': 'stophurting-recalls/1.0' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dir, { recursive: true });
    if (sharp) {
      await sharp(buf).resize({ width: 900, withoutEnlargement: true }).webp({ quality: 82 })
        .toFile(path.join(ROOT, rel.slice(1).split('/').join(path.sep)));
      return { rel, caption };
    }
    writeFileSync(path.join(ROOT, relRaw.slice(1).split('/').join(path.sep)), buf);
    return { rel: relRaw, caption };
  } catch { return null; }
}

// ---------- ad slot ----------
// ONE unit, injected verbatim from tools/recalls/ad-slot.html. Comments and whitespace do not
// count as content, so an un-filled file emits NO markup — no empty box, no reserved gap. The
// same slot is a desktop rail and a mobile in-content block, repositioned by CSS grid areas
// rather than duplicated: two copies would load the unit twice and breach AdSense's own rules.
const AD_HTML = (() => {
  const f = path.join(HERE, 'ad-slot.html');
  if (!existsSync(f)) return '';
  const raw = readFileSync(f, 'utf8');
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim() ? raw.trim() : '';
})();

// ---------- rail links ----------
// Deterministic only. "Same hazard" is an EXACT match on the stored hazard string — no fuzzy
// matching, no brand guessing. We do not store a brand field, and deriving one from the first
// word of a product name is exactly the kind of confident guess that produces wrong pairings;
// an omitted block is honest, a wrongly-related recall is not.
// ⚠ Country-scoped, deliberately. A reader on an Australian recall cannot act on a US notice —
// different regulator, different retailers, different phone number — so cross-country rail links
// would send them somewhere they can do nothing. The switch between countries belongs on the hub,
// where it is a choice, not buried in a sidebar where it is a trap.
function railLinks(items, slug, hazard, country) {
  const others = items.filter((i) => i.slug !== slug && cc(i) === country);
  const sameHazard = hazard ? others.filter((i) => i.hazard === hazard).slice(0, 4) : [];
  const seen = new Set(sameHazard.map((i) => i.slug));
  const recent = others.filter((i) => !seen.has(i.slug)).slice(0, 6);
  const block = (title, list) => (!list.length ? '' : `
        <section class="rail-card">
          <h2 class="rail-title">${esc(title)}</h2>
          <ul class="rail-list">
${list.map((i) => `            <li><a href="${recallPath(i)}"><span class="rail-prod">${esc(clamp(i.prod, 60))}</span><span class="rail-date">${esc(i.date)}</span></a></li>`).join('\n')}
          </ul>
        </section>`);
  // A permanent card, not conditional: the transparency page only builds trust if it is always
  // reachable, including when it is empty.
  const log = `
        <section class="rail-card">
          <h2 class="rail-title">Corrections</h2>
          <ul class="rail-list">
            <li><a href="/updates/"><span class="rail-prod">Corrected &amp; withdrawn notices</span><span class="rail-date">what changed, and when</span></a></li>
          </ul>
        </section>`;
  return block('Same hazard', sameHazard) + block('Recent recalls', recent) + log;
}

// ---------- page template ----------
function recallPage(rec, img, items) {
  const src = sourceFor(cc(rec));
  const { slug, prod, date } = rec;
  const hz = rec.hazard;
  // ≤60 chars total, and the word "Recall" is the query — it must never be the part that
  // truncates. No brand suffix: at DR 0 the brand buys nothing and costs 14 chars.
  const shortMY = new Date(date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const title = `${clamp(prod, 42)} Recall (${shortMY})`;
  const desc = rec.desc;
  const rows = rec.rows;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: `${prod} Recall (${monthYear(date)})`,
    description: desc,
    author: { '@type': 'Organization', name: 'StopHurting', url: ORIGIN },
    publisher: { '@type': 'Organization', name: 'StopHurting', url: ORIGIN },
    mainEntityOfPage: `${ORIGIN}${recallPath(rec)}`,
    datePublished: date, dateModified: rec.modified || date,
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${ORIGIN}${recallPath(rec)}" />
  <meta property="og:title" content="${esc(`${prod} Recall (${monthYear(date)})`)}" />
  <meta property="og:description" content="${esc(desc)}" />
${img ? `  <meta property="og:image" content="${ORIGIN}${esc(img.rel)}" />\n` : ''}  <meta property="og:type" content="article" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
  ${HEADER}
  <main>
    <article class="recall-shell">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;/&nbsp; <a href="${hubPath(cc(rec))}">${esc(src.hubCrumb)}</a></div>
      <header class="article-header">
        <span class="chip chip-recall">Recall</span>
        <h1>${esc(prod)} Recall (${esc(monthYear(date))})</h1>
        <p class="dek">${esc(rec.dek)}</p>
      </header>
      <div class="recall-layout">
        <div class="rl-facts">
          <table class="recall-facts">
            <tbody>
${rows.map(([k, v]) => `              <tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}
            </tbody>
          </table>
        </div>
        <div class="rl-body">
${img ? `          <figure class="recall-img"><img src="${esc(img.rel)}" alt="${esc(img.caption || prod + ' — recalled product')}" loading="lazy" />${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}</figure>\n` : ''}          <div class="prose">
${rec.sections.map((s) => `            <h2>${esc(s.h2)}</h2>\n            ${s.html}`).join('\n')}
            <p class="recall-source">Source: <a href="${esc(rec.url)}" target="_blank" rel="noopener">the official ${esc(src.noticeName)}</a>, published ${esc(date)}. Every fact on this page comes from that notice — if anything here disagrees with it, the notice wins.</p>
${src.attribution ? `            <p class="recall-licence">${src.attribution}</p>\n` : ''}
          </div>
        </div>
        <aside class="rl-side">
${AD_HTML ? `          <div class="rl-ad" aria-label="Advertisement">${AD_HTML}</div>\n` : ''}          <div class="rl-rail">${railLinks(items || [], slug, hz, cc(rec))}
          </div>
        </aside>
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
const HEADER = `<header class="site-header"><div class="wrap header-inner"><a class="brand" href="/"><span class="brand-mark">${SEAL}</span><span class="brand-name">Stop<span class="brand-accent">Hurting</span></span></a><nav class="nav"><a href="${NAV_HUB}">Recalls</a><a href="/updates/">Corrections</a><a href="/myths/">Myth Checks</a><a href="/about/">About</a></nav></div></header>`;
// ⭐ The footer links are not decoration: AdSense expects a reachable privacy policy and a way to
// contact the site owner, and their absence is a standard site-level rejection.
// ⭐ Not decoration: AdSense expects a reachable privacy policy and a way to contact the owner,
// and their absence is a standard site-level rejection.
// 🚧 Contact is added here the moment /contact/ exists — the dead-links check refuses a footer
// link to a page that is not on disk, which is exactly what it is for.
// ⭐ THE CREDIT LINE IS BUILT FROM THE SOURCE REGISTRY, not typed. It used to name the CPSC and
// only the CPSC — which was true of a site with one country and became a false statement about
// our own licensing the moment Australian pages existed. The ACCC's CC BY 4.0 licence REQUIRES
// attribution; a hard-coded footer is exactly the kind of thing nobody remembers to update, so
// adding a source to the registry now adds its credit here automatically.
const CREDITS = COUNTRIES.map((c) => SOURCES[c].footerCredit).join('. ');
const FOOTER = `<footer class="site-footer"><div class="wrap">© StopHurting — ${CREDITS}. Not legal or medical advice. &nbsp;·&nbsp; <a href="/updates/">Corrections</a> &nbsp;·&nbsp; <a href="/privacy/">Privacy</a> &nbsp;·&nbsp; <a href="/contact/">Contact</a> &nbsp;·&nbsp; <a href="/about/">About</a></div></footer>`;
const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 26'><path d='M12 1l10 4v7c0 6.5-4.3 11.3-10 13C6.3 23.3 2 18.5 2 12V5l10-4z' fill='%23e07b39'/><path d='M7.5 12.5l3 3 6-6' stroke='%2316334f' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" />`;

// ⭐ THE HUB IS NOW PHOTO-LED. Jason: "the long list on a white background is just bothering me…
// it looks like a 2000's website." He is right, and the fix is also the FUNCTIONAL one: the
// question a visitor actually has is "do I own this thing?", which a photograph answers instantly
// and a product name often does not. All 134 recalls have a mirrored CPSC photo, so there are no
// gaps to design around — the usual reason sites fall back to text rows.
// ⛔ Photos are `object-fit: contain` on white, never cropped to fill: a recall thumbnail that
// slices the product in half fails at its only job.
// `showCc` marks each card with its country. OFF on a country hub, where every card is already
// that country and a repeated badge is noise. ON wherever countries are mixed — the homepage and
// search results — because an unbadged Australian recall on a US reader's screen sends them to a
// phone number they cannot call. Same rule the ticker already follows.
// ⭐ IMAGELESS SOURCES GET A DESIGNED TILE, NOT A BROKEN IMAGE. Measured across 12 consecutive UK
// notices: every one has zero inline images and a single PDF attachment titled "Link to Product
// Image and PDF" — the photograph exists only inside that PDF. Rendering a PDF page would produce
// a picture of a DOCUMENT rather than of the product, which is worse than admitting we have none.
// So the card keeps its shape and height and shows the product category instead. This also
// hardens every other country: a US or Canadian record whose mirror failed used to emit an <img>
// pointing at a file that was never written.
// ⛔ `hasImg` is decided by what is RECORDED IN STATE, not by guessing a path exists.
function cardImage(r) {
  if (r.img) return `<img src="${esc(r.img)}" alt="${esc(r.prod)}" loading="lazy" width="400" height="300" />`;
  if (cc(r) === 'us' || cc(r) === 'au') {
    // Pre-dating the stored `img` field: these countries mirrored every photo, and the path is
    // deterministic. Newer records carry `img` explicitly.
    return `<img src="/assets/img/recalls/${esc(r.slug)}/1.webp" alt="${esc(r.prod)}" loading="lazy" width="400" height="300" />`;
  }
  return `<span class="r-card-noimg"><span class="r-card-cat">${esc(r.cat || 'Recall')}</span><span class="r-card-noimg-note">no photo published</span></span>`;
}
function card(r, showCc = false) {
  return `        <a class="r-card" href="${recallPath(r)}">
          <span class="r-card-img">${cardImage(r)}</span>
          <span class="r-card-body">
            <span class="r-card-prod">${showCc ? `<span class="r-card-cc">${esc(cc(r).toUpperCase())}</span>` : ''}${esc(clamp(r.prod, 64))}</span>
            <span class="r-card-hazard">${esc(clamp(r.hazard, 70))}</span>
            <span class="r-card-date">${esc(r.date)}</span>
          </span>
        </a>`;
}
function row(r) {
  return `        <li><a class="r-row" href="${recallPath(r)}"><span class="r-date">${esc(r.date)}</span><span class="r-prod">${esc(r.prod)}</span><span class="r-hazard">${esc(clamp(r.hazard, 90))}</span></a></li>`;
}
// ⭐ Country tag on every ticker entry. Today everything is US, so it reads "US" throughout and
// looks redundant — that is deliberate. Once Canada, the UK and Australia land, a reader scanning
// the scroller needs to know at a glance whether a recall applies to them, and retrofitting a
// distinguishing mark AFTER people have learned to read the strip without one is worse than
// having it look obvious for a while.
// `country` is read off the record with a US default, so no state migration is needed.
function ticker(items) {
  const five = items.slice(0, 5)
    .map((r) => `<a href="${recallPath(r)}"><span class="tk-cc">${esc((r.country || 'us').toUpperCase())}</span>${esc(r.prod)} — ${esc(clamp(r.hazard, 60))}</a>`)
    .join('<span class="ticker-sep">•</span>');
  return `<div class="ticker" aria-label="Latest recalls"><span class="ticker-label">LATEST</span><div class="ticker-clip"><div class="ticker-track">${five}<span class="ticker-sep">•</span>${five}</div></div></div>`;
}
// ⭐ Every country gets its own hub, and each hub lists ONLY its own recalls. The list used to be
// rebuilt from the whole of state.seen, which was correct while state held one country and would
// have put 134 US recalls on /au/recalls/ the first time Australia ran — with the Australian hub's
// own heading over them.
// The country strip is the minimum that stops /au/ being an orphan: it is reachable from the US
// hub, the ticker and the sitemap, and nothing else links into it. A fuller switcher is Jason's
// next call, not something to guess at here.
// ⛔ NO FLAG EMOJI. Windows ships no regional-indicator glyphs, so 🇦🇺 renders as the letters "AU"
// in a box on the machine this is built and reviewed on. Words, not flags.
function countryStrip(current) {
  return `<nav class="hub-countries" aria-label="Choose a country">${COUNTRIES.map((c) => {
    const s = SOURCES[c];
    return `<a class="hub-cc${c === current ? ' on' : ''}"${c === current ? ' aria-current="page"' : ''} href="${hubPath(c)}"><span class="hub-cc-code">${c.toUpperCase()}</span>${esc(s.country)}</a>`;
  }).join('')}</nav>`;
}
function hubPage(items, country) {
  const src = sourceFor(country);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(src.hubTitle)}</title>
  <meta name="description" content="${esc(src.hubDesc(items.length))}" />
  <link rel="canonical" href="${ORIGIN}${hubPath(country)}" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  ${ticker(items)}
  <main>
    <section class="wrap section">
      <h1 class="section-title">${esc(src.hubHeading)}</h1>
      ${countryStrip(country)}
      <p class="section-sub">${esc(src.hubIntro(items.length))}</p>
      <div class="search-box" style="margin:0 0 1.2rem"><input id="q" type="search" placeholder="Search a brand, product, or model number…" autocomplete="off" style="border:1px solid var(--light)" /></div>
      <div class="r-grid" id="hub-list">
${items.map(card).join('\n')}
      </div>
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
        // Search spans every country on purpose — "is my thing recalled" does not stop at a
        // border, and the same product is often recalled in both. So each RESULT carries its
        // country code, which the hub grid does not need (there, every card is that country).
        ? hits.map(function (r) { var cc = (r.cc || 'us').toUpperCase(); return '<a class="r-card" href="/' + (r.cc || 'us') + '/recalls/' + r.slug + '/"><span class="r-card-img"><img src="/assets/img/recalls/' + r.slug + '/1.webp" alt="" loading="lazy" /></span><span class="r-card-body"><span class="r-card-prod"><span class="r-card-cc">' + cc + '</span>' + r.prod + '</span><span class="r-card-hazard">' + r.hazard + '</span><span class="r-card-date">' + r.date + '</span></span></a>'; }).join('')
        : '<p class="r-empty">No tracked recall matches that — we cover US and Australian recalls from June 2026 onward.</p>';
    });
  })();
  </script>
</body>
</html>
`;
}
// ---------- corrections (transparency) ----------
// ⭐ Jason's word for this: TRANSPARENCY. A site whose promise is "if this page disagrees with the
// official notice, the notice wins" has to show its corrections in public, not fix them quietly.
// It also solves a real discoverability problem he named: a recall amended today sorts by its
// ORIGINAL recall date, so a correction lands fourteen days deep in the list where nobody sees it.
// This page is sorted by WHEN WE CHANGED IT, which is the only order that surfaces a correction.
function updatesPage(items) {
  const withdrawn = items.filter((r) => r.withdrawn)
    .sort((a, b) => String(b.withdrawn).localeCompare(String(a.withdrawn)));
  const amended = items.filter((r) => r.amendedAt && !r.withdrawn)
    .sort((a, b) => String(b.amendedAt).localeCompare(String(a.amendedAt)));
  const row = (r, when, note) => `        <li><a class="r-row" href="${recallPath(r)}"><span class="r-date">${esc(when)}</span><span class="r-prod">${esc(clamp(r.prod, 70))}</span><span class="r-hazard">${esc(note)}</span></a></li>`;
  const block = (title, sub, list, render) => (!list.length ? '' : `
      <h2 class="section-title" style="font-size:1.35rem;margin-top:2rem">${esc(title)}</h2>
      <p class="section-sub">${esc(sub)}</p>
      <ul class="r-list">
${list.map(render).join('\n')}
      </ul>`);
  // ⚠ Worded for every regulator, not just the CPSC. These two sentences named the CPSC while the
  // page listed a country it had nothing to do with — the same class of stale copy as the footer.
  const body = block(
    'Withdrawn notices', 'The official notice behind these pages was withdrawn or replaced. The page is kept so anyone who bookmarked it finds out.',
    withdrawn, (r) => row(r, r.withdrawn, 'withdrawn — see the official notice'))
    + block(
    'Corrected pages', 'The regulator amended these notices after we first published them. Each page was rebuilt from the updated record.',
    amended, (r) => row(r, r.amendedAt, `updated — notice revised ${r.modified}`));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Corrections &amp; Withdrawals — StopHurting</title>
  <meta name="description" content="Every recall page we have corrected or marked withdrawn, and when. Recalls change after they are issued; this page records it in public." />
  <link rel="canonical" href="${ORIGIN}/updates/" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  <main>
    <section class="wrap section">
      <h1 class="section-title">Corrections &amp; withdrawals</h1>
      <p class="section-sub">Recalls do not stand still. The CPSC expands them, corrects unit counts and remedies, and occasionally withdraws a notice altogether. When that happens we rebuild the page from the updated record — and list it here, sorted by when it changed rather than when the recall was issued, so a correction cannot get buried behind two weeks of newer recalls.</p>
${body || '      <p class="section-sub">Nothing to report: no page has needed a correction, and no notice we track has been withdrawn.</p>'}
      <p class="section-sub" style="margin-top:2rem">Spotted something we have wrong? <a href="/contact/">Tell us</a> — the official notice wins, always.</p>
    </section>
  </main>
  ${FOOTER}
</body>
</html>
`;
}

// ---------- privacy ----------
// ⭐ AdSense's program policies REQUIRE a privacy policy disclosing third-party advertising
// cookies. The site had none, which is close to an automatic rejection and is the likeliest
// single reason the 2026-08-16 application was refused.
// ⛔ EVERY CLAIM BELOW MUST STAY TRUE. Measured on 2026-08-16: no analytics script of any kind
// anywhere in the site, no accounts, no newsletter, no forms. If any of that changes, this page
// changes in the SAME commit — a privacy policy that describes a site we no longer run is worse
// than none, because it is a written promise we are visibly breaking.
function privacyPage() {
  const today = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy — StopHurting</title>
  <meta name="description" content="What StopHurting.org collects, what it does not, and how third-party advertising cookies work on this site." />
  <link rel="canonical" href="${ORIGIN}/privacy/" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  <main>
    <article class="article-wrap">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;/&nbsp; Privacy</div>
      <header class="article-header">
        <h1>Privacy Policy</h1>
        <p class="dek">Last updated ${today}.</p>
      </header>
      <div class="prose">
        <h2>What we collect</h2>
        <p>Nothing automatically. StopHurting.org has no accounts, no newsletter, no comments and
        no forms of any kind. We run no analytics software, so we do not build a profile of you,
        and we do not sell or share data about you.</p>
        <p>The search box on the recalls page runs entirely in your browser against a file your
        browser downloads. What you type into it is never sent to us.</p>

        <h2>If you email us</h2>
        <p>Our contact page publishes an email address rather than a form. If you write to us, we
        receive and keep your message and your email address, in the same way anyone receiving
        email does. We use it to reply to you and nothing else: it is not added to a mailing list,
        not used for advertising, and not passed to anyone. Ask us to delete the correspondence and
        we will.</p>

        <h2>Hosting</h2>
        <p>The site is served by Cloudflare Pages. Like any web host, Cloudflare processes
        connection information such as your IP address in order to deliver pages and to protect
        against abuse. That processing is Cloudflare's, governed by their privacy policy, and we
        do not receive a per-visitor report from it.</p>

        <h2>Advertising</h2>
        <p>StopHurting.org intends to display advertising through Google AdSense. No advertising
        code is active on the site while that application is pending; once it is live, the
        following applies:</p>
        <ul>
          <li>Third-party vendors, including Google, use cookies to serve ads based on your prior
          visits to this and other websites.</li>
          <li>Google's use of advertising cookies enables it and its partners to serve ads to you
          based on your visit to this site and/or other sites on the internet.</li>
          <li>You may opt out of personalised advertising by visiting
          <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener nofollow">Google Ads Settings</a>.
          You can opt out of some third-party vendors' use of cookies for personalised advertising
          at <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener nofollow">aboutads.info</a>.</li>
          <li>Visitors in the EEA, UK and Switzerland are shown a consent message where required,
          and advertising cookies are set according to that choice.</li>
        </ul>

        <h2>Where the recall information comes from</h2>
        <p>Every recall page is built from the U.S. Consumer Product Safety Commission's public
        SaferProducts data, which is a work of the U.S. federal government and in the public
        domain. We link to the official notice on every page. If anything on this site disagrees
        with that notice, the notice is correct and we are not.</p>

        <h2>Children</h2>
        <p>This site is not directed at children under 13 and we do not knowingly collect
        information from them.</p>

        <h2>Changes</h2>
        <p>If this policy changes, the date at the top of this page changes with it.</p>

        <h2>Contact</h2>
        <p>Questions about this policy can be sent through our <a href="/contact/">contact page</a>.</p>
      </div>
    </article>
  </main>
  ${FOOTER}
</body>
</html>
`;
}

// ---------- contact ----------
// Publishes admin@stophurting.org ONLY. Jason's personal address is never on the site; the
// routing lives in Cloudflare Email Routing, so the destination can change without touching the
// site. That address was already in use in a few places with no working route — this makes it
// the one published contact point rather than adding another.
// ⭐ The page pushes people to the RECALLING COMPANY first, on purpose. Every recall page already
// carries the CPSC consumer-contact line, and we cannot process a refund or a replacement for
// anyone. Saying so here keeps the inbox for things we can actually act on: corrections.
const CONTACT_EMAIL = 'admin@stophurting.org';
function contactPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Contact — StopHurting</title>
  <meta name="description" content="How to reach StopHurting.org about a correction, a privacy question, or the recall data on this site." />
  <link rel="canonical" href="${ORIGIN}/contact/" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  <main>
    <article class="article-wrap">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;/&nbsp; Contact</div>
      <header class="article-header">
        <h1>Contact</h1>
        <p class="dek">One address, read by a person: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
      </header>
      <div class="prose">
        <h2>If a page here is wrong</h2>
        <p>Tell us and we will fix it. Every recall page is built from the official CPSC notice and
        links to it — if this site disagrees with that notice, this site is wrong. Include the page
        address and what is incorrect, and the correction gets made.</p>

        <h2>If you own a recalled product</h2>
        <p>Please contact the company running the recall, not us. Their phone number, email or
        website is listed in the <strong>Contact</strong> row on each recall page, taken straight
        from the CPSC notice. We are not the manufacturer, the retailer or the CPSC, and we cannot
        arrange a refund, a repair or a replacement for you.</p>

        <h2>If you are the company being recalled</h2>
        <p>We publish the CPSC's public record and link to it. If the notice itself has been
        updated or withdrawn, point us at the updated notice and we will match it.</p>

        <h2>Privacy</h2>
        <p>Questions about what this site does and does not collect are answered on the
        <a href="/privacy/">privacy page</a>, and can be sent to the same address.</p>
      </div>
    </article>
  </main>
  ${FOOTER}
</body>
</html>
`;
}

// ---------- 404 ----------
// ⭐ MEASURED 2026-08-16: every nonexistent path returned HTTP 200 with the homepage —
// /ads.txt included, so AdSense fetched HTML where a text file should be. To a crawler that is
// a site with infinite pages of duplicate content, which is one of the most common reasons an
// AdSense application is refused. Cloudflare Pages serves /404.html with a real 404 status for
// unmatched paths, UNLESS the project is in SPA mode — in which case this file is ignored and
// the fix is a dashboard toggle, not a commit. Deploy, then re-measure the status code.
// A 404 here should still do the job the site exists for, so it carries the search box and the
// latest recalls rather than a dead end.
function notFoundPage(items) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found — StopHurting</title>
  <meta name="robots" content="noindex" />
  ${FAVICON}
  <link rel="stylesheet" href="/assets/css/style.css" />
</head>
<body>
  ${HEADER}
  <main>
    <section class="wrap section">
      <h1 class="section-title">That page isn't here</h1>
      <p class="section-sub">The link may be old, or the recall may never have existed. Search ${items.length} tracked recalls, or start from the newest below.</p>
      <div class="search-box" style="margin:0 0 1.4rem"><input id="q" type="search" placeholder="Search a brand, product, or model number…" autocomplete="off" style="border:1px solid var(--light)" /></div>
      <ul class="r-list" id="hub-list">
${items.slice(0, 15).map(row).join('\n')}
      </ul>
    </section>
  </main>
  ${FOOTER}
</body>
</html>
`;
}

// ---------- footer sync ----------
// ⭐ The generator only ever owned the pages it writes. The homepage, /myths/, /about/ and the 13
// legacy articles are hand-written, so when Privacy and Contact were added to FOOTER they landed
// on 4 pages out of 154 — including NOT the homepage, which is exactly where an AdSense reviewer
// starts. Jason spotted it by looking; no check we had could see it, because every page did have
// *a* footer.
// This rewrites the header AND footer blocks in every HTML file in the repo, generated or not,
// so site chrome can never again exist on only part of the site. Idempotent.
// ⭐ The header matters as much as the footer now: Jason's call is that a transparency link
// buried in footer small print is not transparency — "sites that bury their links in small print
// on the bottom are not really being transparent" — so Corrections lives in the nav.
function syncFooters() {
  const skip = new Set(['node_modules', '.git', 'tools', 'assets', '_port']);
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.html')) files.push(path.join(dir, e.name));
    }
  })(ROOT);
  let changed = 0;
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    const next = html
      .replace(/<header class="site-header">[\s\S]*?<\/header>/, HEADER)
      .replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, FOOTER);
    if (next !== html) { writeFileSync(f, next); changed++; }
  }
  return { scanned: files.length, changed };
}

// ⭐⭐ THE HOMEPAGE IS A FRONT DOOR, NOT A SECOND ARCHIVE. Jason, on seeing the hub get photo
// cards and a country switcher: "the home page should just be the recall page" — then, correctly,
// "we have the same content on two pages…?"
// Both halves are right, and the resolution is the COUNT plus the JOB:
//   · the hubs are the complete list for one country, and target a category query
//     ("Australian product recalls");
//   · the homepage is the "do I own this?" TOOL — search first, a short teaser of the newest
//     across every country, and the things no hub carries (what this site is, the myth archive).
//     Its h1 is a question, which is a different query shape entirely.
// ⛔ THIS COUNT IS LOAD-BEARING, NOT A TASTE SETTING. 20 of 159 reads as the archive and puts the
// homepage in competition with its own hub for the same queries — two of our pages splitting the
// authority of a DR-0 site. A short teaser does not. Raising it is an SEO decision.
//
// ⭐ PER COUNTRY, not "the newest N overall" — measured, not assumed. The first build of this
// took the latest 8 by date and every single one came out US: the CPSC drops 7–18 recalls every
// Thursday while the ACCC posts ~5 a week, so a date sort buries Australia permanently. The
// country badges would have been decoration and the front door would have shown one country while
// claiming two. Taking the newest few FROM EACH source is the only selection that stays honest as
// sources of wildly different volume are added.
const HOME_PER_COUNTRY = 4;
function homeItems(items) {
  return COUNTRIES
    .flatMap((c) => items.filter((r) => cc(r) === c).slice(0, HOME_PER_COUNTRY))
    .sort((a, b) => b.date.localeCompare(a.date));
}
function injectHome(items) {
  const home = path.join(ROOT, 'index.html');
  let html = readFileSync(home, 'utf8');
  // ⭐ GENERATED, not hand-typed — and that is the whole point. The footer named only the CPSC
  // and the homepage hero said "Every U.S. consumer product recall" for exactly as long as
  // somebody had to remember to edit them by hand. Both are built from the source registry now,
  // so country #3 updates the front door by existing.
  const countries = COUNTRIES.map((c) => SOURCES[c].countryIn);
  const list = countries.length > 1
    ? `${countries.slice(0, -1).join(', ')} and ${countries[countries.length - 1]}`
    : countries[0];
  const hero = `<!-- HERO:START (generated by tools/recalls/build.mjs — do not hand-edit this block) -->
      <h1>Is your stuff recalled?</h1>
      <p class="hero-sub">Search every consumer product recall we track in ${esc(list)} — what was recalled, why it's dangerous, and what to do about it. Straight from the official notices, updated automatically.</p>
      <!-- HERO:END -->`;
  html = html.replace(/<!-- HERO:START[\s\S]*?<!-- HERO:END -->/, hero);

  const top = homeItems(items);
  // ⭐ Jason's call: the country selector was a quiet pill row under the grid, and it is the
  // site's primary navigation now that there are three countries and more coming. It moves into
  // the SAME rail the recall pages use — reused, not reinvented — which also gives the homepage
  // an ad slot it never had, on the page that gets the most traffic, on a site whose entire
  // reason to exist is ad revenue.
  // ⛔ The rail is not just ad housing here either: it carries every country hub, which is the
  // only internal link into /au/ and /ca/ from the front door.
  const counts = Object.fromEntries(COUNTRIES.map((c) => [c, items.filter((r) => cc(r) === c).length]));
  const countryCard = `
          <section class="rail-card">
            <h2 class="rail-title">Browse by country</h2>
            <ul class="rail-list rail-countries">
${COUNTRIES.map((c) => `              <li><a href="${hubPath(c)}"><span class="rail-cc">${c.toUpperCase()}</span><span class="rail-prod">${esc(SOURCES[c].country)}</span><span class="rail-date">${counts[c]} tracked</span></a></li>`).join('\n')}
            </ul>
          </section>`;
  const strip = `<!-- RECALLS:START (generated by tools/recalls/build.mjs — do not hand-edit this block) -->
      <div class="home-layout">
        <div class="hl-main">
          <div class="r-grid">
${top.map((r) => card(r, true)).join('\n')}
          </div>
        </div>
        <aside class="hl-side">
${AD_HTML ? `          <div class="hl-ad" aria-label="Advertisement">${AD_HTML}</div>\n` : ''}          <div class="hl-rail">${countryCard}
            <section class="rail-card">
              <h2 class="rail-title">Corrections</h2>
              <ul class="rail-list">
                <li><a href="/updates/"><span class="rail-prod">Corrected &amp; withdrawn notices</span><span class="rail-date">what changed, and when</span></a></li>
              </ul>
            </section>
          </div>
        </aside>
      </div>
      <!-- RECALLS:END -->`;
  html = html.replace(/<!-- RECALLS:START[\s\S]*?<!-- RECALLS:END -->/, strip);
  // The scroller gets the same per-country selection for the same reason — on a date sort it read
  // "US · US · US · US · US" while the page underneath offered two countries.
  const tick = `<!-- TICKER:START -->\n  ${ticker(top)}\n  <!-- TICKER:END -->`;
  html = html.replace(/<!-- TICKER:START -->[\s\S]*?<!-- TICKER:END -->/, tick);
  writeFileSync(home, html);
}
function writeSearchIndex(items) {
  const idx = items.map((r) => ({
    slug: r.slug, cc: cc(r), date: r.date, prod: r.prod, hazard: clamp(r.hazard, 90),
    t: `${r.prod} ${r.hazard} ${r.models || ''} ${r.num}`.toLowerCase(),
  }));
  writeFileSync(path.join(ROOT, 'recalls-index.json'), JSON.stringify(idx));
}
function sitemap(items) {
  // Every hub, not just the one this run built — a sitemap that lists only today's country would
  // drop the other country's hub out of the index on the next run.
  const staticPages = ['', 'about/', 'privacy/', 'contact/', 'updates/', ...COUNTRIES.map((c) => `${c}/recalls/`),
    ...execSync('git ls-files', { cwd: ROOT }).toString().split('\n')
      .filter((f) => /^[a-z0-9-]+\/index\.html$/.test(f) && !f.startsWith('recalls'))
      .map((f) => f.replace('index.html', ''))];
  const urls = [
    ...staticPages.map((p) => `  <url><loc>${ORIGIN}/${p}</loc></url>`),
    ...items.map((r) => `  <url><loc>${ORIGIN}${recallPath(r)}</loc><lastmod>${r.modified || r.date}</lastmod></url>`),
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

const newUrls = [];
const prepared = [];

// ⭐ RECONCILE, not just append. Skipping every recall we have already seen meant two silent
// failures on a site whose whole promise is "the official notice wins":
//   · regulators AMEND recalls constantly — units, remedies, added models. The revision shows up
//     in a field the source declares (`revisionKey`), and nothing compared them, so our page kept
//     the original text forever.
//   · regulators WITHDRAW recalls. The record leaves the feed, state.seen keeps it, and the page
//     stays up telling people a product is dangerous when the notice behind it is gone.
for (const country of TARGETS) {
  const src = sourceFor(country);
  const known = new Map(Object.entries(state.seen)
    .filter(([, r]) => cc(r) === country)
    .map(([id, r]) => [id, { ...r, id, country }]));

  let records;
  try {
    records = await src.fetch({ since, known, rebuild: REBUILD });
  } catch (e) {
    // ⛔ One regulator being down must not take the other's build with it, and must never let a
    // half-built run write state. Skip this country, keep the rest.
    console.error(`🔴 ${country.toUpperCase()} feed failed: ${e.message} — skipping ${country}, state untouched for it.`);
    continue;
  }

  const key = src.revisionKey;
  const fresh = [];
  const amendedList = [];
  for (const rec of records) {
    const prev = state.seen[rec.id];
    if (!prev) { fresh.push(rec); continue; }
    if (REBUILD) { fresh.push(rec); continue; }
    if (rec.unchanged) continue;
    if (rec[key] && prev[key] !== rec[key]) { fresh.push(rec); amendedList.push(rec); }
  }

  // ⛔⛔ WITHDRAWAL DETECTION IS "IN OUR STATE BUT ABSENT FROM THE FEED", WHICH IS ONLY MEANINGFUL
  // WHERE THE FEED RETURNS A COMPLETE WINDOW. Australia's is a rolling 25 with no archive: every
  // page older than the newest 25 is "absent" on every run, so this would report the entire
  // country withdrawn, every four hours, forever. The source declares whether it can be asked.
  // ⚠ The OFF case still prints. Silence would read as "nothing was withdrawn", which is a claim
  // we cannot make about a feed that does not tell us.
  if (src.completeWindow) {
    const feedIds = new Set(records.map((r) => String(r.id)));
    // ⛔ ABSENCE NEVER DELETES. Only recalls whose date falls INSIDE the window we just fetched
    // can meaningfully be "missing" — anything older simply was not requested. And even then this
    // only REPORTS: a feed outage or an API change would otherwise wipe pages wholesale, and a
    // page we wrongly deleted is unrecoverable while a page we wrongly kept is one edit away.
    const vanished = [...known.keys()].filter((id) => known.get(id).date >= since && !feedIds.has(String(id)));
    if (vanished.length) {
      console.log(`\n🔴 ${vanished.length} ${country.toUpperCase()} recall(s) are on our site but NO LONGER IN THE ${src.agencyShort} FEED for this window.`);
      console.log(`   These pages still say a product is recalled. Check each against the official notice —`);
      console.log(`   withdrawn, or a feed glitch? NOTHING is deleted automatically.`);
      for (const id of vanished) console.log(`   · ${state.seen[id].slug}  (${state.seen[id].num || 'no recall no.'}, ${state.seen[id].date})`);
      console.log('');
    }
  } else {
    // ⚠ THE REASON IS THE SOURCE'S TO STATE. This line was hardcoded to Australia's situation —
    // "publishes a rolling window with no archive" — and stayed that way when Canada and the UK
    // turned the check off for the OPPOSITE reason: both publish a complete archive, and it is
    // our own lane and window filtering that makes absence meaningless. Printing Australia's
    // excuse under a UK heading is a small lie that would have been quoted back as a fact.
    console.log(`${country.toUpperCase()}: withdrawal check OFF — ${src.windowNote}`);
  }

  console.log(`${country.toUpperCase()} feed: ${records.length} record(s) · ${REBUILD ? 'REBUILD all' : 'new'}: ${fresh.length - amendedList.length} · amended: ${amendedList.length}`);
  for (const r of amendedList) console.log(`  ~ AMENDED since we published: ${r.slug} (${state.seen[r.id][key]} -> ${r[key]})`);

  for (const rec of fresh) {
    if (!WRITE) { console.log(`  would add: ${country}/${rec.slug}`); continue; }
    const img = await mirrorImage(rec, rec.slug);
    const prev = state.seen[rec.id];
    // Stamp WHEN WE CORRECTED IT, separately from the regulator's own revision marker — the
    // corrections page sorts on ours, because that is the order a reader needs to see changes in.
    const amendedAt = (prev && rec[key] && prev[key] !== rec[key])
      ? new Date().toISOString().slice(0, 10) : (prev ? prev.amendedAt : undefined);
    state.seen[rec.id] = {
      ...(prev || {}),
      country,
      slug: rec.slug, prod: rec.prod, hazard: rec.hazard,
      date: rec.date, modified: rec.modified, num: rec.num,
      models: rec.models,
      ...(rec.cat ? { cat: rec.cat } : {}),
      ...(rec.hash ? { hash: rec.hash } : {}),
      ...(img ? { img: img.rel } : {}),
      ...(amendedAt ? { amendedAt } : {}),
    };
    if (!prev) newUrls.push(`${ORIGIN}${recallPath(rec)}`);
    prepared.push({ rec, img });
  }
}

// TWO PASSES, and the split is load-bearing. The rail's "same hazard" / "recent recalls" links
// are built from state, so writing a page before the whole batch is in state means a batch of
// five never cross-links — each page would only see the recalls that happened to precede it.
// Pass 1 (above) records everything; pass 2 renders against the complete picture.
if (!prepared.length && !WRITE) process.exit(0);
if (prepared.length) {
  const all = Object.values(state.seen).sort((a, b) => b.date.localeCompare(a.date));
  for (const { rec, img } of prepared) {
    const dir = path.join(ROOT, cc(rec), 'recalls', rec.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), recallPage(rec, img, all));
    console.log(`  + ${cc(rec)}/${rec.slug}`);
  }
}

if (WRITE) {
  const items = Object.values(state.seen).sort((a, b) => b.date.localeCompare(a.date));
  // ⭐ EVERY hub is rewritten every run, not just the countries this run fetched: the hubs carry
  // each other's links and a shared "N tracked" count, so building one alone leaves the other
  // stale the moment a recall lands.
  for (const c of COUNTRIES) {
    mkdirSync(path.join(ROOT, c, 'recalls'), { recursive: true });
    writeFileSync(path.join(ROOT, c, 'recalls', 'index.html'), hubPage(items.filter((r) => cc(r) === c), c));
  }
  writeFileSync(path.join(ROOT, '404.html'), notFoundPage(items));
  mkdirSync(path.join(ROOT, 'updates'), { recursive: true });
  writeFileSync(path.join(ROOT, 'updates', 'index.html'), updatesPage(items));
  mkdirSync(path.join(ROOT, 'privacy'), { recursive: true });
  writeFileSync(path.join(ROOT, 'privacy', 'index.html'), privacyPage());
  mkdirSync(path.join(ROOT, 'contact'), { recursive: true });
  writeFileSync(path.join(ROOT, 'contact', 'index.html'), contactPage());
  injectHome(items);
  writeSearchIndex(items);
  sitemap(items);
  const fs2 = syncFooters();
  console.log(`footers: ${fs2.changed} of ${fs2.scanned} html files updated`);
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
