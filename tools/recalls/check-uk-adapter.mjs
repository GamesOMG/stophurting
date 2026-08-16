#!/usr/bin/env node
// StopHurting — the UK adapter, driven against CAPTURED BYTES.
//
// ⛔ RE-IMPLEMENTS NOTHING; imports the real SOURCES.uk.fetch(). ⛔ NEVER touches the network.
// ⭐ `today` is PINNED, like Canada's: the adapter selects a 90-day window relative to now, and
// the fixtures are frozen, so on a real clock every count assertion here would eventually fail
// for a reason that has nothing to do with the code.
//
// The thing this file mostly guards is a CLAIM OF ACCURACY. gov.uk publishes recalls, safety
// reports and safety alerts through one endpoint, and 1,160 of the reports are goods stopped at
// the border that no consumer ever received. Our pages are titled "<product> Recall".

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCES, sourceFor, ukToCanonical } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const TODAY = '2026-08-16';

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
  if (!String(hay).includes(needle)) throw new Error(`${why}\n     missing ${JSON.stringify(needle)}`);
};
const hasNot = (hay, needle, why) => {
  if (String(hay).includes(needle)) throw new Error(`${why}\n     found ${JSON.stringify(needle)}`);
};
const row = (rec, label) => (rec.rows.find(([k]) => k === label) || [])[1];
const section = (rec, h2) => (rec.sections.find((s) => s.h2 === h2) || {}).html;

console.log('uk adapter (captured fixtures, no network):');

const recs = await SOURCES.uk.fetch({ fixtures: FIX, today: TODAY });
const balloons = recs.find((r) => r.num === '2608-0108');

check('reads the captured window', () => {
  if (recs.length < 3) throw new Error(`only ${recs.length} record(s) — the three captured notice documents should all survive selection`);
  if (!balloons) throw new Error('the Eurowrap balloons notice (2608-0108) did not come through');
});

check('respects the 90-day window', () => {
  const cutoff = '2026-05-18';
  for (const r of recs) if (r.date < cutoff) throw new Error(`${r.slug} is dated ${r.date}, outside the window`);
});

// ── the accuracy decision ──────────────────────────────────────────────────────────────────
// ⛔ Measured 2026-08-16 via the API's own filter: product-recall 1,540 · product-safety-report
// 2,076 (of which 1,160 import-rejected-at-border) · product-safety-alert 8. A page headed
// "<product> Recall" about goods stopped at the frontier is simply false.
check('asks the API only for recalls and alerts, never safety reports', () => {
  const src = SOURCES.uk.fetch.toString();
  has(src, 'UK_TYPES', 'the alert-type filter must be applied in the query, not by filtering titles afterwards');
  const types = readFileSync(path.join(HERE, 'sources.mjs'), 'utf8')
    .match(/const UK_TYPES = \[([^\]]*)\]/)[1];
  has(types, 'product-recall', '');
  hasNot(types, 'product-safety-report', 'safety reports include 1,160 border rejections that never reached a consumer');
});

check('never publishes a notice it could not read', () => {
  const src = SOURCES.uk.fetch.toString();
  has(src, 'if (!doc) continue', 'a failed content-API fetch must skip the notice, not emit a record with blank fields');
});

// ── record quality ─────────────────────────────────────────────────────────────────────────
check('every record has what a page and a card need', () => {
  for (const r of recs) {
    if (!r.id.startsWith('uk-')) throw new Error(`${r.slug}: id ${r.id} could collide with another country's key in shared state`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`${r.slug}: date ${r.date} is not an ISO day`);
    if (!r.prod) throw new Error(`${r.id}: no product name`);
    if (!r.hazard) throw new Error(`${r.slug}: no hazard`);
    if (r.country !== 'uk') throw new Error(`${r.slug}: country ${r.country}`);
    if (!r.url.startsWith('https://www.gov.uk/')) throw new Error(`${r.slug}: source link is ${r.url}`);
    if (!/^[a-z0-9-]+$/.test(r.slug)) throw new Error(`${r.slug} is not a clean slug`);
  }
  eq(new Set(recs.map((r) => r.slug)).size, recs.length, 'duplicate slugs would overwrite each other on disk');
});

check('strips the notice prefix and reference from the product name', () => {
  eq(balloons.prod, 'Eurowrap 25pk Blue Party Balloons',
    'the raw title is "Product Recall: Eurowrap 25pk Blue Party Balloons (2608-0108)" — neither the prefix nor the reference belongs in an h1');
  eq(balloons.num, '2608-0108', 'the reference is a real identifier and belongs in the fact table');
  has(balloons.slug, 'recall-2608-0108', '');
});

