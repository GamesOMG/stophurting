#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   dead-refs — every asset a page points at must exist on disk.

   WHY THIS EXISTS (2026-08-09). On gamesomg-site, eleven rows of
   palworld-lifmunk-effigy-locations pointed at retired screenshot
   filenames: the FILES had been renamed and the HTML had not. The
   thumbnail, the lightbox and the JSON-LD ImageObject all 404'd, and
   every gate stayed green — because every check we had verifies that a
   DESTINATION exists, never that a POINTER resolves. Jason found it by
   looking at the live page.

   Ported here after the same scan found a dead link in this family of
   repos too. Scoped to ASSETS, not page links: a missing page is a
   redirect problem, a missing asset is a hole in the page.

   Reads three ref shapes, because missing two of the three looks like
   nothing is wrong:
     src=/href=        the visible <img> / <a>
     src:"…"           JS data blocks (lightbox chips and the like)
     "contentUrl":"…"  JSON-LD ImageObject — absolute, so it is unwrapped

   config.json:
     webroots  dirs a leading "/" may resolve against, in order. A repo
               that serves a built subdir (e.g. "site") needs it here, or
               every absolute ref reads as dead. Measured, not assumed.
     origins   our own hostnames, so absolute URLs to ourselves are
               checked and everyone else's are left alone.
     ignore    refs served from somewhere other than this repo.

   RUN:  node tools/dead-refs/check.mjs
   ════════════════════════════════════════════════════════════════ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WEBROOTS = cfg.webroots?.length ? cfg.webroots : [''];
const ORIGINS = cfg.origins || [];
const IGNORE = cfg.ignore || [];

const ASSET_EXT = /\.(webp|png|jpe?g|gif|svg|ico|avif|mp4|webm|css|js|json|woff2?)$/i;
const REF_RE = /(?:src|href|content|data-src)\s*=\s*"([^"]+)"|src\s*:\s*"([^"]+)"|"contentUrl"\s*:\s*"([^"]+)"|url\(([^)]+)\)/g;

// ⛔ EXCLUSIONS CARRY A WRITTEN REASON, one per entry. A skip list that grows silently is how a
// gate stops covering the thing it was built for.
//   · tools/*/fixtures — captured pages from OTHER people's websites, kept as parser input. They
//     are never served, never linked to, and never rendered to a reader; their hundreds of links
//     point at productsafety.gov.au's own site tree, so checking them against our disk is a
//     category error that buries every real finding under 200 lines of noise.
const SKIP_DIRS = [/(^|\/)tools\/[^/]+\/fixtures$/];
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const rel = path.relative(REPO, p).replace(/\\/g, '/');
      if (SKIP_DIRS.some((re) => re.test(rel))) continue;
      walk(p, acc);
    } else if (e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const dead = new Map();      // ref -> Set(pages)
let checked = 0;
const files = walk(REPO);
for (const abs of files) {
  const rel = path.relative(REPO, abs).replace(/\\/g, '/');
  const txt = fs.readFileSync(abs, 'utf8');
  for (const m of txt.matchAll(REF_RE)) {
    let u = (m[1] || m[2] || m[3] || m[4] || '').trim().replace(/^['"]|['"]$/g, '');
    if (!u) continue;
    u = u.split('#')[0].split('?')[0];
    if (!u || /^(data:|mailto:|tel:|javascript:)/i.test(u)) continue;
    // A ref built at runtime from a template string is not a static ref.
    // 🪤 This used to test for "'+" with no space and missed "' + r.slug + '", which the hub's
    // search results emit — so the gate blocked a good commit with a ref that does not exist as
    // written. A QUOTE CHARACTER is the reliable signal: a real static href or src can never
    // contain one, because it would have closed the attribute.
    if (/['"`]|\$\{/.test(u)) continue;
    if (/^\/\//.test(u) || /^https?:\/\//i.test(u)) {
      const host = u.replace(/^(?:https?:)?\/\//i, '').split('/')[0].replace(/^www\./i, '');
      if (!ORIGINS.includes(host)) continue;              // someone else's host
      u = u.replace(/^(?:https?:)?\/\/[^/]+/i, '') || '/';
    }
    if (!ASSET_EXT.test(u)) continue;
    if (IGNORE.includes(u)) continue;
    const cands = u.startsWith('/')
      ? WEBROOTS.map(w => path.posix.join(w, u.slice(1)))
      : [path.posix.join(path.posix.dirname(rel), u)];
    checked++;
    if (!cands.some(c => fs.existsSync(path.join(REPO, c)))) {
      if (!dead.has(u)) dead.set(u, new Set());
      dead.get(u).add(rel);
    }
  }
}

if (dead.size) {
  console.error(`\n✗ dead-refs: ${dead.size} asset(s) referenced but not on disk:\n`);
  for (const [u, from] of [...dead.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const l = [...from];
    console.error(`  • ${u}`);
    console.error(`      referenced by ${l.length}: ${l.slice(0, 4).join(', ')}${l.length > 4 ? ` +${l.length - 4} more` : ''}`);
  }
  console.error(`\n  Either the file was renamed and the pages were not updated, or the ref is a typo.`);
  console.error(`  Served from elsewhere? add it to tools/dead-refs/config.json "ignore".\n`);
  process.exit(1);
}
console.log(`✓ dead-refs: ${files.length} html, ${checked} asset ref(s) resolve.`);
