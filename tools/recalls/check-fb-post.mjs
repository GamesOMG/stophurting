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
  mustNot(out, 'Recalled in the US: Thing', 'a first run must never compose a post');
});

// RAIL 1b — everything already in backfill stays unpostable forever, even when brand new.
run('rail1b-backfill-never-posts', {
  seen: Object.fromEntries([rec(1, day(0))]),
  fbState: { backfill: ['id1'], posted: {} },
}, (out) => {
  must(out, 'candidates  : 0', 'a backfilled recall must never become a candidate');
  mustNot(out, 'Recalled in the US: Thing 1', 'a backfilled recall must never be composed');
});

// RAIL 2 — the age cutoff must drop old recalls even when they are NOT in backfill. This is the
// one that saves us if `build.mjs --rebuild` ever perturbs the watermark.
run('rail2-age-cutoff-drops-old', {
  seen: Object.fromEntries([rec(1, day(-400)), rec(2, day(-31)), rec(3, day(-1))]),
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, '2 older than 30d', 'both the 400-day and 31-day recalls must be refused');
  must(out, 'candidates  : 1', 'only the 1-day-old recall survives');
  must(out, 'Recalled in the US: Thing 3', 'the fresh one must be composed');
  mustNot(out, 'Recalled in the US: Thing 1', 'the 400-day-old recall must never be composed');
});

// RAIL 3 — the per-run cap must hold when a CPSC batch lands.
// RAIL 6 — one Facebook page, one country. Rails 1 and 2 are both blind to a foreign recall: it
// is not in the backfill (it did not exist when the watermark was written) and it is not old. So
// without this rail, the day Australia landed the US page would have started publishing
// Australian recalls — a phone number nobody reading it can call.
const auRec = ['au1', { slug: 'aussie-thing-recall', prod: 'Aussie Thing', hazard: 'fire hazard', date: day(-1), num: '', country: 'au' }];
// ⚠ --country us is now EXPLICIT here. The default was widened to every country on 2026-08-16,
// so a scenario relying on the old default would have been testing the default rather than the
// filter — and would have gone green for the wrong reason the day the default changed back.
run('rail6-other-country-never-posts', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
  args: ['--country', 'us'],
}, (out) => {
  must(out, 'country     : US', 'the run must state which country it is posting for');
  must(out, '1 other country', 'the Australian recall must be counted as refused, not silently dropped');
  must(out, 'candidates  : 1', 'only the US recall survives');
  must(out, 'Recalled in the US: Thing 1', 'the US recall must still be composed');
  mustNot(out, 'Recalled in Australia: Aussie Thing', 'an Australian recall must never reach the US page');
});

// The flag selects rather than widens — proving the filter is a real per-country switch and not
// a hardcoded "skip anything not US", which would quietly strand every future country.
run('rail6b-country-flag-selects-the-other-way', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
  args: ['--country', 'au'],
}, (out) => {
  must(out, 'country     : AU', 'the flag must be reflected in the header');
  must(out, 'Recalled in Australia: Aussie Thing', 'the Australian recall must be composed when AU is selected');
  mustNot(out, 'Recalled in the US: Thing 1', 'the US recall must be refused when AU is selected');
});

// ⭐ THE DEFAULT NOW CARRIES EVERY COUNTRY — his call, once the site had four of them and three
// were reaching nobody. The label on the first line has to name the country, because a recall is
// only actionable where it was issued: the retailer, the refund and the phone number are national.
run('default-posts-every-country-and-labels-each-one', {
  seen: Object.fromEntries([rec(1, day(-1)), auRec]),
  fbState: { backfill: [], posted: {} },
  args: ['--limit', '5'],
}, (out) => {
  must(out, 'country     : every country', 'the default must say plainly that it is not filtering');
  must(out, '0 other country', 'nothing may be refused for its country under the default');
  must(out, 'Recalled in the US: Thing 1', 'the US recall carries its country');
  must(out, 'Recalled in Australia: Aussie Thing', 'and so does the Australian one');
  mustNot(out, 'publishes on any weekday, so spreading over ~24h — 42', 'a mixed stream must not pace to the CPSC calendar');
});

