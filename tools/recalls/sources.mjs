// StopHurting — one adapter per national recall regulator.
//
// build.mjs used to BE the CPSC adapter: it read `rec.Hazards[0].Name` inline, assumed a
// `RecallNumber`, and assumed the feed always returned a complete window. Adding Australia to
// that shape would have meant handing the templates a fake CPSC record, which is the stub trap —
// a fake only disagrees with the real thing on inputs nobody wrote a fixture for.
//
// So each source now returns CANONICAL records and declares its own behaviour. The templates
// read canonical fields and nothing else. The next country is a config value plus a fetch().
//
// ⭐⭐ `completeWindow` IS NOT TIDINESS. Withdrawal detection in build.mjs is "in our state but
// absent from the feed", which is only meaningful when the feed returns EVERY recall in the
// window asked for. CPSC does. Australia's RSS is a rolling 25 items with no archive of any
// kind — against it, "absent from the feed" is true of the entire archive on every single run,
// so the check would report the whole site withdrawn. It is declared off, per source, here.
//
// ⛔ NO AI IN THE LOOP, unchanged. Every field is extracted from the regulator's own record. A
// field we cannot extract is OMITTED — never inferred, never filled from a sibling field.

import { load as loadFixture } from './fixtures-loader.mjs';

// ---------- shared text helpers ----------
export const isoDay = (s) => String(s || '').slice(0, 10);
export const clamp = (s, n) => { s = String(s ?? '').trim(); return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'; };
export const slugify = (s) => String(s).toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .split('-').slice(0, 8).join('-');
// ⚠ Deaccent is applied ONLY on the Australian path. slugify() is shared with the 134 published
// US pages, and a slug change there is a dead URL — the one cost this site cannot absorb at DR 0.
const deaccent = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

const decodeEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// A tiny allowlist sanitiser. The ACCC's "what consumers should do" is a real ordered list and
// rendering it as one paragraph loses the steps, so the markup has to survive — but only this
// much of it, and only with href on a link. Everything else, including every class, id, style,
// event handler and embedded media, is dropped rather than trusted.
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a']);
export function sanitize(html, baseUrl = '') {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (whole, tag, attrs) => {
      const t = tag.toLowerCase();
      if (!ALLOWED.has(t)) return ' ';
      if (whole.startsWith('</')) return `</${t}>`;
      if (t !== 'a') return `<${t}>`;
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1];
      if (!href || /^\s*javascript:/i.test(href)) return '<a>';
      const abs = /^https?:\/\//i.test(href) ? href : (href.startsWith('/') && baseUrl ? baseUrl + href : '');
      return abs ? `<a href="${abs.replace(/"/g, '&quot;')}" target="_blank" rel="noopener nofollow">` : '<a>';
    })
    .replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// ---------- Drupal field extraction (Australia) ----------
// The ACCC runs Drupal, so every value on a recall notice sits in a div whose class names it:
//   <div class="field field--name-field-psa-recall-traders …"><h3 …>Who sold …</h3>
//     <div class="field__item"><p>Nevenka, Woolworths</p></div></div>
// Those divs NEST, so "match to the next </div>" truncates. This walks the tag depth instead,
// which is exact rather than nearly-right.
function elementAt(html, idx) {
  const open = html.lastIndexOf('<div', idx);
  if (open < 0) return '';
  let depth = 0;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = open;
  for (let m; (m = re.exec(html));) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return '';
}
function fieldRaw(html, name) {
  const idx = html.indexOf(`field--name-${name}`);
  return idx < 0 ? '' : elementAt(html, idx);
}
// The label is chrome — we write our own labels — so it never reaches a page.
const dropLabel = (block) => block.replace(/<h[23][^>]*class="[^"]*field__label[^"]*"[^>]*>[\s\S]*?<\/h[23]>/gi, '');
function fieldText(html, name) {
  const block = dropLabel(fieldRaw(html, name));
  if (!block) return '';
  // ⚠ `\bfield__item\b` deliberately, not `field__item`: the WRAPPER of a multi-value field is
  // class="field__items", and a loose match picks up the wrapper as well as each value — which
  // reads fine on a two-value field (the duplicate dedupes away) and silently doubles a
  // one-value field the day one appears. Match the class, not a prefix of it.
  const values = [...block.matchAll(/<div[^>]*class="[^"]*\bfield__item\b[^"]*"[^>]*>/g)]
    .map((m) => stripTags(elementAt(block, m.index)))
    .filter(Boolean);
  return [...new Set(values)].join(' · ') || stripTags(block);
}
// Raw (unsanitised) inner markup. Only for callers that must split on structure the sanitiser
// removes — see splitOnContact, which keys on the ACCC's own <h3>Contact</h3>. Everything that
// reaches a page goes through sanitize() afterwards; nothing renders raw.
function fieldInner(html, name) {
  const block = dropLabel(fieldRaw(html, name));
  return block ? block.replace(/^<div\b[^>]*>/i, '').replace(/<\/div>\s*$/i, '') : '';
}
function fieldHtml(html, name, baseUrl) {
  const inner = fieldInner(html, name);
  return inner ? sanitize(inner, baseUrl) : '';
}

