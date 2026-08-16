#!/usr/bin/env node
// StopHurting — the Canadian adapter, driven against CAPTURED BYTES.
//
// ⛔ RE-IMPLEMENTS NOTHING. It imports the real SOURCES.ca.fetch() and asserts on what comes back.
// ⛔ NEVER touches the network.
//
// ⭐ `today` IS PINNED. The adapter selects a 90-day window relative to now, and the fixtures are
// frozen bytes — so on a real clock this suite would quietly stop selecting anything about three
// months from the capture date and every count assertion would fail for a reason that has nothing
// to do with the code. A pinned date is what makes a windowed adapter testable at all.
//
// Most of what this file guards is EXCLUSION. Canada's file is the whole archive — 33,944 rows
// back to 1991, covering vehicles, drugs and medical devices — and the entire design decision is
// what we refuse to publish from it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, sourceFor, parseCsv, caPickRows } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const TODAY = '2026-08-16';   // the day the fixtures were captured — see above

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

console.log('ca adapter (captured fixtures, no network):');

const recs = await SOURCES.ca.fetch({ fixtures: FIX, today: TODAY });
const stool = recs.find((r) => r.num === '82165');

// ── what the fixture actually holds, so the exclusions below mean something ────────────────
// A suite that asserts "no vehicles came out" proves nothing if no vehicles went in.
import { readFileSync } from 'node:fs';
const raw = parseCsv(readFileSync(path.join(FIX, 'ca-recalls.csv'), 'utf8'));
const head = raw[0];
const ORG = head.indexOf('Organization');
const orgs = {};
for (const r of raw.slice(1)) orgs[r[ORG]] = (orgs[r[ORG]] || 0) + 1;

check('the fixture contains the lanes we exclude, or the exclusion tests are vacuous', () => {
  if (!orgs.TC) throw new Error('no Transport Canada rows in the fixture — the vehicle exclusion below would pass trivially');
  if (!orgs['Medical devices']) throw new Error('no medical device rows in the fixture — the health exclusion below would pass trivially');
  if (!orgs['Consumer product safety']) throw new Error('no consumer product rows — nothing to publish');
});

// ── the lane decision ──────────────────────────────────────────────────────────────────────
check('publishes consumer products and food, and nothing else', () => {
  const issuers = [...new Set(recs.map((r) => row(r, 'Issued by')))].sort();
  eq(issuers.join(' | '),
    'Canadian Food Inspection Agency | Health Canada — Consumer Product Safety',
    'any other issuer here means a lane was let through that was deliberately excluded');
});

// ⛔ 166 vehicle recalls in 90 days, ZERO with an action field, titles like "Transport Canada
// Recall - 2022550 - VOLVO". Publishing them is a scaled-thin-content generator on a site that
// has already been refused by AdSense once.
check('excludes Transport Canada vehicle recalls', () => {
  const leaked = recs.filter((r) => /Transport Canada Recall/i.test(r.prod) || /Transport Canada/i.test(row(r, 'Issued by') || ''));
  if (leaked.length) throw new Error(`${leaked.length} vehicle recall(s) leaked through: ${leaked.slice(0, 3).map((r) => r.prod).join(', ')}`);
});

// ⛔ Drugs and medical devices are YMYL, where an unknown domain does not rank, and this site
// deliberately does not lean health. Excluded on strategy, and while AdSense is mid-recrawl.
check('excludes drugs, medical devices and natural health products', () => {
  const leaked = recs.filter((r) => /Medical devices|Drugs and health|Marketed health|Controlled substances/i.test(row(r, 'Issued by') || ''));
  if (leaked.length) throw new Error(`${leaked.length} health recall(s) leaked through`);
});

check('drops food recalls that cannot say what to do', () => {
  const food = recs.filter((r) => row(r, 'Issued by') === 'Canadian Food Inspection Agency');
  if (!food.length) throw new Error('no food recalls at all — the lane is meant to ship, just filtered');
  for (const r of food) {
    if (!section(r, 'What to do')) throw new Error(`${r.slug}: a food recall with no action — half a page on an answer-first site`);
  }
});