// ── THE DAILY BUDGET AND ITS OVERFLOW ─────────────────────────────────────────────────────
// ⛔ The trap this design exists to avoid: a cap below the arrival rate (~4.4/day across four
// countries) does not reduce volume, it converts volume into SILENT LOSS — the surplus queues,
// the queue grows daily, and rail 2 then drops each one at 30 days old, never posted and never
// reported. So the overflow must be published, not merely capped.
const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => rec(i + 1, day(-1))));

run('budget-holds-the-overflow-for-the-digest', {
  seen: many(7),
  fbState: { backfill: [], posted: {} },
  args: ['--per-day', '3', '--digest-after', '99'],   // 99 = before the digest hour, always
}, (out) => {
  must(out, 'budget      : 3/day individually · 0 already today -> 3 this run', '');
  must(out, '4 held for the digest', 'the surplus must be accounted for, not silently dropped');
  must(out, 'digest      : 4 held for the end-of-day digest', 'and the run must say where they went');
});

run('digest-covers-everything-the-budget-did-not-reach', {
  seen: many(7),
  fbState: { backfill: [], posted: {} },
  args: ['--per-day', '3', '--digest-after', '0'],    // 0 = the digest hour has always passed
}, (out) => {
  must(out, '4 recall(s) held back — posting the daily digest', '');
  must(out, '4 more recalls today', 'the digest names how many it covers');
  must(out, 'stophurting.org/', 'and links somewhere the reader can see them all');
  mustNot(out, 'Recalled in the US: Thing 4', 'a digested recall must NOT also be posted individually');
});

run('digest-runs-once-a-day', {
  seen: many(7),
  fbState: { backfill: [], posted: {}, lastDigest: new Date().toISOString().slice(0, 10) },
  args: ['--per-day', '3', '--digest-after', '0'],
}, (out) => {
  mustNot(out, 'posting the daily digest', 'a second digest on the same day would double-post the overflow');
});

// ⛔ One leftover is worth more as itself than as a digest saying "1 more recall today".
run('a-single-leftover-is-posted-not-digested', {
  seen: many(4),
  fbState: { backfill: [], posted: {} },
  args: ['--per-day', '3', '--digest-after', '0'],
}, (out) => {
  must(out, 'only 1 held back — posting it individually instead', '');
  mustNot(out, 'posting the daily digest', '');
  must(out, 'Recalled in the US: Thing 4', 'the fourth is published rather than summarised');
});

// The budget is a DAY's budget, not a run's: a run later the same day gets what is left of it.
run('budget-counts-what-was-already-posted-today', {
  seen: many(7),
  fbState: {
    backfill: [],
    posted: { id1: { at: new Date().toISOString(), postId: 'p1', slug: 'thing-1-recall-26001' } },
  },
  args: ['--per-day', '3', '--digest-after', '99'],
}, (out) => {
  must(out, '1 already today -> 2 this run', 'one posted earlier today leaves two of the three');
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
  mustNot(out, 'Recalled in the US: Thing 1', 'no post may be composed on a backfill run');
});

run('rail3-per-run-cap', {
  seen: Object.fromEntries([rec(1, day(-5)), rec(2, day(-4)), rec(3, day(-3)), rec(4, day(-2)), rec(5, day(-1))]),
  fbState: { backfill: [], posted: {} },
  args: ['--limit', '3'],
}, (out) => {
  must(out, 'candidates  : 5 (2 held for the digest)', 'five candidates, three allowed, two accounted for');
  must(out, '3 would be published', 'exactly three compose');
  mustNot(out, 'Recalled in the US: Thing 4', 'the fourth must wait for the digest or the next day');
});

// ⛔ THE THREE PACING SCENARIOS THAT LIVED HERE TESTED A MECHANISM THAT NO LONGER EXISTS.
// They covered the "runs until the next CPSC Thursday" divisor, which spread one weekly batch
// across the week. That was replaced by the daily budget plus an end-of-day digest, because a
// divisor cannot express "a couple a day" and silently grew a backlog once four countries were
// publishing. Their coverage is not lost — it moved to the five budget/digest scenarios above,
// which assert the same properties (nothing floods, nothing starves, nothing is dropped) against
// the mechanism that actually ships. Deleted rather than left green over dead code.