// ---------- source: United States ----------
// Unchanged behaviour, moved verbatim from build.mjs. The 134 published US pages must render
// byte-for-byte the same after this refactor, and that is asserted by rebuilding and diffing —
// a refactor that quietly reworded a live page is a regression wearing a tidy-up's clothes.
function usProductName(rec) {
  let t = String(rec.Title).split(/\s+(?:Due to|Because)\b/i)[0].split(/;|—/)[0];
  t = t.replace(/\s+Recall(?:s|ed)?\b/i, ' ').replace(/\s+/g, ' ').trim();
  if (t.split(' ').length <= 1) {
    const brand = (rec.Manufacturers?.[0]?.Name || rec.Importers?.[0]?.Name || '').split(',')[0].trim();
    if (brand && !t.toLowerCase().includes(brand.toLowerCase())) t = `${brand} ${t}`.trim();
  }
  return t;
}
function usHazardShort(rec) {
  const m = String(rec.Title).match(/Due to (?:Serious )?(?:Risk of )?(.*?)(?:;|$)/i);
  if (m) return m[1].replace(/\s*Hazards?\s*$/i, ' hazard').trim();
  const h = rec.Hazards?.[0]?.Name || '';
  return clamp(h, 80) || 'safety hazard';
}
// 🪤 CPSC's NumberOfUnits usually ALREADY reads "About 213,500". Every caller adds its own
// "About", which shipped "About About 213,500 units" onto 121 of 134 pages — invisible to every
// check we have, caught only by reading a rendered page.
function usUnits(rec) {
  return (rec.Products || []).map((p) => p.NumberOfUnits).filter(Boolean)
    .map((u) => String(u).replace(/^\s*(about|approx\.?|approximately)\s+/i, '').trim())
    .filter(Boolean).join(' + ') || '';
}
function usToCanonical(rec) {
  const prod = usProductName(rec);
  const hazard = usHazardShort(rec);
  const units = usUnits(rec);
  const remedy = (rec.RemedyOptions || []).map((r) => r.Name).filter(Boolean).join(' / ')
    || (rec.Remedies || []).map((r) => r.Name).filter(Boolean).join(' / ');
  const sold = (rec.Retailers || []).map((x) => x.Name).filter(Boolean).join(' · ') || rec.SoldAtLabel || '';
  const date = isoDay(rec.RecallDate);
  return {
    id: String(rec.RecallID),
    country: 'us',
    slug: `${slugify(prod)}-recall-${rec.RecallNumber}`,
    num: rec.RecallNumber,
    date,
    modified: isoDay(rec.LastPublishDate),
    prod,
    hazard,
    units,
    url: rec.URL,
    contact: rec.ConsumerContact || '',
    models: [
      ...(rec.Products || []).map((p) => p.Model).filter(Boolean),
      ...(rec.ProductUPCs || []).map((u) => (typeof u === 'string' ? u : u?.UPC)).filter(Boolean),
    ].join(' '),
    image: rec.Images?.[0]?.URL ? { src: rec.Images[0].URL, caption: rec.Images[0].Caption || '' } : null,
    rows: [
      ['What', prod],
      units && ['How many', `About ${units} units`],
      ['The hazard', rec.Hazards?.[0]?.Name || hazard],
      sold && ['Sold at', sold],
      remedy && ['Remedy', remedy],
      rec.ConsumerContact && ['Contact', rec.ConsumerContact],
      ['Recall date', date + ` (recall no. ${rec.RecallNumber})`],
    ].filter(Boolean),
    sections: [
      { h2: 'What was recalled', html: `<p>${escText(rec.Description)}</p>` },
      remedy && {
        h2: 'What to do',
        html: `<p>Stop using the product. The listed remedy is: <strong>${escText(remedy)}</strong>. ${escText(rec.ConsumerContact || '')}</p>`,
      },
    ].filter(Boolean),
    // ⚠ The clamp lands on the HAZARD ALONE, before the unit count is appended — that is how the
    // 134 published pages read, and moving it to the combined string silently rewrites the dek of
    // every long-hazard page. Preserved deliberately, not inherited by accident.
    dek: `${clamp(hazard.charAt(0).toUpperCase() + hazard.slice(1), 160)}${units ? ` — about ${units} units.` : '.'}`,
    desc: clamp(`${prod} recalled${units ? ` (about ${units} units)` : ''}: ${hazard}. What was sold, what to do, and how to get the ${remedy ? remedy.toLowerCase() : 'remedy'} — from the official CPSC notice.`, 158),
  };
}
const escText = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- source: Australia ----------
const AU_BASE = 'https://www.productsafety.gov.au';

