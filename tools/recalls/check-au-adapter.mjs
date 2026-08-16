#!/usr/bin/env node
// StopHurting — the Australian adapter, driven against CAPTURED BYTES.
//
// ⛔ THIS FILE RE-IMPLEMENTS NOTHING. It imports the real SOURCES.au.fetch() and asserts on what
// it returns. A harness that parses the feed itself only ever proves that two parsers agree —
// and they agree on exactly the inputs somebody thought to write down, which is never the input
// that breaks.
//
// ⛔ It never touches the network. The ACCC feed is a rolling 25 with no archive, so a live-path
// harness would drift out from under its own assertions within weeks and could not run offline
// or in a git hook. Fixtures and their capture rules: fixtures/README.md.
//
// Every assertion below names WHAT WOULD BE WRONG on the site if it failed — the point is not
// that the parser changed, it is what a reader would see.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, sourceFor, auParseFeed, sanitize } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fails.push(name); }
}
const eq = (got, want, why) => {
  if (got !== want) throw new Error(`${why}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
};
const has = (hay, needle, why) => {
  if (!String(hay).includes(needle)) throw new Error(`${why}\n     missing ${JSON.stringify(needle)} in ${JSON.stringify(String(hay).slice(0, 220))}`);
};
const hasNot = (hay, needle, why) => {
  if (String(hay).includes(needle)) throw new Error(`${why}\n     found ${JSON.stringify(needle)} in ${JSON.stringify(String(hay).slice(0, 220))}`);
};
const row = (rec, label) => (rec.rows.find(([k]) => k === label) || [])[1];
const section = (rec, h2) => (rec.sections.find((s) => s.h2 === h2) || {}).html;

console.log('au adapter (captured fixtures, no network):');

const recs = await SOURCES.au.fetch({ fixtures: FIX });
const giraffe = recs.find((r) => r.slug.startsWith('nevenka'));
const bike = recs.find((r) => r.slug.startsWith('mondraker'));
const teapot = recs.find((r) => r.slug.startsWith('pokemon'));

// ── the feed itself ────────────────────────────────────────────────────────────────────────
check('parses every item in the feed', () => {
  eq(recs.length, 25, 'the captured feed holds 25 items; parsing fewer means recalls are being dropped silently');
});

check('every record has the fields a page and a card need', () => {
  for (const r of recs) {
    if (!r.id) throw new Error(`${r.slug}: no id — state would key on undefined and every run would re-add it`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`${r.slug}: date ${JSON.stringify(r.date)} is not an ISO day — sorting and <lastmod> both break`);
    if (!r.prod) throw new Error(`${r.id}: no product name — the card, the title and the h1 would all be blank`);
    if (!r.hazard) throw new Error(`${r.slug}: no hazard — the card's whole second line`);
    if (!r.url.startsWith('https://www.productsafety.gov.au/')) throw new Error(`${r.slug}: source link is ${r.url} — every page promises a link to the official notice`);
    if (r.country !== 'au') throw new Error(`${r.slug}: country ${r.country} — a mislabelled record lands on the wrong hub and can reach the wrong Facebook page`);
  }
});

// ── the notice page, fully populated ───────────────────────────────────────────────────────
check('lifts every fact off a complete notice', () => {
  eq(giraffe.prod, 'Nevenka Baby pull string giraffe toy', 'the product name is the h1, the title and the card');
  eq(row(giraffe, 'Brand'), 'Nevenka', 'brand is half of what people search');
  eq(row(giraffe, 'Sold at'), 'Nevenka, Woolworths', '"where would I have bought this" is the second question after "do I own it"');
  eq(row(giraffe, 'On sale'), '1 November 2025 - 31 July 2026', 'the sale window is how someone decides whether their one is affected');
  eq(row(giraffe, 'Recalled by'), 'Y WAREHOUSE PTY LTD', 'the supplier running the recall');
  eq(row(giraffe, 'Made in'), 'China', '');
  eq(row(giraffe, 'Category'), 'Rattles and toy teethers', 'the category comes off the RSS item, not the page');
});

// 🪤 THE ONE A GREEN PARSE HID. splitOnContact keys on the ACCC's own <h3>Contact</h3>, and the
// sanitiser drops <h3> — so sanitising first deleted the heading before the split looked for it,
// and the Contact row vanished from every Australian page while the parse still "succeeded".
// Nothing threw. This assertion is the only thing standing between that and a live regression.
check('keeps the contact details out of the body and in the table', () => {
  has(row(giraffe, 'Contact'), 'bretpotestas@ywarehouse.com', 'without a contact row the reader has no way to claim a refund');
  hasNot(section(giraffe, 'What to do'), 'Contact</h3>', 'the contact heading belongs in the fact table, not mid-prose');
});

check('keeps the numbered consumer steps as a list', () => {
  const s = section(giraffe, 'What to do');
  has(s, '<ol>', 'the ACCC publishes ordered steps; flattening them to a paragraph loses the order');
  has(s, 'Stop using the toy immediately', '');
  eq((s.match(/<li>/g) || []).length, 4, 'all four steps must survive');
});

