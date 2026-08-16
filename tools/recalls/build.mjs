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
// 🪤 CPSC's NumberOfUnits usually ALREADY reads "About 213,500". Every caller here adds its own
// "About"/"about", which shipped "About About 213,500 units" onto 121 of 134 pages — invisible to
// every check we have, and caught only by reading a rendered page. Strip their qualifier so the
// callers can own the wording.
function unitCount(rec) {
  return (rec.Products || []).map((p) => p.NumberOfUnits).filter(Boolean)
    .map((u) => String(u).replace(/^\s*(about|approx\.?|approximately)\s+/i, '').trim())
    .filter(Boolean).join(' + ') || '';
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
function railLinks(items, slug, hazard) {
  const others = items.filter((i) => i.slug !== slug);
  const sameHazard = hazard ? others.filter((i) => i.hazard === hazard).slice(0, 4) : [];
  const seen = new Set(sameHazard.map((i) => i.slug));
  const recent = others.filter((i) => !seen.has(i.slug)).slice(0, 6);
  const block = (title, list) => (!list.length ? '' : `
        <section class="rail-card">
          <h2 class="rail-title">${esc(title)}</h2>
          <ul class="rail-list">
${list.map((i) => `            <li><a href="/recalls/${i.slug}/"><span class="rail-prod">${esc(clamp(i.prod, 60))}</span><span class="rail-date">${esc(i.date)}</span></a></li>`).join('\n')}
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
function recallPage(rec, slug, img, items) {
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
    <article class="recall-shell">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/recalls/">Recalls</a></div>
      <header class="article-header">
        <span class="chip chip-recall">Recall</span>
        <h1>${esc(prod)} Recall (${esc(monthYear(rec.RecallDate))})</h1>
        <p class="dek">${esc(clamp(hz.charAt(0).toUpperCase() + hz.slice(1), 160))}${units ? ` — about ${esc(units)} units.` : '.'}</p>
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
            <h2>What was recalled</h2>
            <p>${esc(rec.Description)}</p>
${remedy ? `            <h2>What to do</h2>\n            <p>Stop using the product. The listed remedy is: <strong>${esc(remedy)}</strong>. ${esc(rec.ConsumerContact || '')}</p>\n` : ''}            <p class="recall-source">Source: <a href="${esc(rec.URL)}" target="_blank" rel="noopener">the official CPSC recall notice</a>, published ${esc(date)}. Every fact on this page comes from that notice — if anything here disagrees with it, the notice wins.</p>
          </div>
        </div>
        <aside class="rl-side">
${AD_HTML ? `          <div class="rl-ad" aria-label="Advertisement">${AD_HTML}</div>\n` : ''}          <div class="rl-rail">${railLinks(items || [], slug, hazardShort(rec))}
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
const HEADER = `<header class="site-header"><div class="wrap header-inner"><a class="brand" href="/"><span class="brand-mark">${SEAL}</span><span class="brand-name">Stop<span class="brand-accent">Hurting</span></span></a><nav class="nav"><a href="/recalls/">Recalls</a><a href="/myths/">Myth Checks</a><a href="/about/">About</a></nav></div></header>`;
// ⭐ The footer links are not decoration: AdSense expects a reachable privacy policy and a way to
// contact the site owner, and their absence is a standard site-level rejection.
// ⭐ Not decoration: AdSense expects a reachable privacy policy and a way to contact the owner,
// and their absence is a standard site-level rejection.
// 🚧 Contact is added here the moment /contact/ exists — the dead-links check refuses a footer
// link to a page that is not on disk, which is exactly what it is for.
const FOOTER = `<footer class="site-footer"><div class="wrap">© StopHurting — recall data from the U.S. Consumer Product Safety Commission (public domain). Not legal or medical advice. &nbsp;·&nbsp; <a href="/updates/">Corrections</a> &nbsp;·&nbsp; <a href="/privacy/">Privacy</a> &nbsp;·&nbsp; <a href="/contact/">Contact</a> &nbsp;·&nbsp; <a href="/about/">About</a></div></footer>`;
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
  const row = (r, when, note) => `        <li><a class="r-row" href="/recalls/${r.slug}/"><span class="r-date">${esc(when)}</span><span class="r-prod">${esc(clamp(r.prod, 70))}</span><span class="r-hazard">${esc(note)}</span></a></li>`;
  const block = (title, sub, list, render) => (!list.length ? '' : `
      <h2 class="section-title" style="font-size:1.35rem;margin-top:2rem">${esc(title)}</h2>
      <p class="section-sub">${esc(sub)}</p>
      <ul class="r-list">
${list.map(render).join('\n')}
      </ul>`);
  const body = block(
    'Withdrawn notices', 'The CPSC notice behind these pages was withdrawn or replaced. The page is kept so anyone who bookmarked it finds out.',
    withdrawn, (r) => row(r, r.withdrawn, 'withdrawn — see the official notice'))
    + block(
    'Corrected pages', 'The CPSC amended these notices after we first published them. Each page was rebuilt from the updated record.',
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
// This rewrites the footer block in every HTML file in the repo, generated or not, so the two
// links AdSense expects can never again exist on only part of the site. Idempotent: running it
// twice changes nothing.
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
    const next = html.replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, FOOTER);
    if (next !== html) { writeFileSync(f, next); changed++; }
  }
  return { scanned: files.length, changed };
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
// ⭐ RECONCILE, not just append. The original filter skipped every recall we had already seen,
// which meant two silent failures on a site whose whole promise is "the official notice wins":
//   · CPSC AMENDS recalls constantly — units, remedies, added models. LastPublishDate moves and
//     we already store it as `modified`, but nothing compared them, so our page kept the original
//     text forever.
//   · CPSC WITHDRAWS recalls. The record leaves the feed, state.seen keeps it, and the page stays
//     up telling people a product is dangerous when the notice behind it is gone.
const seenIds = new Set(Object.keys(state.seen));
const feedIds = new Set(feed.map((r) => String(r.RecallID)));
const amended = REBUILD ? [] : feed.filter((r) => {
  const prev = state.seen[r.RecallID];
  return prev && isoDay(r.LastPublishDate) && isoDay(r.LastPublishDate) !== prev.modified;
});
// ⛔ ABSENCE NEVER DELETES. Only recalls whose date falls INSIDE the window we just fetched can
// meaningfully be "missing" — anything older simply was not requested. And even then this only
// REPORTS: a CPSC outage or an API change would otherwise wipe pages wholesale, and a page we
// wrongly deleted is unrecoverable while a page we wrongly kept is one edit away from correct.
const vanished = [...seenIds].filter((id) => {
  const r = state.seen[id];
  return r.date >= since && !feedIds.has(String(id));
});
const fresh = REBUILD ? feed : [...feed.filter((r) => !state.seen[r.RecallID]), ...amended];
console.log(`feed: ${feed.length} recalls since ${since} · ${REBUILD ? 'REBUILD all' : 'new'}: ${fresh.length - amended.length} · amended: ${amended.length}`);
for (const r of amended) console.log(`  ~ AMENDED since we published: ${state.seen[r.RecallID].slug} (${state.seen[r.RecallID].modified} -> ${isoDay(r.LastPublishDate)})`);
if (vanished.length) {
  console.log(`\n🔴 ${vanished.length} recall(s) are on our site but NO LONGER IN THE CPSC FEED for this window.`);
  console.log(`   These pages still say a product is recalled. Check each against the official notice —`);
  console.log(`   withdrawn, or a feed glitch? NOTHING is deleted automatically.`);
  for (const id of vanished) console.log(`   · ${state.seen[id].slug}  (recall no. ${state.seen[id].num}, ${state.seen[id].date})`);
  console.log('');
}
if (!fresh.length && !WRITE) process.exit(0);

// TWO PASSES, and the split is load-bearing. The rail's "same hazard" / "recent recalls" links
// are built from state, so writing a page before the whole batch is in state means a CPSC batch
// of five never cross-links — each page would only see the recalls that happened to precede it.
// Pass 1 records everything; pass 2 renders against the complete picture.
const newUrls = [];
const prepared = [];
for (const rec of fresh) {
  const slug = `${slugify(productName(rec))}-recall-${rec.RecallNumber}`;
  if (!WRITE) { console.log(`  would add: ${slug}`); continue; }
  const img = await mirrorImage(rec, slug);
  const models = [
    ...(rec.Products || []).map((p) => p.Model).filter(Boolean),
    ...(rec.ProductUPCs || []).map((u) => (typeof u === 'string' ? u : u?.UPC)).filter(Boolean),
  ].join(' ');
  const wasSeen = !!state.seen[rec.RecallID];
  const prev = state.seen[rec.RecallID];
  // Stamp WHEN WE CORRECTED IT, separately from CPSC's own revision date — the corrections page
  // sorts on ours, because that is the order a reader needs to see changes in.
  const amendedAt = (prev && isoDay(rec.LastPublishDate) && prev.modified !== isoDay(rec.LastPublishDate))
    ? new Date().toISOString().slice(0, 10) : (prev ? prev.amendedAt : undefined);
  state.seen[rec.RecallID] = {
    ...(prev || {}),
    slug, prod: productName(rec), hazard: hazardShort(rec),
    date: isoDay(rec.RecallDate), modified: isoDay(rec.LastPublishDate), num: rec.RecallNumber,
    models,
    ...(amendedAt ? { amendedAt } : {}),
  };
  if (!wasSeen) newUrls.push(`${ORIGIN}/recalls/${slug}/`);
  prepared.push({ rec, slug, img });
}
if (prepared.length) {
  const all = Object.values(state.seen).sort((a, b) => b.date.localeCompare(a.date));
  for (const { rec, slug, img } of prepared) {
    const dir = path.join(ROOT, 'recalls', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), recallPage(rec, slug, img, all));
    console.log(`  + ${slug}`);
  }
}

if (WRITE) {
  const items = Object.values(state.seen).sort((a, b) => b.date.localeCompare(a.date));
  mkdirSync(path.join(ROOT, 'recalls'), { recursive: true });
  writeFileSync(path.join(ROOT, 'recalls', 'index.html'), hubPage(items));
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