// ⭐ THIS ONE NEEDS ITS OWN PINNED DATE, and the reason is a fact about Canada worth keeping:
// notices are archived YEARS after publication — the newest archived row in the whole 33,944-row
// file is months older than the 90-day window, and inside any recent window the archived count is
// exactly zero. So against recent data the archived filter is unreachable, and a test over recent
// rows passes without ever exercising it. The first version of this check said so out loud and
// failed itself as vacuous, which is the only reason this is here.
// The fixture therefore carries real 2023 rows — one archived, two not — and this test winds the
// clock back so all three sit inside the window. Then the ONLY thing separating them is the
// archived flag.
check('drops archived notices', () => {
  const A = head.indexOf('Archived');
  const NID = head.indexOf('NID');
  const csv = readFileSync(path.join(FIX, 'ca-recalls.csv'), 'utf8');
  const then = caPickRows(csv, '2023-10-15');
  const archived = new Set(raw.slice(1).filter((r) => r[A] === '1').map((r) => r[NID]));
  if (!archived.size) throw new Error('no archived rows in the fixture — this test would be vacuous');
  if (!then.length) throw new Error('the wound-back window selected nothing — the 2023 rows are missing from the fixture');
  const survivors = new Set(then.map((r) => r.nid));
  for (const id of archived) {
    if (survivors.has(id)) throw new Error(`archived notice ${id} was published`);
  }
  // and prove the window itself was open, or "nothing archived got through" means nothing
  if (![...survivors].some((id) => raw.slice(1).some((r) => r[NID] === id && r[A] !== '1'))) {
    throw new Error('no non-archived 2023 row survived either — the window, not the archived flag, did the filtering');
  }
  // the recent build must be unaffected by those rows
  const leaked = recs.filter((r) => archived.has(r.num));
  if (leaked.length) throw new Error(`${leaked.length} archived notice(s) in the live selection`);
});

check('respects the 90-day window', () => {
  const cutoff = '2026-05-18';
  for (const r of recs) {
    if (r.date < cutoff) throw new Error(`${r.slug} is dated ${r.date}, outside the ${cutoff}+ window`);
  }
});

// ── record quality ─────────────────────────────────────────────────────────────────────────
check('every record has what a page and a card need', () => {
  for (const r of recs) {
    if (!r.id.startsWith('ca-')) throw new Error(`${r.slug}: id ${r.id} — a bare numeric id risks colliding with a CPSC RecallID in shared state`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`${r.slug}: date ${r.date} is not an ISO day`);
    if (!r.prod) throw new Error(`${r.id}: no product name`);
    if (!r.hazard) throw new Error(`${r.slug}: no hazard`);
    if (r.country !== 'ca') throw new Error(`${r.slug}: country ${r.country} — lands on the wrong hub`);
    if (!r.url.startsWith('https://recalls-rappels.canada.ca/')) throw new Error(`${r.slug}: source link is ${r.url}`);
    if (!/^[a-z0-9-]+-recall-\d+$/.test(r.slug)) throw new Error(`${r.slug} is not a clean slug`);
  }
  eq(new Set(recs.map((r) => r.slug)).size, recs.length, 'duplicate slugs would overwrite each other on disk');
});

check('writes a description that fits and never claims a unit count', () => {
  for (const r of recs) {
    if (r.desc.length > 158) throw new Error(`${r.slug}: description is ${r.desc.length} chars`);
    if (r.desc.endsWith('…')) throw new Error(`${r.slug}: description cut mid-sentence`);
    if (/\bunits\b/.test(r.desc)) throw new Error(`${r.slug}: mentions units — the CSV carries no count`);
    if (r.units !== '') throw new Error(`${r.slug}: units ${JSON.stringify(r.units)}`);
  }
  has(recs[0].desc, 'recalled in Canada', 'the country belongs in the snippet');
});

// 🪤 CAUGHT BY READING A RENDERED PAGE, not by any check. The CSV's `Issue` column is not
// reliably a hazard — the Cosyland step stool, a tip-over and entrapment recall, carries Issue
// "Consumer products", so the page said "The hazard: Consumer products" and the dek was the
// sentence "Consumer products." 14 of the 96 selected rows have an Issue like that.
check('takes the hazard from the notice title, not the unreliable Issue column', () => {
  const junk = /^(consumer products|unauthorized products|labelling and packaging)$/i;
  for (const r of recs) {
    if (junk.test(r.hazard)) throw new Error(`${r.slug}: hazard is ${JSON.stringify(r.hazard)} — that is a category label, not a hazard`);
    if (!r.hazard || r.hazard.length > 90) throw new Error(`${r.slug}: hazard ${JSON.stringify(r.hazard)}`);
  }
  eq(stool.hazard, 'fall and entrapment hazards',
    'the step stool is the row that exposed this — its Issue column says "Consumer products"');
  // and the fallback still works for notices phrased as a warning rather than a recall
  const warns = recs.filter((r) => !/recalled[\s​]*due to/i.test(r.prod) && /hazard/i.test(r.hazard));
  if (!warns.length) throw new Error('no row exercised the Issue fallback — it may be dead code');
});

// ── the notice page ────────────────────────────────────────────────────────────────────────
check('lifts the long-form fields off the notice page', () => {
  if (!stool) throw new Error('the captured notice page (NID 82165) did not survive selection');
  eq(row(stool, 'Brand'), 'Cosyland', '');
  has(row(stool, 'Who it affects'), 'Children', 'who a recall affects is the first thing a parent needs');
  has(section(stool, 'What was recalled'), 'model #CS0003', 'the model number is the query people type');
  has(section(stool, 'Why it was recalled'), 'collapse or tip over', '');
  has(section(stool, 'What to do'), 'stop using', '');
  has(section(stool, 'Background'), '18 units', 'the background block carries how many were sold and where');
});

