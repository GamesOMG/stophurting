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
  const idx = html.indexOf(`field--name-field-psa-${name}`);
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
  const hazardFull = fieldText(page, 'recall-hazards') || stripTags(sectionFromDescription(item.description, 'recall-hazards'));
  const hazard = auHazardShort(hazardFull);
  const date = isoDay(new Date(item.pubDate).toISOString());
  const brand = fieldText(page, 'recall-brand');
  const supplier = fieldText(page, 'recall-supplier-name');
  const traders = fieldText(page, 'recall-traders');
  const saleDates = fieldText(page, 'recall-sale-dates');
  const where = fieldText(page, 'recall-location-sold');
  const madeIn = fieldText(page, 'recall-country-id');
  const ident = fieldHtml(page, 'recall-ident-features', AU_BASE);
  const desc = fieldHtml(page, 'recall-product-desc', AU_BASE)
    || sanitize(sectionFromDescription(item.description, 'recall-product-desc'), AU_BASE);
  const defects = fieldHtml(page, 'recall-product-defects', AU_BASE)
    || sanitize(sectionFromDescription(item.description, 'recall-product-defects'), AU_BASE);
  // Their "what consumers should do" block ends with a Contact heading and the supplier's phone
  // or email. Splitting on that heading is exact — it is their own markup, not a guess at where
  // the prose changes subject.
  // 🪤 SPLIT BEFORE SANITISING. <h3> is not on the sanitiser's allowlist, so sanitising first
  // deletes the very heading the split keys on — the Contact row then silently vanished from
  // every page while the parse still looked successful. Structure first, then strip.
  const actionRaw = fieldInner(page, 'recall-consumer-action')
    || sectionFromDescription(item.description, 'recall-consumer-action');
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
  const idx = description.indexOf(`field--name-field-psa-${name}`);
  return idx < 0 ? '' : dropLabel(elementAt(description, idx));
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
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'stophurting-recalls/1.0 (+https://stophurting.org)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export const COUNTRIES = Object.keys(SOURCES);
export const sourceFor = (cc) => {
  const s = SOURCES[cc];
  if (!s) throw new Error(`unknown country "${cc}" — known: ${COUNTRIES.join(', ')}`);
  return s;
};
