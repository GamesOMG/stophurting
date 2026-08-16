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

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
// RAIL 6 — one Facebook page, one country. Rails 1 and 2 are both blind to a foreign recall: it
// is not in the backfill (it did not exist when the watermark was written) and it is not old. So
// without this rail, the day Australia landed the US page would have started publishing
// Australian recalls — a phone number nobody reading it can call.
const auRec = ['au1', { slug: 'aussie-thing-recall', prod: 'Aussie Thing', hazard: 'fire hazard', date: day(-1), num: '', country: 'au' }];
run('rail6-other-country-never-posts', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'country     : US only', 'the run must state which country it is posting for');
  must(out, '1 other country', 'the Australian recall must be counted as refused, not silently dropped');
  must(out, 'candidates  : 1', 'only the US recall survives');
  must(out, 'Recalled: Thing 1', 'the US recall must still be composed');
  mustNot(out, 'Recalled: Aussie Thing', 'an Australian recall must never reach the US page');
});

// The flag selects rather than widens — proving the filter is a real per-country switch and not
// a hardcoded "skip anything not US", which would quietly strand every future country.
run('rail6b-country-flag-selects-the-other-way', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
  args: ['--country', 'au'],
}, (out) => {
  must(out, 'country     : AU only', 'the flag must be reflected in the header');
  must(out, 'Recalled: Aussie Thing', 'the Australian recall must be composed when AU is selected');
  mustNot(out, 'Recalled: Thing 1', 'the US recall must be refused when AU is selected');
});

// The operator action that made rails 1 and 6 independent. After three countries were added to
// the site, 220 recalls sat outside the backfill and the country filter was the only thing
// keeping them off a US page — one rail, on something that now runs unattended every four hours.
run('backfill-flag-records-everything-and-posts-nothing', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
  args: ['--backfill'],
}, (out) => {
  must(out, 'recorded 2 additional recall(s) as backfill', 'it must claim exactly what it recorded');
  must(out, 'Nothing was published', 'the backfill action must never publish, even with fresh recalls present');
  mustNot(out, 'Recalled: Thing 1', 'no post may be composed on a backfill run');
});

run('rail3-per-run-cap', {
  seen: Object.fromEntries([rec(1, day(-5)), rec(2, day(-4)), rec(3, day(-3)), rec(4, day(-2)), rec(5, day(-1))]),
  fbState: { backfill: [], posted: {} },
  args: ['--limit', '3'],
}, (out) => {
  must(out, 'candidates  : 5 (capping at 3 this run)', 'five candidates, three allowed');
  must(out, '3 would be published', 'exactly three compose');
  mustNot(out, 'Recalled: Thing 4', 'the fourth must wait for the next run');
});

// PACING — CPSC drops everything on a Thursday, so the cap is computed from how many runs remain
// before the next drop. A fixed cap would clear an 18-recall batch in 12 hours and then post
// nothing for six days. --runs-left makes this deterministic; production computes it from the clock.
run('paces-a-thursday-batch-across-the-week', {
  seen: Object.fromEntries(Array.from({ length: 18 }, (_, i) => rec(i + 20, day(-1)))),
  fbState: { backfill: [], posted: {} },
  args: ['--runs-left', '42'],
}, (out) => {
  must(out, '42 run(s) left', 'the pacing line must show the divisor');
  must(out, '-> 1/run', '18 recalls over 42 runs is 1 per run');
  must(out, '1 would be published', 'exactly one composes');
});

// ...and it CATCHES UP when runs have been missed, instead of falling permanently behind.
run('pacing-catches-up-when-runs-were-missed', {
  seen: Object.fromEntries(Array.from({ length: 18 }, (_, i) => rec(i + 40, day(-1)))),
  fbState: { backfill: [], posted: {} },
  args: ['--runs-left', '7'],
}, (out) => {
  must(out, '-> 3/run', '18 left with only 7 runs to go should raise the rate, clamped at the 3 ceiling');
});

// RAIL 3b — oldest first, so a busy week cannot starve an older unposted recall.
// ⭐ The pacing divisor follows the SOURCE's schedule, not the CPSC's calendar. Jason spotted the
// assumption: the other three regulators publish on every weekday (US is Thursday 134/134, but
// CA is Thu 29%, UK 15%, AU 20%). Pointing the old maths at a continuous publisher would divide a
// steady daily stream by up to 42 runs and fall permanently behind.
run('paces-a-continuous-publisher-over-a-day-not-a-week', {
  seen: Object.fromEntries([
    ['ca1', { slug: 'ca-a-recall', prod: 'CA A', hazard: 'fire hazard', date: day(-1), num: '', country: 'ca' }],
    ['ca2', { slug: 'ca-b-recall', prod: 'CA B', hazard: 'fire hazard', date: day(-1), num: '', country: 'ca' }],
    ['ca3', { slug: 'ca-c-recall', prod: 'CA C', hazard: 'fire hazard', date: day(-1), num: '', country: 'ca' }],
  ]),
  fbState: { backfill: [], posted: {} },
  args: ['--country', 'ca'],
}, (out) => {
  must(out, 'publishes on any weekday', 'the run must name the schedule it actually used');
  mustNot(out, 'drops weekly', 'Canada has no weekly drop day, and claiming one is the bug');
  must(out, '6 run(s) left', 'a continuous publisher spreads over ~24h — six 4-hourly runs, not up to 42');
});

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
  must(out, '[card] https://stophurting.org/us/recalls/crib-recall-26123/', 'the link must be the CANONICAL country-scoped URL, not the redirecting one');
});

