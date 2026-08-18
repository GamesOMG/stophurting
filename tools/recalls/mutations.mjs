#!/usr/bin/env node
// Proves check-au-adapter.mjs can FAIL — and that each specific assertion catches the specific
// thing it was written to catch.
//
// A green suite is not evidence. Two suites in the sibling repo died the same way: a harness that
// could not run looked exactly like a harness with nothing to report, for nine days. The cheap
// version of that failure is a suite whose assertions are all trivially true.
//
// So: copy the tools directory to a temp dir, break ONE thing, run the real check against the
// broken copy, and require that the assertion MEANT to guard it is the one that fails. A mutation
// caught by some other assertion is reported as a miss, because it means the guard we think we
// have is not the guard doing the work.
//
// ⛔ NOT named check-*.mjs on purpose. The pre-commit hook globs tools/*/check*.mjs, and this
// file's anchors are exact source strings from sources.mjs — the day someone reformats a line,
// this fails while the code is perfectly correct. It is a tool you run by hand when you touch the
// adapter, not a gate:
//     node tools/recalls/mutations.mjs

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MUTATIONS = [
  {
    name: 'withdrawal rail flipped on for a rolling feed',
    file: 'sources.mjs',
    find: 'completeWindow: false,',
    replace: 'completeWindow: true,',
    expect: 'declares the Australian window incomplete',
    why: 'this is the mutation that would publish a false withdrawal notice for every Australian page',
  },
  {
    name: 'contact split moved back after the sanitiser',
    file: 'sources.mjs',
    find: 'const [actionPart, contactPart] = splitOnContact(actionRaw);',
    replace: 'const [actionPart, contactPart] = splitOnContact(sanitize(actionRaw, AU_BASE));',
    expect: 'keeps the contact details out of the body and in the table',
    why: 'the original bug — the sanitiser eats the <h3>Contact</h3> the split keys on, and the row silently disappears',
  },
  {
    name: 'body hash frozen to a constant',
    file: 'sources.mjs',
    find: 'return `${s.length.toString(36)}-${h.toString(36)}`;',
    replace: 'return `constant`;',
    expect: 'detects an amended notice through the body hash',
    why: 'with no working hash, an amended ACCC notice is never re-rendered and never reaches /updates/',
  },
  {
    name: 'image taken from the signed derivative instead of the original',
    file: 'sources.mjs',
    find: 'const a = item.description.match(/<a href="([^"]+\\/system\\/files\\/[^"]+)"[^>]*>\\s*<img[^>]*>/i);',
    replace: 'const a = null;',
    expect: 'mirrors the untokenised original image',
    why: 'an itok-signed URL can stop resolving, and every card on a photo-led hub would go blank',
  },
  {
    name: 'deaccent dropped from the slug',
    file: 'sources.mjs',
    find: 'const slugBase = slugify(deaccent(decodeURIComponent(',
    replace: 'const slugBase = slugify(((x)=>x)(decodeURIComponent(',
    expect: 'builds an ASCII slug from a non-ASCII source URL',
    why: 'a percent-encoded or accented slug produces an unshareable URL and an awkward directory name',
  },
  {
    name: 'ACCC content credited as public domain',
    file: 'sources.mjs',
    find: "footerCredit: 'Australian recall data © Commonwealth of Australia (ACCC), CC BY 4.0',",
    replace: "footerCredit: 'Australian recall data (public domain)',",
    expect: 'carries every attribution condition CC BY 4.0 lists',
    why: 'CC BY 4.0 requires attribution — dropping it is a licence breach, not a wording preference',
  },
  {
    name: 'units invented from the product description',
    file: 'sources.mjs',
    find: "    units: '',",
    replace: "    units: '1,000',",
    expect: 'omits a units row entirely rather than inventing one',
    why: 'a fabricated unit count on a safety page is the exact failure this repo keeps paying for',
  },
  {
    name: 'AU modification indication dropped',
    file: 'sources.mjs',
    find: "    attribution: 'Based on ACCC data — Source: ACCC © Commonwealth of Australia, used under '",
    replace: "    attribution: 'Source: ACCC © Commonwealth of Australia, used under '",
    expect: 'carries every attribution condition CC BY 4.0 lists',
    why: 'CC BY 4.0 §3(a)(1)(A)(v) requires indicating modification, and we do modify — this is the exact state the site shipped in until it was audited',
  },
  // ── Canada ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'CA photo read from src instead of data-src',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "const raw = (tag.match(/\\sdata-src=\"([^\"]+)\"/i) || tag.match(/\\ssrc=\"([^\"]+)\"/i) || [])[1] || '';",
    replace: "const raw = (tag.match(/\\ssrc=\"([^\"]+)\"/i) || [])[1] || '';",
    expect: 'takes the photo from data-src',
    why: 'Canada lazy-loads: src is an inline SVG spacer, so this fills a photo-led hub with blank cards while every "has an image" check still passes',
  },
  {
    name: 'CA vehicle lane let through',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },",
    replace: "  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },\n  TC: { lane: 'VEHICLE', requireAction: false, issuer: 'Transport Canada' },",
    expect: 'excludes Transport Canada vehicle recalls',
    why: '166 recalls with no action field and near-identical titles — scaled thin content on a site already refused once',
  },
  {
    name: 'CA health lane let through',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },",
    replace: "  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },\n  'Medical devices': { lane: 'HEALTH', requireAction: false, issuer: 'Medical devices' },",
    expect: 'excludes drugs, medical devices and natural health products',
    why: 'YMYL content this site deliberately avoids, added while AdSense is mid-recrawl after a refusal',
  },
  {
    name: 'CA food action requirement dropped',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "  CFIA: { lane: 'FOOD', requireAction: true, issuer: 'Canadian Food Inspection Agency' },",
    replace: "  CFIA: { lane: 'FOOD', requireAction: false, issuer: 'Canadian Food Inspection Agency' },",
    expect: 'drops food recalls that cannot say what to do',
    why: 'ships food recalls that cannot tell a reader what to do — half a page on an answer-first site',
  },
  {
    name: 'CA archived notices published',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "    if (r[A] === '1') continue;                // archived: closed, not current",
    replace: '',
    expect: 'drops archived notices',
    why: 'republishes closed notices as current recalls',
  },
  {
    name: 'CA withdrawal detection switched on for a self-filtered feed',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    // ⚠ Anchored on the CA-only comment above the flag, not on the flag plus its neighbour: the
    // original anchor assumed `windowNote` came next and rotted silently the day `quietDays` was
    // inserted between them, leaving this mutation unapplied — reported, but for eight days
    // nobody read the report. `completeWindow: false,` alone is not unique (CA, UK and AU all
    // carry it), so the anchor has to include something only Canada says.
    find: "    // on canada.ca means closed/old, NOT withdrawn, so it must not be published as one.\n    completeWindow: false,",
    replace: "    // on canada.ca means closed/old, NOT withdrawn, so it must not be published as one.\n    completeWindow: true,",
    expect: 'declares its window incomplete',
    why: 'every Canadian recall would be published as withdrawn the day it aged past 90 days',
  },
  {
    name: 'CA CSV header check removed',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: '  if ([T, U, O, P, I, W, C, D, A].some((i) => i < 0)) {',
    replace: '  if (false) {',
    expect: 'aborts when the CSV header changes',
    why: 'a renamed column would publish ~96 pages with every field blank and no error anywhere',
  },
  {
    name: 'CA credited as public domain',
    file: 'sources.mjs',
    suite: 'check-ca-adapter.mjs',
    find: "    footerCredit: 'Canadian recall data licensed under the Open Government Licence – Canada',",
    replace: "    footerCredit: 'Canadian recall data (public domain)',",
    expect: 'credits the Open Government Licence',
    why: 'OGL attribution is a licence condition; dropping it ends the rights granted under it',
  },
  // ── United Kingdom ────────────────────────────────────────────────────────────────────────
  {
    name: 'UK safety reports published as recalls',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: "const UK_TYPES = ['product-recall', 'product-safety-alert'];",
    replace: "const UK_TYPES = ['product-recall', 'product-safety-alert', 'product-safety-report'];",
    expect: 'asks the API only for recalls and alerts',
    why: '1,160 of those reports are goods stopped at the border — publishing them under a "Recall" heading is simply false',
  },
  {
    name: 'UK claims an image it does not have',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: '    image: null,\n    cat: pretty(meta.product_category),',
    replace: "    image: { src: 'https://www.gov.uk/x.jpg', caption: '' },\n    cat: pretty(meta.product_category),",
    expect: 'reports no image rather than inventing one',
    why: 'the photo exists only inside a PDF; claiming one produces a broken image on a photo-led hub',
  },
  {
    name: 'UK hazard keeps the stock OPSS opening',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: "    .replace(/^The product presents?\\s+(?:a|an)\\s+/i, '')",
    replace: '',
    expect: 'shortens the hazard without inventing wording',
    why: 'every card in the country would open with the same four words',
  },
  {
    name: 'UK notice that failed to fetch published anyway',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: '        if (!doc) continue;   // a notice we cannot read is a notice we do not publish',
    replace: '',
    expect: 'never publishes a notice it could not read',
    why: 'emits a record with every field blank when the content API hiccups',
  },
  {
    name: 'UK given Australia\'s reason for disabling withdrawal detection',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: "    windowNote: 'gov.uk holds the whole archive, but this adapter asks only for two alert types inside a 90-day window — absence describes our own filter, not a withdrawal.',",
    replace: "    windowNote: 'OPSS publishes a rolling window with no archive.',",
    expect: 'states its own reason for disabling withdrawal detection',
    why: 'the build prints this line — a borrowed excuse becomes a quoted fact',
  },
  {
    name: 'UK credited as public domain',
    file: 'sources.mjs',
    suite: 'check-uk-adapter.mjs',
    find: "    footerCredit: 'UK recall data licensed under the Open Government Licence v3.0',",
    replace: "    footerCredit: 'UK recall data (public domain)',",
    expect: 'credits the Open Government Licence v3.0',
    why: 'OGL attribution is a licence condition, not a courtesy',
  },
  {
    name: 'sanitiser allows every tag through',
    file: 'sources.mjs',
    find: "const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a']);",
    replace: "const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'script', 'h3', 'img', 'div']);",
    expect: 'strips everything it does not explicitly allow',
    why: 'foreign markup injected into our layout, up to and including a script tag',
  },

  // ── the Facebook publish rails ────────────────────────────────────────────────────────────
  // ⛔ These exist because on 2026-08-17 a rail was added, passed its own suite, and the same
  // broken post shipped anyway — Jason found it on the page for the second time in a day. The
  // rails below are the replacement, so the question "can this suite actually fail?" is not one
  // to answer by reasoning about it a third time.
  {
    name: 'rail 8 removed — trust our own probe again',
    file: 'fb-post.mjs',
    suite: 'check-fb-post.mjs',
    find: 'if (!await fbPreviewIsGood(link, pageToken)) {',
    replace: 'if (false) {',
    expect: 'rail8-refuses-when-facebook-still-sees-the-404',
    why: 'this is the exact code path that published "Page not found — StopHurting" under a real recall',
  },
  {
    name: 'a 404 card no longer gets the URL in a comment',
    file: 'fb-post.mjs',
    suite: 'check-fb-post.mjs',
    find: 'if (noCard || wrongCard) {',
    replace: 'if (noCard) {',
    expect: 'a-404-card-gets-a-comment-and-fails-the-run',
    why: 'the post stays live with no route to the recall — the one outcome worse than not posting',
  },
  {
    name: 'the broken post no longer fails the run',
    file: 'fb-post.mjs',
    suite: 'check-fb-post.mjs',
    // ⚠ Re-anchored: the message it used to key on was reworded the same day, splitting the
    // wrong-card and no-card wordings apart. The exit code is the thing under test, so anchor on
    // the line that sets it plus just enough above it to be unique.
    find: 'is worth re-posting for`);\n      process.exitCode = 1;',
    replace: 'is worth re-posting for`);',
    expect: 'a-404-card-gets-a-comment-and-fails-the-run',
    why: 'exiting 0 is how Task Scheduler reported success for seven hours while the page was wrong',
  },
  {
    name: 'the 404 title pattern stops matching our 404 page',
    file: 'fb-post.mjs',
    suite: 'check-fb-post.mjs',
    find: 'const NOT_FOUND_TITLE = /page not found/i;',
    replace: 'const NOT_FOUND_TITLE = /page could not be found/i;',
    expect: 'the 404 detector still matches the real 404 page',
    why: 'a detector that matches nothing reads exactly like a detector finding nothing wrong',
  },

  // ── the email alerter ─────────────────────────────────────────────────────────────────────
  // ⛔ This module emails Jason's real inbox from an unattended job. It had no harness at all
  // until the day it was wired up, and the first thing its suite did was catch a bug in the fix.
  {
    name: 'the blip rule removed — one sighting mails',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: '} else if (state.pending?.[k]) {',
    replace: '} else if (true) {',
    expect: 'a problem seen ONCE is held back',
    why: 'one dropped connection on a 4-hourly job would mail "broken" then "recovered" — the shape that teaches an inbox to filter you',
  },
  {
    name: 'recovery computed from the wrong set',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: 'const cleared = Object.keys(state.open).filter((k) => !current.has(k));',
    replace: 'const cleared = Object.keys(state.open).filter((k) => !state.pending?.[k]);',
    expect: 'an UNCHANGED problem is never reported as recovered',
    why: 'this is the measured original defect — it told him a dead feed was fine, six times a day',
  },
  {
    name: 'the state write throws again',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: '  } catch (e) {\n    console.log(`   ✉ alert state not saved',
    replace: '  } catch (e) {\n    throw e;\n    console.log(`   ✉ alert state not saved',
    expect: 'an unwritable state file does not throw out of reportHealth',
    why: 'build.mjs awaits this at top level, so a locked state file would mail him and then kill the run it was describing',
  },
  {
    name: 'state shape no longer validated',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: "      open: s.open && typeof s.open === 'object' ? s.open : {},",
    replace: '      open: s.open,',
    expect: 'a state file holding {} is survived',
    why: 'a file that parses but has no `open` threw a TypeError on a HEALTHY run — the alerter killing the build on a good day',
  },
  {
    name: 'a problem is marked reported even though no mail went out',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: "    if (!sent) { persist({ open: state.open, pending: stillPending }); return { mailed: false, reason: 'no-credential' }; }",
    replace: "    if (!sent) { persist({ open: nextOpen, pending: nextPending }); return { mailed: false, reason: 'no-credential' }; }",
    expect: 'does NOT record the problem as reported',
    why: 'the backlog waiting for Jason to write the credential file would be silently adopted and never sent',
  },
  {
    name: 'one incident\'s postmortem welded back into every event',
    file: 'alert.mjs',
    suite: 'check-alert.mjs',
    find: "    ...(why.length ? ['', ...why] : []),",
    replace: "    ...(why.length ? ['', ...why] : []), '', 'A post whose card scraped the 404 page cannot be repaired in place — delete the post.',",
    expect: 'reportEvent carries no explanation it was not given',
    why: 'an explanation that is only sometimes true tells him to go and do the wrong thing',
  },
];