run('rail3b-oldest-first', {
  seen: Object.fromEntries([rec(9, day(-1)), rec(7, day(-20)), rec(8, day(-10))]),
  fbState: { backfill: [], posted: {} },
  args: ['--limit', '1'],
}, (out) => {
  must(out, 'Recalled in the US: Thing 7', 'the oldest candidate goes first');
  mustNot(out, 'Recalled in the US: Thing 9', 'the newest must not jump the queue');
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
  mustNot(out, 'Recalled in the US: Thing 1', 'a posted recall must never be recomposed');
});

// The post body itself — assembled from CPSC fields, carrying the canonical URL, no invention.
run('composes-from-cpsc-fields-only', {
  seen: { id1: { slug: 'crib-recall-26123', prod: 'Acme Drop-Side Crib', hazard: 'entrapment hazard', date: day(-1), num: '26123' } },
  fbState: { backfill: [], posted: {} },
}, (out) => {
  must(out, 'Recalled in the US: Acme Drop-Side Crib', 'product comes from the record');
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
// ⛔⛔ RAIL 8's mode. The 404 card that reached the page on 2026-08-17 got past rail 7 because rail
// 7 probes from HERE and Facebook fetches from wherever it likes — so the fake has to be able to
// disagree with the fake SITE, which is the entire situation being guarded against. With one knob
// the suite could only ever model a world where our view and Facebook's agree, which is the world
// in which the bug does not exist.
let scrapeMode = 'good';
// The title our real 404 page carries. Asserted against 404.html below, so rewording the page
// cannot leave the detector matching nothing.
const NOT_FOUND_TITLE = 'Page not found — StopHurting';
const seenCalls = [];
const server = createServer((req, res) => {
  seenCalls.push(`${req.method} ${req.url.split('?')[0]}`);
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && req.url.includes('fields=access_token')) return send({ access_token: 'FAKE-PAGE-TOKEN' });
  // Rail 8: Facebook scrapes the URL itself and reports what it got.
  if (req.method === 'POST' && req.url.includes('scrape=true')) {
    return send({ id: 'URL_1', og_object: { title: scrapeMode === 'good' ? 'X Recall (August 2026)' : NOT_FOUND_TITLE } });
  }
  if (req.method === 'POST' && req.url.includes('/feed')) return send({ id: 'PAGE_POST_1' });
  if (req.method === 'GET' && req.url.includes('attachments')) {
    if (cardMode === 'none') return send({ id: 'PAGE_POST_1' });   // accepted the post, scraped nothing
    return send({ id: 'PAGE_POST_1', attachments: { data: [{
      url: 'https://stophurting.org/x/',
      media_type: 'link',
      title: cardMode === 'notfound' ? NOT_FOUND_TITLE : 'X Recall (August 2026)',
    }] } });
  }
  if (req.method === 'POST' && req.url.includes('/comments')) return send({ id: 'COMMENT_1' });
  // Rail 7 probes the recall page itself. A slug containing 'not-live' 404s, so the rail can be
  // seen REFUSING rather than only passing.
  if (req.method === 'GET' && req.url.includes('/recalls/')) {
    if (req.url.includes('not-live')) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>ok</html>');
  }
  send({});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ⭐ BACK-PRESSURE AT THE POINT OF USE. Both rails that catch a dead link do it by recognising our
// own 404 page's title — a string that lives in 404.html, which nobody editing that page would
// think to grep for. Reword the page and the detector silently matches nothing, which reads
// exactly like "no problems found". So the suite reads the real page and checks both ends.
try {
  // ⚠ SH_SITE_ROOT exists for mutations.mjs, which runs this suite from a COPY of tools/recalls in
  // a temp dir — where ../../404.html is not the site. Without it this assertion would fail on
  // every mutation run and drown the one failure the run is there to read.
  const root = process.env.SH_SITE_ROOT || path.resolve(HERE, '..', '..');
  const html404 = readFileSync(path.join(root, '404.html'), 'utf8');
  const title = (html404.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  if (title.trim() !== NOT_FOUND_TITLE) throw new Error(`404.html's title is "${title.trim()}" but this suite models "${NOT_FOUND_TITLE}"`);
  if (!/page not found/i.test(title)) throw new Error(`fb-post.mjs matches /page not found/i, which does not match 404.html's title "${title.trim()}"`);
  if (!readFileSync(SCRIPT, 'utf8').includes('/page not found/i')) throw new Error('fb-post.mjs no longer carries the pattern this suite pins');
  console.log('  ✅ the 404 detector still matches the real 404 page'); pass++;
} catch (e) { console.log(`  ❌ the 404 detector still matches the real 404 page\n     ${e.message}`); fail++; }

// 🪤 MUST be async. execFileSync blocks this process's event loop, so the in-process fake Graph
// could never answer the child — the child hung on fetch and the whole suite stalled forever.
// A synchronous subprocess and an in-process server cannot coexist.
const execFileAsync = promisify(execFile);
async function runPublish(name, mode, assert, opts = {}) {
  cardMode = mode;
  scrapeMode = opts.scrape || 'good';
  seenCalls.length = 0;
  const stateFile = path.join(tmp, `${name}-state.json`);
  const fbFile = path.join(tmp, `${name}-fb.json`);
  const tokFile = path.join(tmp, `${name}-tok.txt`);
  writeFileSync(stateFile, JSON.stringify({ seen: opts.seen || Object.fromEntries([rec(1, day(-1))]), indexnowKey: 'x' }));
  writeFileSync(fbFile, JSON.stringify({ backfill: [], posted: {} }));
  writeFileSync(tokFile, '222728804264171\nFIXTURE-NOT-A-REAL-TOKEN-000000000000\n');
  let out, code = 0;
  try {
    const r = await execFileAsync(process.execPath, [SCRIPT, '--commit', '--pause', '0', '--live-tries', '2', '--live-wait', '50', ...(opts.args || [])], {
      env: { ...process.env, SH_STATE_FILE: stateFile, SH_FB_STATE_FILE: fbFile, SH_FB_TOKEN_FILE: tokFile, SH_FB_GRAPH_BASE: base, SH_ORIGIN: base },
      encoding: 'utf8',
      timeout: 15000,
    });
    out = r.stdout;
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.code ?? 1; }
  const state = JSON.parse(readFileSync(fbFile, 'utf8'));
  // ⭐ THE EXIT CODE IS PART OF THE BEHAVIOUR, not incidental to it. The 404 card was detected,
  // printed and recorded — and the run exited 0, so Task Scheduler reported success and nobody
  // knew for seven hours. Asserting the message without the code would have passed that build.
  try { assert(out, state, seenCalls, code); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}\n--- output ---\n${out}\n--------------`); fail++; }
}

await runPublish('publish-records-post-id-and-card', 'rendered', (out, state, calls) => {
  must(out, '✅ posted PAGE_POST_1', 'the post id must be reported');
  if (state.posted.id1?.postId !== 'PAGE_POST_1') throw new Error('post id must be persisted to fb-state');
  if (state.posted.id1?.card !== 'rendered') throw new Error(`card should be "rendered", got ${state.posted.id1?.card}`);
  if (calls.some((c) => c.includes('/comments'))) throw new Error('a rendered card must NOT trigger a comment');
});

// ⛔⛔ RAIL 8 — the one that was missing on 2026-08-17. Our own probe said 200 ("live after 2
// check(s)" is in the run log), Facebook fetched the same URL seconds later and got the 404, and
// the post shipped reading "Page not found — StopHurting" under a real recall headline. The fake
// site here answers 200 exactly as production did, so this scenario is precisely the case rail 7
// cannot see: the ONLY thing wrong is what Facebook sees.
await runPublish('rail8-refuses-when-facebook-still-sees-the-404', 'rendered', (out, state, calls) => {
  must(out, 'facebook cannot see the page yet', 'the refusal must name its reason');
  if (calls.some((c) => c.includes('/feed'))) throw new Error('NOTHING may be published while Facebook is still being served the 404 page — that is the whole rail');
  if (Object.keys(state.posted).length) throw new Error('a refused recall must NOT be recorded, or it is lost instead of retried next run');
}, { scrape: 'notfound' });

// The other half of the same rail: it has to let a good page through, or it is just an outage.
await runPublish('rail8-publishes-once-facebook-has-the-real-page', 'rendered', (out, state, calls) => {
  must(out, 'facebook scraped: X Recall', 'the run must record what Facebook actually got, not that it asked');
  if (!calls.includes('POST /')) throw new Error('rail 8 must actually ask Facebook — a rail that makes no call is not a rail');
  if (state.posted.id1?.card !== 'rendered') throw new Error(`a good page must still publish normally, got ${state.posted.id1?.card}`);
});

// ⛔ THE BACKSTOP, for the day Facebook agrees to the scrape and snapshots something else anyway.
// Detecting it was never the gap — the run DID print this line on 2026-08-17. The gap was that it
// then exited 0 and left a recall notice on the page with no way to reach the recall.
await runPublish('a-404-card-gets-a-comment-and-fails-the-run', 'notfound', (out, state, calls, code) => {
  must(out, 'the card scraped our 404 page', 'the wrong card must be named');
  if (!calls.some((c) => c.includes('/comments'))) throw new Error('a 404 card leaves the post with no way to reach the recall — the URL must go in a comment');
  if (state.posted.id1?.card !== 'SCRAPED-404+comment') throw new Error(`the record must say what happened, got ${state.posted.id1?.card}`);
  if (code === 0) throw new Error('a post that is live and wrong CANNOT be repaired in place — the run must fail so a human hears about it');
  must(out, 'NEED A HUMAN', 'the run must say plainly that this one needs hands');
});

await runPublish('self-heals-when-no-card-renders', 'none', (out, state, calls) => {
  must(out, 'no link card', 'the missing card must be announced, not swallowed');
  must(out, 'posted the URL as a comment', 'the self-heal must fire');
  if (!calls.some((c) => c.includes('/comments'))) throw new Error('a comment must actually be posted');
  if (state.posted.id1?.card !== 'self-healed-comment') throw new Error(`card should record the self-heal, got ${state.posted.id1?.card}`);
});

// ⭐⭐ THE DIGEST'S PUBLISH PATH IS WHAT STOPS THE BACKLOG, so it is the part that must be seen
// working rather than reasoned about. Every recall it covers has to be RECORDED as posted — if it
// publishes but does not record, the same recalls are digested again tomorrow, and the day after,
// forever. Recording them is also what keeps them out of the individual queue.
await runPublish('digest-records-every-recall-it-covered', 'rendered', (out, state, calls) => {
  must(out, 'digest posted PAGE_POST_1 covering 4 recall(s)', 'the run must say exactly what it covered');
  const feedPosts = calls.filter((c) => c.includes('/feed')).length;
  if (feedPosts !== 4) throw new Error(`expected 3 individual posts + 1 digest = 4 feed calls, got ${feedPosts}`);
  const digested = Object.values(state.posted).filter((p) => p.digest);
  if (digested.length !== 4) throw new Error(`all 4 held-back recalls must be recorded, got ${digested.length} — anything unrecorded is digested again tomorrow`);
  if (!state.lastDigest) throw new Error('lastDigest must be stamped, or a second run today posts a second digest');
  const individual = Object.values(state.posted).filter((p) => !p.digest);
  if (individual.length !== 3) throw new Error(`the daily budget of 3 should have posted individually, got ${individual.length}`);
}, {
  seen: Object.fromEntries(Array.from({ length: 7 }, (_, i) => rec(i + 1, day(-1)))),
  args: ['--per-day', '3', '--digest-after', '0'],
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed · ${fail} failed`);
process.exitCode = fail ? 1 : 0;