// MEASURED on the first live post: Facebook folds the message behind "See more" after ~2 lines,
// which hid the hazard. The message must stay short enough to survive that fold, and must NOT
// carry a CTA line — Facebook strips its URL anyway and the card already does that job.
run('message-survives-the-see-more-fold', {
  seen: { id1: { slug: 'crib-recall-26123', prod: 'Acme Drop-Side Crib', hazard: 'entrapment hazard', date: day(-1), num: '26123' } },
  fbState: { backfill: [], posted: {} },
}, (out) => {
  const m = out.match(/\(message (\d+) chars/);
  if (!m) throw new Error('the dry run must report the message length');
  if (Number(m[1]) > 120) throw new Error(`message is ${m[1]} chars — over the ~120 fold budget`);
  mustNot(out, 'official CPSC notice', 'the CTA line must not come back; it is invisible behind the fold');
  const lines = out.split('\n').filter((l) => l.startsWith('   │ ') && !l.includes('[card]') && !l.includes('(message '));
  if (lines.length > 2) throw new Error(`message is ${lines.length} lines — two is the budget`);
});

// The de-dupe must not eat a hazard that merely CONTAINS the word mid-phrase.
run('hazard-dedupe-only-strips-the-tail', {
  seen: { id1: { slug: 'x-recall-1', prod: 'X', hazard: 'hazardous chemical exposure hazard', date: day(-1), num: '1' } },
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'Hazard: Hazardous chemical exposure', 'only the trailing word goes');
});

// ── PUBLISH PATH, against a local fake Graph ───────────────────────────────────────────────
// Everything above proves the rails REFUSE. Nothing above ever exercised an actual publish —
// and "we'll fix it when it breaks" is not a plan for the one code path that talks to a live
// page. The fake lets us drive --commit safely, including the failure we have not yet seen in
// the wild: Facebook accepting the post but rendering no link card.
console.log('\npublish path (fake Graph):');

const { createServer } = await import('node:http');
let cardMode = 'rendered';
const seenCalls = [];
const server = createServer((req, res) => {
  seenCalls.push(`${req.method} ${req.url.split('?')[0]}`);
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && req.url.includes('fields=access_token')) return send({ access_token: 'FAKE-PAGE-TOKEN' });
  if (req.method === 'POST' && req.url.includes('/feed')) return send({ id: 'PAGE_POST_1' });
  if (req.method === 'GET' && req.url.includes('attachments')) {
    return send(cardMode === 'rendered'
      ? { id: 'PAGE_POST_1', attachments: { data: [{ url: 'https://stophurting.org/x/', media_type: 'link' }] } }
      : { id: 'PAGE_POST_1' });                       // Facebook accepted the post but scraped nothing
  }
  if (req.method === 'POST' && req.url.includes('/comments')) return send({ id: 'COMMENT_1' });
  send({});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 🪤 MUST be async. execFileSync blocks this process's event loop, so the in-process fake Graph
// could never answer the child — the child hung on fetch and the whole suite stalled forever.
// A synchronous subprocess and an in-process server cannot coexist.
const execFileAsync = promisify(execFile);
async function runPublish(name, mode, assert) {
  cardMode = mode;
  seenCalls.length = 0;
  const stateFile = path.join(tmp, `${name}-state.json`);
  const fbFile = path.join(tmp, `${name}-fb.json`);
  const tokFile = path.join(tmp, `${name}-tok.txt`);
  writeFileSync(stateFile, JSON.stringify({ seen: Object.fromEntries([rec(1, day(-1))]), indexnowKey: 'x' }));
  writeFileSync(fbFile, JSON.stringify({ backfill: [], posted: {} }));
  writeFileSync(tokFile, '222728804264171\nFIXTURE-NOT-A-REAL-TOKEN-000000000000\n');
  let out;
  try {
    const r = await execFileAsync(process.execPath, [SCRIPT, '--commit', '--pause', '0'], {
      env: { ...process.env, SH_STATE_FILE: stateFile, SH_FB_STATE_FILE: fbFile, SH_FB_TOKEN_FILE: tokFile, SH_FB_GRAPH_BASE: base },
      encoding: 'utf8',
      timeout: 15000,
    });
    out = r.stdout;
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const state = JSON.parse(readFileSync(fbFile, 'utf8'));
  try { assert(out, state, seenCalls); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}\n--- output ---\n${out}\n--------------`); fail++; }
}

await runPublish('publish-records-post-id-and-card', 'rendered', (out, state, calls) => {
  must(out, '✅ posted PAGE_POST_1', 'the post id must be reported');
  if (state.posted.id1?.postId !== 'PAGE_POST_1') throw new Error('post id must be persisted to fb-state');
  if (state.posted.id1?.card !== 'rendered') throw new Error(`card should be "rendered", got ${state.posted.id1?.card}`);
  if (calls.some((c) => c.includes('/comments'))) throw new Error('a rendered card must NOT trigger a comment');
});

await runPublish('self-heals-when-no-card-renders', 'none', (out, state, calls) => {
  must(out, 'no link card', 'the missing card must be announced, not swallowed');
  must(out, 'posted the URL as a comment', 'the self-heal must fire');
  if (!calls.some((c) => c.includes('/comments'))) throw new Error('a comment must actually be posted');
  if (state.posted.id1?.card !== 'self-healed-comment') throw new Error(`card should record the self-heal, got ${state.posted.id1?.card}`);
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed · ${fail} failed`);
process.exitCode = fail ? 1 : 0;