// Pick the longest description that fits the limit whole, dropping a CLAUSE at a time rather
// than cutting mid-word. Australian product names run long ("Essex Maxim and Sierra electric
// recliners and sofas") and their hazards are full sentences, so a single template plus clamp()
// truncated the snippet at "…and wha…" — which reads as a broken page in a search result. The
// last candidate is short by construction, so there is always something whole to return.
function fits(limit, candidates) {
  return candidates.find((c) => c.length <= limit) || clamp(candidates[candidates.length - 1], limit);
}

// Their hazard field is a full sentence — "Risk of serious injury or death from choking and
// asphyxiation if a child places the silicone pull strings in their mouth." A card, a ticker and
// a Facebook post all need a phrase. Take the leading clause and stop at the conditional; do not
// summarise, because summarising is the thing we promised not to do.
function auHazardShort(full) {
  let s = String(full).trim().replace(/^(?:There is a\s+)?[Rr]isk of\s+/, '');
  s = s.split(/\s+if\s+|\.\s|;\s/)[0].trim().replace(/[.,]$/, '');
  return clamp(s, 90) || 'safety hazard';
}

export function auParseFeed(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    const pick = (tag) => (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    const description = decodeEntities(pick('description'));
    const link = stripTags(pick('link'));
    return {
      id: stripTags(pick('guid')),
      title: stripTags(pick('title')),
      link,
      pubDate: pick('pubDate'),
      categories: [...it.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => stripTags(c[1])),
      description,
      // ⭐ AMENDMENT DETECTION WITHOUT A REVISION FIELD. The ACCC publishes no "last modified"
      // date, so the CPSC approach has nothing to compare. But the RSS carries the whole notice
      // body, so a hash of it detects ANY edit — a corrected hazard, an added model, a changed
      // remedy — which is strictly more than a date would have caught.
      hash: cheapHash(description),
    };
  });
}
// Not cryptography — a change detector. Two different notice bodies colliding here would mean a
// missed correction, which is why it folds in the length as well as the characters.
function cheapHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length.toString(36)}-${h.toString(36)}`;
}

// The image comes from the RSS item, not the page: the page's <img> src is a Drupal derivative
// carrying an `itok` signature, while the RSS wraps it in a link to the ORIGINAL file with no
// token. Measured 2026-08-16 — both 200, the original is the full-resolution one.
function auImageFromItem(item) {
  const a = item.description.match(/<a href="([^"]+\/system\/files\/[^"]+)"[^>]*>\s*<img[^>]*>/i);
  const alt = (item.description.match(/<img[^>]*\salt="([^"]*)"/i) || [])[1] || '';
  const src = a ? a[1] : (item.description.match(/<img[^>]*\ssrc="([^"]+)"/i) || [])[1];
  return src ? { src: src.startsWith('http') ? src : AU_BASE + src, caption: decodeEntities(alt) } : null;
}

export function auToCanonical(item, pageHtml) {
  const page = pageHtml || '';
  const prod = item.title;
  const hazardFull = fieldText(page, 'field-psa-recall-hazards') || stripTags(sectionFromDescription(item.description, 'field-psa-recall-hazards'));
  const hazard = auHazardShort(hazardFull);
  const date = isoDay(new Date(item.pubDate).toISOString());
  const brand = fieldText(page, 'field-psa-recall-brand');
  const supplier = fieldText(page, 'field-psa-recall-supplier-name');
  const traders = fieldText(page, 'field-psa-recall-traders');
  const saleDates = fieldText(page, 'field-psa-recall-sale-dates');
  const where = fieldText(page, 'field-psa-recall-location-sold');
  const madeIn = fieldText(page, 'field-psa-recall-country-id');
  const ident = fieldHtml(page, 'field-psa-recall-ident-features', AU_BASE);
  const desc = fieldHtml(page, 'field-psa-recall-product-desc', AU_BASE)
    || sanitize(sectionFromDescription(item.description, 'field-psa-recall-product-desc'), AU_BASE);
  const defects = fieldHtml(page, 'field-psa-recall-product-defects', AU_BASE)
    || sanitize(sectionFromDescription(item.description, 'field-psa-recall-product-defects'), AU_BASE);
  // Their "what consumers should do" block ends with a Contact heading and the supplier's phone
  // or email. Splitting on that heading is exact — it is their own markup, not a guess at where
  // the prose changes subject.
  // 🪤 SPLIT BEFORE SANITISING. <h3> is not on the sanitiser's allowlist, so sanitising first
  // deletes the very heading the split keys on — the Contact row then silently vanished from
  // every page while the parse still looked successful. Structure first, then strip.
  const actionRaw = fieldInner(page, 'field-psa-recall-consumer-action')
    || sectionFromDescription(item.description, 'field-psa-recall-consumer-action');
  const [actionPart, contactPart] = splitOnContact(actionRaw);
  const action = sanitize(actionPart, AU_BASE);
  const contact = stripTags(contactPart);
  const slugBase = slugify(deaccent(decodeURIComponent(item.link.split('/').filter(Boolean).pop() || prod)));

  return {
    id: item.id,
    country: 'au',
    slug: `${slugBase}-recall`,
    num: '',
    date,
    modified: date,
    hash: item.hash,
    prod,
    hazard,
    // ⛔ No units row: the ACCC does not publish a unit count. An omitted row is honest; a row
    // filled from the nearest available number is the confident-guess failure this repo keeps
    // paying for.
    units: '',
    url: item.link,
    contact,
    models: [ident, desc].map(stripTags).join(' ').slice(0, 400),
    image: auImageFromItem(item),
    rows: [
      ['What', prod],
      brand && ['Brand', brand],
      ['The hazard', clamp(hazardFull, 300)],
      traders && ['Sold at', traders],
      where && ['Where it was sold', where],
      saleDates && ['On sale', saleDates],
      supplier && ['Recalled by', supplier],
      madeIn && ['Made in', madeIn],
      contact && ['Contact', clamp(contact, 200)],
      item.categories.length && ['Category', item.categories.join(' · ')],
      ['Recall date', date],
    ].filter(Boolean),
    sections: [
      desc && { h2: 'What was recalled', html: desc },
      defects && { h2: 'Why it was recalled', html: defects },
      ident && { h2: 'How to identify it', html: ident },
      action && { h2: 'What to do', html: action },
    ].filter(Boolean),
    dek: clamp(hazard.charAt(0).toUpperCase() + hazard.slice(1), 160) + '.',
    // 🪤 CAUGHT BY READING THE PAGE, not by any check. The US sentence ends "…and how to get the
    // remedy — from the official CPSC notice", but the ACCC publishes no remedy field, so on an
    // Australian page that clause promised something the page does not have AND pushed the
    // sentence past 158 characters — every description truncated mid-phrase at "the remedy —…".
    // The description is the source's to write, like every other per-regulator string here.
    desc: fits(158, [
      `${prod} recalled in Australia: ${hazard}. What was sold, how to identify it, and what to do — from the official ACCC notice.`,
      `${prod} recalled in Australia: ${hazard}. What to do, from the official ACCC notice.`,
      `${prod} recalled in Australia: ${hazard}.`,
      `${clamp(prod, 80)} recalled in Australia. The hazard, what was sold, and what to do.`,
    ]),
  };
}
function splitOnContact(html) {
  const i = html.search(/<h[23][^>]*>\s*Contact\s*<\/h[23]>/i);
  if (i < 0) return [html, ''];
  return [html.slice(0, i).trim(), html.slice(i).replace(/<h[23][^>]*>[\s\S]*?<\/h[23]>/i, '').trim()];
}
// The RSS description carries the same Drupal blocks as the page, so it is a real fallback if a
// notice page ever fails to fetch — not a second parser, the same extraction over the same markup.
function sectionFromDescription(description, name) {
  const idx = description.indexOf(`field--name-${name}`);
  return idx < 0 ? '' : dropLabel(elementAt(description, idx));
}

// ---------- source: Canada ----------
// A THIRD FEED SHAPE, and the reason the adapter split earns its keep. The US is a JSON API with
// a date window; Australia is an RSS feed plus a notice page; Canada is a nightly bulk CSV of the
// ENTIRE archive (33,944 rows, 1991 → yesterday) plus a notice page.
//
// ⛔⛔ THE OBVIOUS ENDPOINT IS DEAD AND RETURNS 200. `healthycanadians.gc.ca/recall-alert-rappel-
// avis/api/recent/en` serves well-formed JSON, neatly split into FOOD/VEHICLE/HEALTH/CPS, 15 each
// — frozen at 2021-10-29, and its VEHICLE lane has not moved since 2017. Nothing about the
// response says so. Trusting the status code would have launched Canada with five-year-old
// recalls presented as the latest. The bulk CSV is the only current source. Verified 2026-08-16.
const CA_BASE = 'https://recalls-rappels.canada.ca';
const CA_CSV = `${CA_BASE}/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.csv`;

