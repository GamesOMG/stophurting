#!/usr/bin/env node
// Prove the four rails in fb-post.mjs actually REFUSE.
//
// ⛔ This drives the REAL script as a subprocess against fixture state files. It does NOT
// re-implement any of its logic. A stub only disagrees with the real thing on inputs nobody
// wrote a fixture for, and the rails here are the entire reason the page cannot be flooded.
//
// Every scenario is a REFUSAL test — each one must be seen saying no. Nothing here can publish:
// no scenario passes --commit, and the token file is pointed at a fixture, so even a bug that
// ignored --commit would fail to authenticate rather than post.
//
// Usage: node tools/recalls/check-fb-post.mjs

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so a mutation run can point this at a deliberately-broken copy and confirm each
// rail's own assertion is what catches it. A suite that has only ever been green proves nothing.
const SCRIPT = process.env.SH_FB_POST_SCRIPT || path.join(HERE, 'fb-post.mjs');
const tmp = mkdtempSync(path.join(tmpdir(), 'sh-fbpost-'));

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
let pass = 0, fail = 0;

function run(name, { seen, fbState, args = [] }, assert) {
  const stateFile = path.join(tmp, `${name}-state.json`);
  const fbFile = path.join(tmp, `${name}-fb.json`);
  const tokFile = path.join(tmp, `${name}-tok.txt`);
  writeFileSync(stateFile, JSON.stringify({ seen, indexnowKey: 'x' }));
  if (fbState !== null) writeFileSync(fbFile, JSON.stringify(fbState));
  writeFileSync(tokFile, '222728804264171\nFIXTURE-NOT-A-REAL-TOKEN-000000000000\n');
  let out;
  try {
    out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, SH_STATE_FILE: stateFile, SH_FB_STATE_FILE: fbFile, SH_FB_TOKEN_FILE: tokFile },
      encoding: 'utf8',
    });
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  try {
    assert(out);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}\n--- output ---\n${out}\n--------------`);
    fail++;
  }
}
const must = (out, needle, why) => {
  if (!out.includes(needle)) throw new Error(`expected ${JSON.stringify(needle)} — ${why}`);
};
const mustNot = (out, needle, why) => {
  if (out.includes(needle)) throw new Error(`did NOT expect ${JSON.stringify(needle)} — ${why}`);
};

const rec = (n, date) => [`id${n}`, { slug: `thing-${n}-recall-2600${n}`, prod: `Thing ${n}`, hazard: 'fall hazard', date, num: `2600${n}` }];

console.log('fb-post rails:');

// RAIL 1 — a virgin install must record backfill and post nothing, however fresh the recalls.
run('rail1-first-run-posts-nothing', {
  seen: Object.fromEntries([rec(1, day(-1)), rec(2, day(-2))]),
  fbState: null,
}, (out) => {
  must(out, 'FIRST RUN', 'the watermark run must announce itself');
  must(out, 'recorded 2 existing recalls as backfill', 'it must claim exactly what it saw');
  mustNot(out, 'Recalled: Thing', 'a first run must never compose a post');
});

// RAIL 1b — everything already in backfill stays unpostable forever, even when brand new.
run('rail1b-backfill-never-posts', {
  seen: Object.fromEntries([rec(1, day(0))]),
  fbState: { backfill: ['id1'], posted: {} },
}, (out) => {
  must(out, 'candidates  : 0', 'a backfilled recall must never become a candidate');
  mustNot(out, 'Recalled: Thing 1', 'a backfilled recall must never be composed');
});

// RAIL 2 — the age cutoff must drop old recalls even when they are NOT in backfill. This is the
// one that saves us if `build.mjs --rebuild` ever perturbs the watermark.
run('rail2-age-cutoff-drops-old', {
  seen: Object.fromEntries([rec(1, day(-400)), rec(2, day(-31)), rec(3, day(-1))]),
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, '2 older than 30d', 'both the 400-day and 31-day recalls must be refused');
  must(out, 'candidates  : 1', 'only the 1-day-old recall survives');
  must(out, 'Recalled: Thing 3', 'the fresh one must be composed');
  mustNot(out, 'Recalled: Thing 1', 'the 400-day-old recall must never be composed');
});

// RAIL 3 — the per-run cap must hold when a CPSC batch lands.
run('rail3-per-run-cap', {
  seen: Object.fromEntries([rec(1, day(-5)), rec(2, day(-4)), rec(3, day(-3)), rec(4, day(-2)), rec(5, day(-1))]),
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'candidates  : 5 (capping at 3 this run)', 'five candidates, three allowed');
  must(out, '3 would be published', 'exactly three compose');
  mustNot(out, 'Recalled: Thing 4', 'the fourth must wait for the next run');
});

// RAIL 3b — oldest first, so a busy week cannot starve an older unposted recall.
run('rail3b-oldest-first', {
  seen: Object.fromEntries([rec(9, day(-1)), rec(7, day(-20)), rec(8, day(-10))]),
  fbState: { backfill: [], posted: {} },
  args: ['--limit', '1'],
}, (out) => {
  must(out, 'Recalled: Thing 7', 'the oldest candidate goes first');
  mustNot(out, 'Recalled: Thing 9', 'the newest must not jump the queue');
});

// RAIL 4 — dry is the default. No --commit anywhere means no publish attempt, ever.
run('rail4-dry-by-default', {
  seen: Object.fromEntries([rec(1, day(-1))]),
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'DRY — nothing will be published', 'the mode line must say so out loud');
  must(out, '(dry)', 'each composed post must be marked dry');
  mustNot(out, '✅ posted', 'nothing may report as published');
});

// Idempotency — an already-posted recall must never be composed a second time.
run('no-double-post', {
  seen: Object.fromEntries([rec(1, day(-1)), rec(2, day(-1))]),
  fbState: { backfill: [], posted: { id1: { at: '2026-08-16T00:00:00Z', postId: '1_2' } } },
}, (out) => {
  must(out, '1 already posted', 'the posted one is counted as skipped');
  must(out, 'candidates  : 1', 'only the unposted one remains');
  mustNot(out, 'Recalled: Thing 1', 'a posted recall must never be recomposed');
});

// The post body itself — assembled from CPSC fields, carrying the canonical URL, no invention.
run('composes-from-cpsc-fields-only', {
  seen: { id1: { slug: 'crib-recall-26123', prod: 'Acme Drop-Side Crib', hazard: 'entrapment hazard', date: day(-1), num: '26123' } },
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'Recalled: Acme Drop-Side Crib', 'product comes from the record');
  must(out, 'Hazard: Entrapment', 'hazard comes from the record, sentence-cased');
  mustNot(out, 'Entrapment hazard', 'the label already says Hazard: — the duplicate word must be dropped');
  must(out, 'https://stophurting.org/recalls/crib-recall-26123/', 'the canonical URL must be the link');
});

// The de-dupe must not eat a hazard that merely CONTAINS the word mid-phrase.
run('hazard-dedupe-only-strips-the-tail', {
  seen: { id1: { slug: 'x-recall-1', prod: 'X', hazard: 'hazardous chemical exposure hazard', date: day(-1), num: '1' } },
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'Hazard: Hazardous chemical exposure', 'only the trailing word goes');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed · ${fail} failed`);
process.exitCode = fail ? 1 : 0;
