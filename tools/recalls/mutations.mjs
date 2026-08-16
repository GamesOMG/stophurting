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

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
    expect: 'the licence credit names the ACCC',
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
    find: '    completeWindow: false,\n    revisionKey: \'modified\',\n    hubTitle: \'Canadian Product Recalls — StopHurting\',',
    replace: '    completeWindow: true,\n    revisionKey: \'modified\',\n    hubTitle: \'Canadian Product Recalls — StopHurting\',',
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
  {
    name: 'sanitiser allows every tag through',
    file: 'sources.mjs',
    find: "const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a']);",
    replace: "const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'script', 'h3', 'img', 'div']);",
    expect: 'strips everything it does not explicitly allow',
    why: 'foreign markup injected into our layout, up to and including a script tag',
  },
];

let caught = 0;
const missed = [];

console.log(`proving ${MUTATIONS.length} mutations are caught:\n`);

for (const m of MUTATIONS) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-mut-'));
  try {
    cpSync(HERE, dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
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
      out = execFileSync(process.execPath, [path.join(dir, m.suite || 'check-au-adapter.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