// 🪤🪤 THE ONE THAT WOULD HAVE SHIPPED SILENTLY. Canada lazy-loads images: the real photo is in
// `data-src`, while `src` holds an inline SVG spacer. Reading `src` — the obvious attribute —
// mirrors a BLANK PLACEHOLDER onto a photo-led hub, and every "does it have an image" check still
// passes. Then, separately, the same itok-derivative trap Australia had.
check('takes the photo from data-src, not the placeholder in src', () => {
  if (!stool.image) throw new Error('no image — Canada lazy-loads, so the photo is in data-src');
  hasNot(stool.image.src, 'data:', 'an inline SVG spacer would render as a blank card that passes every check');
  hasNot(stool.image.src, 'itok=', 'a signed derivative URL can stop resolving');
  hasNot(stool.image.src, '/styles/', 'mirror the original, not the resized derivative');
  has(stool.image.src, '/sites/default/files/alert/recall/82165/', '');
  eq(stool.image.caption, 'Front of product', 'the alt text is the caption and the accessible name');
});

// ── config the build reads ─────────────────────────────────────────────────────────────────
check('declares the config build.mjs reads', () => {
  const s = SOURCES.ca;
  for (const f of ['cc', 'country', 'countryIn', 'agency', 'agencyShort', 'noticeName', 'hubCrumb',
    'footerCredit', 'revisionKey', 'hubTitle', 'hubHeading']) {
    if (!s[f]) throw new Error(`source "ca" has no ${f} — build.mjs would render "undefined" onto a live page`);
  }
  eq(typeof s.completeWindow, 'boolean', 'completeWindow must be declared explicitly');
  eq(sourceFor('ca').cc, 'ca', '');
});

// ⭐ False for a DIFFERENT reason than Australia's, and the difference is worth keeping straight:
// Canada's file IS the complete archive. It is this ADAPTER that narrows it to two lanes inside a
// 90-day window — so "absent from what we returned" describes our own filter. With this true,
// every Canadian recall would be published as withdrawn on the corrections page the day it aged
// past 90 days.
check('declares its window incomplete, because the adapter itself filters', () => {
  eq(SOURCES.ca.completeWindow, false,
    'the adapter returns two lanes of a 90-day slice, so absence from it says nothing about withdrawal');
});

check('credits the Open Government Licence, which requires attribution', () => {
  has(SOURCES.ca.footerCredit, 'Open Government Licence', 'attribution is a licence condition');
  has(SOURCES.ca.attribution, 'open.canada.ca/en/open-government-licence-canada', 'the attribution must link the licence it claims');
  hasNot(SOURCES.ca.footerCredit, 'public domain', 'Canadian material is licensed, not public domain');
  // The OGL forbids using federal logos or official symbols, and forbids implying endorsement.
  hasNot(JSON.stringify(SOURCES.ca), 'Government of Canada logo', '');
});

// ── the CSV parser ─────────────────────────────────────────────────────────────────────────
// The Canadian file uses quoted fields containing commas, doubled quotes and newlines. A
// split(',') parser does not fail on those — it shreds rows into the wrong columns and carries on.
check('parses quoted CSV fields rather than shredding them', () => {
  const rows = parseCsv('a,b,c\n1,"has, comma","say ""hi"""\n2,"multi\nline",z\n');
  eq(rows.length, 3, '');
  eq(rows[1][1], 'has, comma', 'a comma inside quotes must not split the field');
  eq(rows[1][2], 'say "hi"', 'a doubled quote is one literal quote');
  eq(rows[2][1], 'multi\nline', 'a newline inside quotes must not end the row');
});

// ⭐ A renamed column is the most likely way this quietly breaks: every row would still parse,
// every field would be blank, and 96 empty pages would publish without a single error. It has to
// abort the run instead — and this drives the REAL picker to prove it does.
check('aborts when the CSV header changes instead of publishing blank pages', () => {
  const good = 'NID,Title,URL,Organization,Product,Issue,What you should do,Category,Recall class,Last updated,Archived\n'
    + '1,t,https://recalls-rappels.canada.ca/x,Consumer product safety,Widget,Fall hazard,Stop using it,Tools,,2026-08-01,0\n';
  eq(caPickRows(good, TODAY).length, 1, 'the control case must be accepted, or the test below proves nothing');

  const renamed = good.replace('What you should do', 'Consumer action');
  let threw = false;
  try { caPickRows(renamed, TODAY); } catch { threw = true; }
  if (!threw) throw new Error('a renamed column must abort the run, not yield records with blank fields');
});

console.log(`\n${pass} passed${fails.length ? `, ${fails.length} FAILED: ${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