let caught = 0;
const missed = [];

console.log(`proving ${MUTATIONS.length} mutations are caught:\n`);

for (const m of MUTATIONS) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-mut-'));
  try {
    cpSync(HERE, dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
    // node_modules is skipped because copying sharp per mutation is unbearable — but ESM ignores
    // NODE_PATH, and a temp dir has no ancestor holding the deps, so any suite that imports one
    // (check-alert.mjs needs nodemailer) would fail on EVERY mutation for a reason that has
    // nothing to do with the mutation. A junction needs no elevation on Windows.
    try { symlinkSync(path.join(HERE, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); }
    catch { /* suites that need a dependency will say so themselves */ }
    const target = path.join(dir, m.file);
    const src = readFileSync(target, 'utf8');
    if (!src.includes(m.find)) {
      missed.push(`${m.name} — ANCHOR NOT FOUND in ${m.file}; the mutation never applied, so this proves nothing`);
      console.log(`  ⚠  ${m.name}\n     anchor no longer present — update the anchor, do not delete the mutation`);
      continue;
    }
    writeFileSync(target, src.replace(m.find, m.replace));

    let out = '';
    let exitCode = 0;
    try {
      out = execFileSync(process.execPath, [path.join(dir, m.suite || 'check-au-adapter.mjs')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The copy lives in a temp dir, so a suite that reads a real page of the site (the 404
        // title check) has to be told where the site is. Without this it fails on every mutation
        // and buries the one failure this run exists to read.
        env: { ...process.env, SH_SITE_ROOT: path.resolve(HERE, '..', '..') },
      });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      exitCode = e.status ?? 1;
    }

    const failedNames = [...out.matchAll(/^ {2}❌ (.+)$/gm)].map((x) => x[1].trim());
    const hitIntended = failedNames.some((n) => n.includes(m.expect));

    if (exitCode === 0) {
      missed.push(`${m.name} — the suite stayed GREEN`);
      console.log(`  ❌ ${m.name}\n     suite passed anyway. ${m.why}`);
    } else if (!hitIntended) {
      missed.push(`${m.name} — caught, but by the wrong assertion (${failedNames.join(', ')})`);
      console.log(`  ⚠  ${m.name}\n     failed, but not via "${m.expect}" — via: ${failedNames.join(', ') || '(a crash, not an assertion)'}`);
    } else {
      caught++;
      console.log(`  ✅ ${m.name}\n     caught by "${failedNames.find((n) => n.includes(m.expect))}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by their own assertion`);
if (missed.length) {
  console.log('\nNOT PROVEN:');
  for (const x of missed) console.log(`  · ${x}`);
}
process.exit(missed.length ? 1 : 0);
