#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   dead-links — every INTERNAL link must resolve to a page that exists.

   WHY THIS IS SEPARATE FROM dead-refs (2026-08-16). dead-refs scopes
   itself to assets on purpose: "a missing page is a redirect problem, a
   missing asset is a hole in the page." That reasoning holds for a link
   to a page that moved. It does NOT cover what was found on myths/:

       href="\cortisol-cocktails\"      backslashes, not slashes
       <span class="chip">Myth check<\span>   malformed close tag

   Those are not redirect problems. They are markup that points nowhere
   and can never be fixed by a redirect, and they sat live in the hub
   until a human happened to read the file. Jason's constraint on this
   site is that it runs unattended — "I can't be checking things all the
   time" — so anything only a human would catch has to become a check.

   WHAT IT FLAGS
     · backslashes anywhere in an href (never valid in a URL path)
     · malformed closing tags of the form <\tag>
     · internal hrefs that resolve to no file on disk

   WHAT IT IGNORES
     external URLs, mailto:, tel:, #fragments, and query-only links.

   RUN:  node tools/dead-links/check.mjs
   ════════════════════════════════════════════════════════════════ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', '_port']);

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      htmlFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.html')) out.push(path.join(dir, e.name));
  }
  return out;
}

// A link target resolves if it maps to a real file. "/foo/" means foo/index.html.
function resolves(href) {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean || clean === '/') return true;
  let rel = clean.replace(/^\//, '');
  if (rel === '') return true;
  const asFile = path.join(REPO, rel.split('/').join(path.sep));
  if (fs.existsSync(asFile) && fs.statSync(asFile).isFile()) return true;
  const asIndex = path.join(asFile, 'index.html');
  return fs.existsSync(asIndex);
}

const problems = [];
const files = htmlFiles(REPO);
let checked = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(REPO, file).split(path.sep).join('/');
  // 🪤 Strip <script> first. The hub's search box builds rows in JS —
  //   href="/recalls/' + r.slug + '/"
  // which is a template, not a link, and reads as dead to any naive scan. Flagging it would
  // train us to ignore this check's output, which is worse than not having it.
  const html = raw.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Malformed closing tags — <\span> and friends. Invalid markup that browsers
  // render as text or silently swallow, taking the layout with it.
  for (const m of html.matchAll(/<\\\/?([a-z]+)>/gi)) {
    problems.push(`${rel}: malformed tag "${m[0]}" — backslash instead of "/"`);
  }

  for (const m of html.matchAll(/href="([^"]*)"/gi)) {
    const href = m[1];
    if (/^(https?:|mailto:|tel:|#|data:|javascript:)/i.test(href)) continue;
    checked++;
    if (href.includes('\\')) {
      problems.push(`${rel}: href="${href}" — contains a backslash; never valid in a URL path`);
      continue;                                   // already broken; resolving it is meaningless
    }
    if (!href.startsWith('/')) continue;          // relative links are rare here; absolute is the convention
    if (!resolves(href)) problems.push(`${rel}: href="${href}" — resolves to nothing on disk`);
  }
}

if (problems.length) {
  console.error(`✗ dead-links: ${problems.length} problem(s) across ${files.length} html file(s):`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.log(`✓ dead-links: ${files.length} html, ${checked} internal link(s) resolve.`);