check('lifts the product information table', () => {
  eq(row(balloons, 'Brand'), 'Eurowrap', '');
  eq(row(balloons, 'Batch / lot'), '5330002193', 'batch numbers are what a reader checks against the thing in their hand');
  eq(row(balloons, 'SKU / product code'), '12924-BCC', '');
  eq(row(balloons, 'Made in'), 'China', '');
  has(row(balloons, 'Product type'), 'Toys', '');
  eq(row(balloons, 'Risk level'), 'Serious', 'OPSS grades every notice; the grade is genuinely useful and is theirs, not ours');
  eq(row(balloons, 'Issued by'), 'Office for Product Safety and Standards', '');
});

check('builds the three body sections from the publisher\'s own headings', () => {
  has(section(balloons, 'What was recalled'), 'Pack of 25 party balloons', '');
  has(section(balloons, 'Why it was recalled'), 'N-nitrosamines', 'the hazard section carries the actual chemistry');
  has(section(balloons, 'What to do'), 'full refund', 'the corrective action is the single most useful thing on the page');
});

// OPSS phrases every hazard "The product presents a serious chemical risk because …". Left alone,
// every card in the country would open with the same four words.
check('shortens the hazard without inventing wording', () => {
  eq(balloons.hazard, 'serious chemical risk',
    'their stock opening is stripped and the sentence cut at "because" — their words, fewer of them');
  has(row(balloons, 'The hazard'), 'N-nitrosamines', 'the full sentence still appears in the fact table');
  for (const r of recs) {
    if (r.hazard.length > 90) throw new Error(`${r.slug}: hazard is ${r.hazard.length} chars and will overflow a card`);
    if (/^the product presents/i.test(r.hazard)) throw new Error(`${r.slug}: hazard still carries the stock opening`);
  }
});

check('writes a description that fits and never claims a unit count', () => {
  for (const r of recs) {
    if (r.desc.length > 158) throw new Error(`${r.slug}: description is ${r.desc.length} chars`);
    if (r.desc.endsWith('…')) throw new Error(`${r.slug}: description cut mid-sentence`);
    if (/\bunits\b/.test(r.desc)) throw new Error(`${r.slug}: mentions units — OPSS publishes no count`);
  }
  has(balloons.desc, 'recalled in the UK', 'the country belongs in the snippet');
});

// ── the missing photograph ─────────────────────────────────────────────────────────────────
// ⭐⭐ Measured across 12 consecutive notices: zero inline images, one PDF attachment titled
// "Link to Product Image and PDF". The photograph exists only inside that PDF. Rendering a PDF
// page would produce a picture of a DOCUMENT, not the product — worse than admitting we have
// none — so the hub gives these a typographic tile carrying the category.
check('reports no image rather than inventing one, and supplies a category for the tile', () => {
  for (const r of recs) {
    if (r.image) throw new Error(`${r.slug}: claims an image — OPSS publishes the photo only inside a PDF`);
    if (!r.cat) throw new Error(`${r.slug}: no category, so its card tile would be blank`);
  }
  eq(balloons.cat, 'Toys', 'the category is the one thing that answers "what kind of thing is this" without a photo');
});

// ⭐⭐ THE SHARE CARD FOR A SOURCE WITH NO PHOTOGRAPH. Jason, comparing two live Facebook posts:
// "the uk card looks weak, the us one looks nice." A US post shows the recalled product; a UK post
// showed a grey rectangle, because OPSS publishes photographs only inside PDFs. So imageless
// recalls get a generated, branded card — used as the og:image ONLY.
// ⛔ IT MUST NEVER BECOME A PRODUCT PHOTO. It does not depict the item, so it must not appear as
// the page's figure or as a hub thumbnail, where a reader would take it for one. The hub keeps
// the typographic tile it already had.
check('generates a share card for UK recalls and uses it only as the og:image', () => {
  const root = path.join(HERE, '..', '..');
  const slug = 'eurowrap-25pk-blue-party-balloons-recall-2608-0108';
  const page = readFileSync(path.join(root, 'uk', 'recalls', slug, 'index.html'), 'utf8');
  has(page, `og:image" content="https://stophurting.org/assets/img/recalls/${slug}/card.webp`,
    'a UK post with no og:image is a grey rectangle in a feed');
  // the card must NOT be rendered into the page body as though it were a photo of the product
  hasNot(page, `<img src="/assets/img/recalls/${slug}/card.webp`,
    'the generated card is typography, not a photograph — showing it as the product figure would be inventing evidence');
  const hub = readFileSync(path.join(root, 'uk', 'recalls', 'index.html'), 'utf8');
  hasNot(hub, 'card.webp', 'the hub keeps its typographic tile; a 1200x630 banner letterboxed into a thumbnail is worse');
});

// ── config ─────────────────────────────────────────────────────────────────────────────────
check('declares the config build.mjs reads', () => {
  const s = SOURCES.uk;
  for (const f of ['cc', 'country', 'countryIn', 'agency', 'agencyShort', 'noticeName', 'hubCrumb',
    'footerCredit', 'revisionKey', 'hubTitle', 'hubHeading']) {
    if (!s[f]) throw new Error(`source "uk" has no ${f} — build.mjs would render "undefined" onto a live page`);
  }
  eq(sourceFor('uk').cc, 'uk', '');
});