// ── optional fields appear only where the source has them ──────────────────────────────────
check('renders identifying features only when the notice carries them', () => {
  has(section(bike, 'How to identify it'), 'serial number', 'the bike notice has this field and it is the most useful thing on it');
  eq(section(giraffe, 'How to identify it'), undefined, 'the giraffe notice has no such field — an empty heading is a page that looks broken');
});

check('omits a units row entirely rather than inventing one', () => {
  for (const r of recs) {
    if (row(r, 'How many') !== undefined) throw new Error(`${r.slug} has a units row — the ACCC does not publish unit counts, so any number there was guessed`);
    if (r.units !== '') throw new Error(`${r.slug}: units ${JSON.stringify(r.units)}`);
    if (/\bunits\b/.test(r.desc)) throw new Error(`${r.slug}: the meta description mentions units — the ACCC publishes no count, so any number there was invented`);
  }
});

// 🪤 Found by reading a rendered page, not by a check: the US description ends "…how to get the
// remedy — from the official CPSC notice". The ACCC publishes no remedy field, so on an
// Australian page that clause promised something absent AND pushed the sentence past the 158-char
// limit, truncating every single description mid-phrase at "the remedy —…".
check('writes a description that fits and promises only what the page has', () => {
  for (const r of recs) {
    if (r.desc.length > 158) throw new Error(`${r.slug}: description is ${r.desc.length} chars — Google truncates it`);
    if (r.desc.endsWith('…')) throw new Error(`${r.slug}: description was cut mid-sentence: ${JSON.stringify(r.desc.slice(-60))}`);
    if (/how to get the remedy/.test(r.desc)) throw new Error(`${r.slug}: promises a remedy the Australian notice does not carry`);
  }
  has(giraffe.desc, 'recalled in Australia', 'the country belongs in the snippet — it is the first thing that decides whether a result is relevant');
});

// ── slugs and URLs ─────────────────────────────────────────────────────────────────────────
check('builds an ASCII slug from a non-ASCII source URL', () => {
  eq(teapot.slug, 'pokemon-pikachu-co-bolt-teapot-recall', 'a percent-encoded slug would produce an unshareable URL and a broken directory name');
});

check('every slug is URL-safe and unique', () => {
  const seen = new Set();
  for (const r of recs) {
    if (!/^[a-z0-9-]+-recall$/.test(r.slug)) throw new Error(`${r.slug} is not a clean slug`);
    if (seen.has(r.slug)) throw new Error(`duplicate slug ${r.slug} — the second page would overwrite the first on disk`);
    seen.add(r.slug);
  }
});

// ── the image ──────────────────────────────────────────────────────────────────────────────
// The page's <img> src is a Drupal derivative carrying an `itok` signature. Mirroring THAT is a
// URL that can expire; the RSS wraps the same photo in a link to the original file with no token.
check('mirrors the untokenised original image, not the signed derivative', () => {
  has(giraffe.image.src, '/system/files/Giraffe%20toy.png', 'the original file');
  hasNot(giraffe.image.src, 'itok=', 'a signed URL can stop resolving, and the hub is a photo grid — a dead image is a blank card');
  eq(giraffe.image.caption, 'Giraffe toy with dangling legs', 'the alt text is the caption and the accessible name');
  const missing = recs.filter((r) => !r.image);
  if (missing.length) throw new Error(`${missing.length} record(s) have no image — the hub is a photo-card grid and these render as gaps: ${missing.map((r) => r.slug).join(', ')}`);
});

// ── the fallback path ──────────────────────────────────────────────────────────────────────
// Only 3 of the 25 items have a captured notice page, so the other 22 exercise the real fallback:
// extract from the RSS body instead. That is the path a live fetch failure takes, and it has to
// produce a usable page rather than an empty one.
check('still produces a usable page when the notice page cannot be read', () => {
  const fallback = recs.filter((r) => ![giraffe, bike, teapot].includes(r));
  eq(fallback.length, 22, '');
  for (const r of fallback) {
    if (r.rows.length < 3) throw new Error(`${r.slug}: only ${r.rows.length} fact rows — too thin to publish`);
    if (!section(r, 'What was recalled')) throw new Error(`${r.slug}: no product description`);
    if (!section(r, 'What to do')) throw new Error(`${r.slug}: no consumer action — the single most useful thing on the page`);
  }
});

// ── the hazard phrase ──────────────────────────────────────────────────────────────────────
check('shortens the hazard without inventing wording', () => {
  eq(giraffe.hazard, 'serious injury or death from choking and asphyxiation',
    'the card, the ticker and any post use this; it must be the notice\'s own words with the conditional clause cut');
  has(row(giraffe, 'The hazard'), 'Risk of serious injury or death', 'the full sentence still appears in the fact table');
  for (const r of recs) {
    if (r.hazard.length > 90) throw new Error(`${r.slug}: hazard is ${r.hazard.length} chars — it will overflow a card`);
    if (/^risk of/i.test(r.hazard)) throw new Error(`${r.slug}: hazard still begins "Risk of", which reads wrong under a "Hazard:" label`);
  }
});