// RFC4180: quoted fields containing commas, newlines and doubled quotes. The Canadian file uses
// all three, so a split(',') parser silently shreds rows rather than failing — which is worse.
export function parseCsv(txt) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (quoted) {
      if (c === '"') { if (txt[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ⭐⭐ WHICH LANES SHIP, AND WHY — measured 2026-08-16 over the last 90 days, not archived:
//
//   lane      recalls   records with every field
//   VEHICLE      166        0
//   HEALTH       141       36
//   CPS           68       68     ← ships
//   FOOD          52       28     ← ships, filtered to the 28
//
// · CPS is the direct CPSC/ACCC equivalent and is 100% complete. It is the spine.
// · FOOD ships ONLY where the notice carries a "what you should do". A recall page that cannot
//   tell you what to do is half a page on a site whose entire promise is answer-first.
// · ⛔ VEHICLE is excluded on DATA QUALITY, not taste: every one of the 166 lacks the action
//   field, and the titles are literally "Transport Canada Recall - 2022550 - VOLVO". That is a
//   generator for 166 near-identical stubs — scaled thin content, which is the refusal class this
//   site has already been hit with once. Recoverable later by fetching each notice page.
// · ⛔ HEALTH (drugs, medical devices, natural health products) is excluded because this site
//   deliberately does not lean health — YMYL, where an unknown domain does not rank — and because
//   AdSense is mid-recrawl after a refusal. Both reasons are strategy, not squeamishness.
// ⭐ `issuer` IS DECLARED PER LANE, not derived with a ternary — and that is not tidiness either.
// It was `org === 'CFIA' ? CFIA : 'Health Canada — Consumer Product Safety'`, which labels
// ANY lane that is not food as Health Canada consumer products. Mutation testing caught it: adding
// a Transport Canada lane published 166 vehicle recalls that all *claimed to be issued by Health
// Canada*, and both exclusion tests stayed green because every record looked like a CPS record.
// A ternary over an open set is a mislabelling waiting for its second case. Adding a lane now
// forces naming its issuer.
const CA_LANES = {
  'Consumer product safety': { lane: 'CPS', requireAction: false, issuer: 'Health Canada — Consumer Product Safety' },
  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },
};
// ⛔ A WINDOW, NOT A PER-LANE COUNT. A fixed "newest N per category" silently drops real recalls
// the week a batch lands — the same no-silent-caps rule the promote script follows — and it needs
// re-tuning by hand as the site grows. 90 days keeps the site current by construction.
const CA_WINDOW_DAYS = 90;

export function caPickRows(csv, todayIso) {
  const rows = parseCsv(csv);
  const head = rows[0] || [];
  const at = (name) => head.indexOf(name);
  const [T, U, O, P, I, W, C, K, D, A] = ['Title', 'URL', 'Organization', 'Product', 'Issue',
    'What you should do', 'Category', 'Recall class', 'Last updated', 'Archived'].map(at);
  if ([T, U, O, P, I, W, C, D, A].some((i) => i < 0)) {
    throw new Error(`Canadian CSV header changed — got ${JSON.stringify(head)}`);
  }
  const cutoff = new Date(new Date(todayIso + 'T12:00:00Z').getTime() - CA_WINDOW_DAYS * 864e5)
    .toISOString().slice(0, 10);
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.length < head.length - 1) continue;
    const conf = CA_LANES[r[O]];
    if (!conf) continue;                       // excluded lane
    if (r[A] === '1') continue;                // archived: closed, not current
    if (!r[D] || r[D] < cutoff) continue;      // outside the window
    const action = stripTags(r[W] || '');
    if (conf.requireAction && !action) continue;
    if (!r[P] || !r[U]) continue;              // no product or no source link: not publishable
    out.push({
      nid: r[0], title: r[T], url: r[U], org: r[O], product: r[P],
      issue: stripTags(r[I] || ''), action, category: r[C], recallClass: r[K] || '',
      date: r[D], lane: conf.lane, issuer: conf.issuer,
    });
  }
  return out;
}

// The notice page carries LONG-form versions of the summary fields plus the product photographs,
// neither of which is in the CSV — the same two-stage shape as Australia, for the same reason.
// ⭐⭐ THE `Issue` COLUMN IS NOT RELIABLY A HAZARD, and reading one rendered page is what showed
// it: the Cosyland step stool — a tip-over and entrapment recall — carries Issue "Consumer
// products", so the page read "The hazard: Consumer products" and the dek was the sentence
// "Consumer products." Measured across the 96 selected rows, 14 have an Issue that is an allergen
// name or a category label rather than a hazard.
// The TITLE carries the notice's own words in 92 of the 96: "<product> recalled due to <hazard>".
// So the title clause wins, and Issue is the fallback — the 3 rows with no clause are Health
// Canada warnings whose Issue is a clean "Chemical hazard" / "Choking hazard".
// ⚠ The zero-width space is not decoration: at least one real Canadian title contains U+200B
// immediately before "due to", so a plain / recalled due to / never matches it.
export function caHazard(row) {
  const m = String(row.title || '').match(/recalled[\s​]*due to[\s​]*(.+)$/i);
  const fromTitle = m ? m[1].replace(/[\s​]+/g, ' ').replace(/[.\s]+$/, '').trim() : '';
  return clamp(fromTitle || row.issue || 'safety hazard', 90);
}
export function caToCanonical(row, pageHtml) {
  const page = pageHtml || '';
  const prod = row.product.trim();
  const hazard = caHazard(row);
  const affected = fieldHtml(page, 'field-affected-products', CA_BASE);
  const issueLong = fieldHtml(page, 'field-issue-long', CA_BASE);
  const actionLong = fieldHtml(page, 'field-action-long', CA_BASE);
  const background = fieldHtml(page, 'field-background', CA_BASE);
  const forWhom = fieldText(page, 'field-who-this-is-for');
  const brand = fieldText(page, 'field-brand-ref');
  const company = fieldText(page, 'field-companies');
  const esc1 = (s) => `<p>${escText(s)}</p>`;

  return {
    id: `ca-${row.nid}`,
    country: 'ca',
    slug: `${slugify(deaccent(prod))}-recall-${row.nid}`,
    num: row.nid,
    date: row.date,
    modified: row.date,
    prod,
    hazard,
    units: '',
    url: row.url.startsWith('http') ? row.url : CA_BASE + row.url,
    contact: '',
    models: [prod, stripTags(affected)].join(' ').slice(0, 400),
    image: caImage(page),
    rows: [
      ['What', prod],
      brand && ['Brand', brand],
      ['The hazard', hazard],
      row.category && ['Category', row.category],
      forWhom && ['Who it affects', forWhom],
      company && ['Recalled by', company],
      row.recallClass && ['Recall class', row.recallClass],
      ['Issued by', row.issuer],
      ['Recall date', row.date],
    ].filter(Boolean),
    sections: [
      { h2: 'What was recalled', html: affected || esc1(prod) },
      (issueLong || row.issue) && { h2: 'Why it was recalled', html: issueLong || esc1(row.issue) },
      (actionLong || row.action) && { h2: 'What to do', html: actionLong || esc1(row.action) },
      background && { h2: 'Background', html: background },
    ].filter(Boolean),
    dek: clamp(hazard.charAt(0).toUpperCase() + hazard.slice(1), 160) + '.',
    desc: fits(158, [
      `${prod} recalled in Canada: ${hazard}. What was sold, who it affects, and what to do — from the official notice.`,
      `${prod} recalled in Canada: ${hazard}. What to do, from the official notice.`,
      `${prod} recalled in Canada: ${hazard}.`,
      `${clamp(prod, 80)} recalled in Canada. The hazard, who it affects, and what to do.`,
    ]),
  };
}
// 🪤🪤 TWO SEPARATE TRAPS ON ONE TAG, and the first is the dangerous one.
//
// 1. THE PHOTO IS IN `data-src`. Canada lazy-loads images, so `src` holds an inline SVG spacer:
//        <img data-src="/sites/default/files/styles/x_large/public/alert/recall/82165/Image1.jpg?itok=…"
//             src="data:image/svg+xml,…viewBox='0 0 172 220'…" alt="Front of product">
//    Reading `src` — the obvious attribute, and the one that works on every other site — mirrors
//    a BLANK PLACEHOLDER. It would not have errored: it would have quietly filled the photo grid
//    with empty rectangles that still passed "every record has an image".
// 2. Then the same `itok` derivative trap Australia had, arrived at independently. The unsigned
//    original sits at the same path with /styles/<preset>/public/ removed, and is larger
//    (11 KB vs 6.8 KB on the row measured 2026-08-16).
//
// ⛔ The data: guard is not belt-and-braces — a data: URI is exactly what this returns if the
// lazy-load attribute is ever renamed, and mirroring one produces a page that looks fine to every
// check and blank to every reader.
function caImage(page) {
  for (const m of page.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const raw = (tag.match(/\sdata-src="([^"]+)"/i) || tag.match(/\ssrc="([^"]+)"/i) || [])[1] || '';
    if (!raw || raw.startsWith('data:')) continue;
    if (!/\/alert\/recall\//.test(raw)) continue;          // skip site chrome and wordmarks
    const alt = (tag.match(/\salt="([^"]*)"/i) || [])[1] || '';
    const clean = raw.split('?')[0].replace(/\/styles\/[^/]+\/public\//, '/');
    return { src: clean.startsWith('http') ? clean : CA_BASE + clean, caption: decodeEntities(alt) };
  }
  return null;
}

// ---------- the registry ----------
export const SOURCES = {
  us: {
    cc: 'us',
    country: 'United States',
    // The form that reads correctly after "in …" on the homepage hero. 'in United States' is
    // wrong and 'in the Australia' is worse, so the article belongs to the source, not the sentence.
    countryIn: 'the United States',
    agency: 'U.S. Consumer Product Safety Commission',
    agencyShort: 'CPSC',
    // The body's "the official CPSC recall notice". The meta description is written by the
    // adapter itself, because what a page can promise differs per regulator.
    noticeName: 'CPSC recall notice',
    hubCrumb: 'Recalls',
    // Works of the U.S. federal government: no licence to satisfy, no attribution required, so
    // no attribution sentence is appended to the source line.
    attribution: '',
    footerCredit: 'recall data from the U.S. Consumer Product Safety Commission (public domain)',
    completeWindow: true,
    // Which field a revision shows up in. CPSC moves LastPublishDate when it amends a notice.
    revisionKey: 'modified',
    hubTitle: 'Product Recalls, Tracked Daily — StopHurting',
    hubHeading: 'Product recalls, tracked daily',
    hubDesc: (n) => `Every U.S. consumer product recall, posted as it drops — what was recalled, the hazard, and what to do, straight from the official CPSC notices. ${n} tracked.`,
    hubIntro: (n) => `Straight from the official CPSC notices — what was recalled, why it's dangerous, and what to do about it. Newest first, updated automatically. ${n} tracked since June 2026.`,
    async fetch({ since }) {
      const res = await fetch(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${since}`);
      if (!res.ok) throw new Error(`CPSC feed HTTP ${res.status}`);
      return (await res.json()).map(usToCanonical);
    },
  },

  au: {
    cc: 'au',
    country: 'Australia',
    countryIn: 'Australia',
    agency: 'ACCC Product Safety Australia',
    agencyShort: 'ACCC',
    noticeName: 'Product Safety Australia recall notice',
    hubCrumb: 'Australian recalls',
    attribution: 'Source: ACCC © Commonwealth of Australia, used under '
      + '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener nofollow">CC BY 4.0</a>.',
    footerCredit: 'Australian recall data © Commonwealth of Australia (ACCC), CC BY 4.0',
    // ⭐ The ACCC publishes no revision date, so the CPSC comparison has nothing to compare. The
    // RSS carries the entire notice body, so we hash it — which catches ANY edit (a corrected
    // hazard, an added model, a changed remedy), strictly more than a date field would.
    revisionKey: 'hash',
    // ⚠ NOT public domain. The ACCC licenses its website content under CC BY 4.0 and REQUIRES
    // attribution in this form (verified on their disclaimer-and-copyright page, 2026-08-16).
    // Their logos, the Coat of Arms, and anything expressly marked as a third party's are
    // excluded — which is why no ACCC logo or branding appears anywhere on our pages.
    licence: {
      label: 'CC BY 4.0',
      html: 'Australian recall data: Source: ACCC © Commonwealth of Australia, used under '
        + '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener nofollow">CC BY 4.0</a>',
    },
    // 🔴 THE ONE THAT MATTERS. The feed is a rolling 25 items with NO archive — anything older
    // is simply not returned, so "in our state but absent from the feed" is true of every page we
    // have ever built for Australia. With this true, the first run would report the whole
    // country withdrawn.
    completeWindow: false,
    hubTitle: 'Australian Product Recalls — StopHurting',
    hubHeading: 'Australian product recalls',
    hubDesc: (n) => `Australian consumer product recalls — what was recalled, the hazard, and what to do, from the ACCC's official Product Safety Australia notices. ${n} tracked.`,
    hubIntro: (n) => `From the ACCC's official Product Safety Australia notices — what was recalled, why it's dangerous, and what to do about it. ${n} tracked. Australia publishes a rolling feed rather than an archive, so this list starts when we did.`,
    // Two-stage on purpose. The RSS is the discovery lane: 25 items, one request, and it carries
    // enough to tell new from unchanged. The notice PAGE carries brand, supplier, who sold it,
    // the sale window and the identifying features — none of which are in the feed — so it is
    // fetched once per NEW OR CHANGED recall and never for the rest.
    async fetch({ known = new Map(), fixtures = null, rebuild = false } = {}) {
      const xml = fixtures ? loadFixture(fixtures, 'au-rss.xml') : await fetchText(`${AU_BASE}/rss/recalls.xml`);
      const items = auParseFeed(xml);
      const out = [];
      for (const item of items) {
        const prev = known.get(item.id);
        // The hash shortcut is what keeps a routine run to ONE request: 25 items in, no notice
        // pages fetched unless something actually changed. --rebuild deliberately bypasses it,
        // because that is the flag for "re-render from source", and a cache is not a source.
        // ⚠ --rebuild can only reach the 25 items still in the window. Anything that has rolled
        // off is unreachable — for Australia there is no archive to re-read.
        if (!rebuild && prev && prev.hash === item.hash) { out.push({ ...prev, unchanged: true }); continue; }
        const pageHtml = fixtures
          ? loadFixture(fixtures, `au-page-${deaccent(decodeURIComponent(item.link.split('/').filter(Boolean).pop()))}.html`, true)
          : await fetchText(item.link).catch(() => '');
        out.push(auToCanonical(item, pageHtml));
      }
      return out;
    },
  },

  ca: {
    cc: 'ca',
    country: 'Canada',
    countryIn: 'Canada',
    agency: 'Health Canada and the Canadian Food Inspection Agency',
    agencyShort: 'Health Canada',
    noticeName: 'Canadian recall notice',
    hubCrumb: 'Canadian recalls',
    // ⚠ Open Government Licence – Canada. Its attribution clause is explicit: use the provider's
    // statement, or this exact sentence. It also forbids using federal logos or official symbols
    // and forbids implying endorsement — which is why no departmental crest appears on our pages
    // and why nothing here says "official Government of Canada".
    attribution: 'Contains information licensed under the '
      + '<a href="https://open.canada.ca/en/open-government-licence-canada" target="_blank" rel="noopener nofollow">Open Government Licence – Canada</a>.',
    footerCredit: 'Canadian recall data licensed under the Open Government Licence – Canada',
    // ⛔ FALSE, and for a different reason than Australia's. The Canadian CSV IS the complete
    // archive — but this adapter deliberately returns only two lanes inside a 90-day window, so
    // "absent from what the adapter returned" describes our own filter, not a withdrawal. Turning
    // this on would report every recall that ages past 90 days as withdrawn.
    // ⚠ The file's `Archived` column is the honest future hook for status changes — but archived
    // on canada.ca means closed/old, NOT withdrawn, so it must not be published as one.
    completeWindow: false,
    revisionKey: 'modified',
    hubTitle: 'Canadian Product Recalls — StopHurting',
    hubHeading: 'Canadian product recalls',
    hubDesc: (n) => `Canadian consumer product and food recalls — what was recalled, the hazard, and what to do, from Health Canada's and the CFIA's official notices. ${n} tracked.`,
    hubIntro: (n) => `From the official Health Canada and Canadian Food Inspection Agency notices — what was recalled, why it's dangerous, and what to do about it. ${n} tracked, covering consumer products and food.`,
    async fetch({ known = new Map(), fixtures = null, rebuild = false, today = new Date().toISOString().slice(0, 10) } = {}) {
      // The whole archive every run: 10 MB, and the only current source Canada publishes. Parsing
      // 33,944 rows to keep ~100 is the cost of the endpoint that actually works.
      const csv = fixtures ? loadFixture(fixtures, 'ca-recalls.csv') : await fetchText(CA_CSV);
      const picked = caPickRows(csv, today);
      const out = [];
      for (const row of picked) {
        const id = `ca-${row.nid}`;
        const prev = known.get(id);
        // The CSV's own "Last updated" is the revision marker, so an unchanged row costs no
        // notice-page fetch. ~100 fetches on the first run, a handful thereafter.
        if (!rebuild && prev && prev.modified === row.date) { out.push({ ...prev, unchanged: true }); continue; }
        const pageHtml = fixtures
          ? loadFixture(fixtures, `ca-page-${row.nid}.html`, true)
          : await fetchText(row.url).catch(() => '');
        out.push(caToCanonical(row, pageHtml));
      }
      return out;
    },
  },
};

// ⚠ RETRIES BECAUSE A 10 MB BODY REALLY DOES GET DROPPED. Canada's open-data CSV terminated
// mid-transfer on consecutive runs — `fetch` rejects with a bare "terminated", which the build's
// per-country guard reports and then skips that country. That is the correct failure (the other
// countries still build, state is untouched), but a transport hiccup should not cost a country a
// whole cycle when the next attempt succeeds.
// ⛔ The retry is on the TRANSPORT only. A non-2xx is returned as-is and never retried: an HTTP
// error is an answer, and hammering a government endpoint because it said no is how you get
// blocked.
async function fetchText(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'stophurting-recalls/1.0 (+https://stophurting.org)' },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (/^HTTP \d/.test(e.message)) throw e;
      if (i < attempts) {
        console.log(`   ↻ ${url.split('/').pop()} failed (${e.message}) — retry ${i} of ${attempts - 1}`);
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  }
  throw new Error(`${last?.message || 'fetch failed'} after ${attempts} attempts: ${url}`);
}

export const COUNTRIES = Object.keys(SOURCES);
export const sourceFor = (cc) => {
  const s = SOURCES[cc];
  if (!s) throw new Error(`unknown country "${cc}" — known: ${COUNTRIES.join(', ')}`);
  return s;
};