// ⚠ False for the CANADIAN reason, not the Australian one — gov.uk holds the whole archive, and
// it is our own type-and-window filter that makes absence meaningless. The build prints this
// reason, so it has to be the source's own words.
check('states its own reason for disabling withdrawal detection', () => {
  eq(SOURCES.uk.completeWindow, false, '');
  has(SOURCES.uk.windowNote, 'our own filter', 'the reason must describe OUR filtering, not a missing archive');
  hasNot(SOURCES.uk.windowNote, 'no archive', 'gov.uk HAS an archive — that is Australia\'s reason, and printing it here is a small lie');
});

check('credits the Open Government Licence v3.0, which requires attribution', () => {
  has(SOURCES.uk.footerCredit, 'Open Government Licence', 'attribution is a licence condition');
  has(SOURCES.uk.attribution, 'nationalarchives.gov.uk/doc/open-government-licence/version/3', 'the attribution must link the licence it claims');
  has(SOURCES.uk.attribution, 'Contains public sector information', 'the OGL specifies this exact wording');
  hasNot(SOURCES.uk.footerCredit, 'public domain', 'UK material is licensed, not public domain');
});

// ⭐⭐ ATTRIBUTION IS A CONDITION, AND TWO OF THESE LICENCES END IF IT IS NOT MET. Jason read the
// OGL text and asked whether we actually comply; we did not, fully. The statements were on recall
// PAGES only, while the hubs, the homepage, the 404 and the search index use the Information too.
// Both OGL v3.0 and CC BY 4.0 allow one linked resource in place of inline statements when
// several providers are involved, so /licensing/ carries the exact wording each requires and the
// site-wide footer links to it.
// ⛔ These assertions read the BUILT page, so a broken generator or a hand-edit is caught too.
check('the licensing page carries the exact statement each licence requires', () => {
  const lic = readFileSync(path.join(HERE, '..', '..', 'licensing', 'index.html'), 'utf8');
  has(lic, 'Contains public sector information licensed under the', 'the wording OGL v3.0 specifies for the UK');
  has(lic, 'nationalarchives.gov.uk/doc/open-government-licence/version/3', 'OGL v3.0 asks for a link to the licence where possible');
  has(lic, 'Contains information licensed under the', 'the wording OGL-Canada specifies');
  has(lic, 'Source: ACCC © Commonwealth of Australia', 'the wording the ACCC specifies for CC BY 4.0');
  has(lic, 'creativecommons.org/licenses/by/4.0', '');
  // Non-endorsement is its own clause in both OGLs, and worth stating rather than merely avoiding.
  has(lic, 'not a government body', 'both OGLs forbid implying official status or endorsement');
  has(lic, 'crest', 'logos, crests and the Royal Arms are excluded from the licence — say that we use none');
  for (const c of ['us', 'au', 'ca', 'uk']) {
    has(lic, SOURCES[c].agency, `${c}: every source must be named on the licensing page`);
  }
});

check('every page links to the attribution, because every page uses the data', () => {
  const root = path.join(HERE, '..', '..');
  for (const f of ['index.html', 'uk/recalls/index.html', 'ca/recalls/index.html', '404.html',
    'uk/recalls/eurowrap-25pk-blue-party-balloons-recall-2608-0108/index.html']) {
    const html = readFileSync(path.join(root, f), 'utf8');
    has(html, 'href="/licensing/"', `${f} uses licensed Information and must reach the attribution from it`);
    hasNot(html, 'UK recall data licensed under', `${f} still carries the old paraphrase, which is not the specified statement and had no link`);
  }
});

// ── the parser, against a document it should refuse to guess at ────────────────────────────
check('omits rows the notice does not carry instead of inventing them', () => {
  const bare = ukToCanonical(
    { title: 'Product Recall: Nothing Much (1234-0001)', link: '/x/y', public_timestamp: '2026-08-01T00:00:00Z' },
    { title: 'Product Recall: Nothing Much (1234-0001)', base_path: '/x/y', details: { body: '<h2 id="summary">Summary</h2><p>Product: Nothing Much</p>', metadata: {} } },
  );
  eq(row(bare, 'Brand'), undefined, 'no brand in the notice means no brand row');
  eq(row(bare, 'Batch / lot'), undefined, '');
  eq(row(bare, 'Risk level'), undefined, 'OPSS marks some notices "not-provided"; that is not a risk level');
  eq(bare.prod, 'Nothing Much', '');
  if (!row(bare, 'Recall date')) throw new Error('the date row must always be present');
});

console.log(`\n${pass} passed${fails.length ? `, ${fails.length} FAILED: ${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