// ── amendment detection ────────────────────────────────────────────────────────────────────
// The ACCC publishes no revision date, so there is nothing to compare the way CPSC's
// LastPublishDate is compared. The hash of the notice body is the substitute, and it has to
// actually move when the body moves or /updates/ silently stops recording corrections.
check('detects an amended notice through the body hash', () => {
  const xml = auParseFeed('<item><title>T</title><link>https://x/a</link><guid>g</guid><pubDate>Wed, 12 Aug 2026 00:00:00 +0000</pubDate><description>original text</description></item>');
  const edited = auParseFeed('<item><title>T</title><link>https://x/a</link><guid>g</guid><pubDate>Wed, 12 Aug 2026 00:00:00 +0000</pubDate><description>original text, now corrected</description></item>');
  if (xml[0].hash === edited[0].hash) throw new Error('an edited notice produced the same hash — corrections would never be detected or published to /updates/');
  eq(auParseFeed('<item><description>original text</description></item>')[0].hash, xml[0].hash, 'the same body must hash the same, or every run would re-render all 25 pages and churn git');
});

// ── the withdrawal rail ────────────────────────────────────────────────────────────────────
// ⭐⭐ The single most consequential line in sources.mjs. Withdrawal detection is "in our state
// but absent from the feed". Australia's feed is a rolling 25 with no archive, so on the day we
// hold 26 Australian pages that test calls the oldest one withdrawn — and keeps going until it
// has declared the entire country withdrawn on the public corrections page.
check('declares the Australian window incomplete, so withdrawal detection stays off', () => {
  eq(SOURCES.au.completeWindow, false, 'a rolling feed cannot answer "was this withdrawn?" — flipping this to true publishes false withdrawal notices');
  eq(SOURCES.us.completeWindow, true, 'CPSC does return a complete window; turning this off would stop us noticing a real withdrawal');
});

check('every source declares the config the build reads', () => {
  for (const [ccode, s] of Object.entries(SOURCES)) {
    for (const f of ['cc', 'country', 'agency', 'agencyShort', 'noticeName', 'hubCrumb',
      'footerCredit', 'revisionKey', 'hubTitle', 'hubHeading']) {
      if (!s[f]) throw new Error(`source "${ccode}" has no ${f} — build.mjs reads it and would render "undefined" onto a live page`);
    }
    if (typeof s.completeWindow !== 'boolean') throw new Error(`source "${ccode}" must declare completeWindow explicitly, not leave it undefined`);
    if (typeof s.fetch !== 'function') throw new Error(`source "${ccode}" has no fetch()`);
    eq(s.cc, ccode, 'a source keyed under one code but declaring another writes pages to the wrong directory');
  }
});

check('the licence credit names the ACCC, because CC BY 4.0 requires it', () => {
  has(SOURCES.au.footerCredit, 'Commonwealth of Australia', 'attribution is a licence condition, not a courtesy');
  has(SOURCES.au.footerCredit, 'CC BY 4.0', '');
  has(SOURCES.au.attribution, 'creativecommons.org/licenses/by/4.0', 'the attribution has to link the licence it claims');
  hasNot(SOURCES.au.footerCredit, 'public domain', 'ACCC material is licensed, not public domain — the CPSC wording must not leak onto it');
});

// ── the sanitiser ──────────────────────────────────────────────────────────────────────────
// ACCC markup is injected into our pages as HTML. It is a government source, which is a reason to
// trust the content and no reason at all to trust it structurally: their Drupal classes, inline
// handlers and media embeds would all otherwise land inside our layout.
check('strips everything it does not explicitly allow', () => {
  const dirty = '<div class="x"><script>alert(1)</script><p onclick="x()">keep <b>this</b></p>'
    + '<img src=x onerror=y><h3>drop the heading</h3><a href="/local">rel</a>'
    + '<a href="javascript:alert(1)">bad</a></div>';
  const clean = sanitize(dirty, 'https://www.productsafety.gov.au');
  hasNot(clean, '<script', 'a script tag from any source is a script tag on our page');
  hasNot(clean, 'onclick', 'inline handlers must never survive');
  hasNot(clean, 'onerror', '');
  hasNot(clean, 'javascript:', 'a javascript: href is an XSS vector');
  hasNot(clean, 'class="x"', 'foreign classes would collide with our own stylesheet');
  hasNot(clean, '<h3', 'headings are ours to write — theirs would break the page outline');
  has(clean, '<p>keep <b>this</b></p>', 'the actual content must survive intact');
  has(clean, 'href="https://www.productsafety.gov.au/local"', 'a relative link must be absolutised or it 404s on our domain');
  has(clean, 'rel="noopener nofollow"', '');
});

check('the AU source is registered and resolvable by country code', () => {
  eq(sourceFor('au').cc, 'au', '');
  let threw = false;
  try { sourceFor('zz'); } catch { threw = true; }
  if (!threw) throw new Error('an unknown --country must fail loudly, before any fetching or writing');
});

console.log(`\n${pass} passed${fails.length ? `, ${fails.length} FAILED: ${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
