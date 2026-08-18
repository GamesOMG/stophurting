#!/usr/bin/env node
// StopHurting — post NEW recalls to the Stop Hurting Facebook page.
//
// The model is SYNDICATION, not reach: pages don't reach mom groups, people share INTO them.
// Each recall page's og:image already carries the CPSC product photo, so the share card shows
// the actual recalled item. This script's whole job is to put a link where a human can share it.
//
// NO AI IN THE LOOP, same promise as build.mjs — every word of every post is assembled from the
// CPSC record's own fields. If a field is missing, the line is omitted rather than invented.
//
// Usage:
//   node tools/recalls/fb-post.mjs                 # DRY: show exactly what would be posted
//   node tools/recalls/fb-post.mjs --commit        # actually publish
//   node tools/recalls/fb-post.mjs --limit 1       # cap this run (default 3)
//   node tools/recalls/fb-post.mjs --max-age 45    # widen the age cutoff (default 30 days)
//   node tools/recalls/fb-post.mjs --per-day 3     # individual posts per day (rest -> digest)
//   node tools/recalls/fb-post.mjs --no-digest     # individual posts only, hold the overflow
//   node tools/recalls/fb-post.mjs --backfill      # record all known recalls as never-postable
//
// Credential: C:\Users\ImNot\.secrets\stophurting-fb-token.txt
//   line 1 = page NODE id (222728804264171 — NOT the URL id 61557134872247, see fb-check-token.mjs)
//   line 2 = SYSTEM-USER token (never expires; business-portfolio owned, so a password change
//            or app revocation cannot kill it — that is why it is not a user token)
// A PAGE token is derived per run from the system-user token, so a rotated page token can
// never strand this.
//
// ── THE RAILS, each guarding a specific way this could embarrass us ───────────────────────
// 1. BACKFILL WATERMARK. state.seen holds every recall ever generated, none of them posted.
//    Without a watermark the first run is a flood on a page that has never posted anything. So
//    the FIRST run posts NOTHING and records what it saw. --backfill re-arms this when a new
//    country is added to the site, which is what makes rails 1 and 6 independent.
// 2. AGE CUTOFF. Nothing older than --max-age days is posted, whatever the watermark says.
// 3. DAILY BUDGET + DIGEST. --per-day posts individually; everything else goes out in ONE digest
//    at the end of the day. ⛔ A cap without a digest is not a cap, it is silent loss: the surplus
//    queues, and rail 2 then drops each one at 30 days old, never posted and never reported.
// 4. DRY BY DEFAULT. Nothing publishes without --commit, and every skip prints its reason.
// 5. LINK OR IT DID NOT HAPPEN. The URL is not in the message (Facebook strips it and renders the
//    card), so every publish re-fetches its own attachments and comments the URL if none rendered.
// 6. COUNTRY. Every country is posted by default, each labelled in the first line — a recall is
//    only actionable where it was issued. --country us restricts it again.
//
// State: tools/recalls/fb-state.json — deliberately SEPARATE from state.json, which build.mjs
// rewrites wholesale on every run; sharing one file invites a lost update between the two tools.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable ONLY so the rails can be driven against fixtures by check-fb-post.mjs. A guard
// that has never been seen refusing is indistinguishable from no guard — and this file's whole
// job is refusing. Production passes none of these; the defaults are the real paths.
const STATE_FILE = process.env.SH_STATE_FILE || path.join(HERE, 'state.json');
const FB_STATE_FILE = process.env.SH_FB_STATE_FILE || path.join(HERE, 'fb-state.json');
const TOKEN_FILE = process.env.SH_FB_TOKEN_FILE || 'C:\\Users\\ImNot\\.secrets\\stophurting-fb-token.txt';
// Overridable so check-fb-post.mjs can point rail 7 at its fake server; production never sets it.
const ORIGIN = process.env.SH_ORIGIN || 'https://stophurting.org';
// Overridable only so check-fb-post.mjs can point the publish path at a local fake Graph. The
// publish path cannot otherwise be tested without publishing, and an untested publish path is
// where the "we'll fix it when it breaks" bugs live.
const GRAPH = process.env.SH_FB_GRAPH_BASE || 'https://graph.facebook.com/v21.0';

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const COMMIT = process.argv.includes('--commit');

// ⭐⭐ ALL FOUR COUNTRIES, his call 2026-08-16: "if we are doing more than just the US, we should
// not be waiting until thursday to start the other ones."
// It was 'us' only, set when the site WAS only the US, and it quietly stopped being right the day
// Australia landed: three countries' recalls were reaching the site and none of them reached the
// page. The page went silent for six days a week while ~26 recalls a week went unpublished.
// ⛔ AND THE ARGUMENT FOR KEEPING IT US-ONLY WAS BUILT ON TWO THINGS I MADE UP, both corrected by
// Jason on the spot: that the page had a US following to protect (it has no followers at all —
// one post), and that a Facebook audience is American (Facebook is global, and most of its users
// are not in the US). Neither was measured. The "US mom groups" note in the project file was
// about where readers SHARE recalls INTO, which says nothing about who follows a page.
// What remains true is only this: a reader has to know which country a notice applies to before
// acting on it, which is a labelling problem, not a reason to withhold three countries.
// ⛔ The 220 pre-existing foreign recalls were recorded as backfill BEFORE this changed, so
// widening the filter cannot replay them: only recalls first seen from now on are candidates.
// That ordering was not luck, and reversing it would have flooded the page.
const COUNTRY_ARG = argOf('--country', 'all');
const POST_COUNTRIES = COUNTRY_ARG === 'all' ? null : COUNTRY_ARG.split(',').map((s) => s.trim());
const postsCountry = (cc) => POST_COUNTRIES === null || POST_COUNTRIES.includes(cc);
const COUNTRY_LABEL = POST_COUNTRIES === null ? 'every country' : POST_COUNTRIES.join(', ').toUpperCase();
// ⭐⭐ A DAILY BUDGET, NOT A BATCH-SPREADING DIVISOR — his call once he saw the volume.
// Measured across our own records: US 13.4/wk · CA 7.7 · UK 4.7 · AU 5.1 = ~31/week, ~4.4/day,
// and that doubles if the site doubles its countries. Posting all of them is 5+ near-identical
// posts a day and grows without limit.
// ⛔ But a CAP ALONE IS NOT THE ANSWER, and this is the part that is easy to get wrong: a cap
// below the arrival rate does not reduce volume, it converts volume into SILENT LOSS. The
// unposted ones queue, the queue grows every day, and rail 2 then drops each one when it turns 30
// days old — never posted, never reported. So the overflow has to GO somewhere.
// It goes into one digest post at the end of the day. Volume stays flat at (budget + 1) posts per
// day no matter how many countries are added, and nothing is dropped.
// This replaces the old "runs until the next CPSC Thursday" divisor entirely: that existed to
// spread one weekly batch, and a daily budget does the same job for any mix of sources without
// knowing anybody's publishing calendar.
const MAX_PER_RUN = 3;          // never more than this in a single run, whatever the budget says
const INDIVIDUAL_PER_DAY = Number(argOf('--per-day', 3));
// The last scheduled run of the day. The task fires every 4h from 15:19, so the final run before
// midnight lands at 23:19; anything from 20:00 counts. ⚠ It is "the first run after this hour that
// has not already digested today", not "the 23:19 run" — a missed run must not cost a whole day's
// digest, and a machine that was asleep should still send one when it wakes.
const DIGEST_AFTER_HOUR = Number(argOf('--digest-after', 20));
const NO_DIGEST = process.argv.includes('--no-digest');
// ⭐⭐ THE THURSDAY MATHS IS A PROPERTY OF THE CPSC, NOT OF RECALLS. Jason asked the right
// question — "the other places don't just post on Thursdays, so why are we waiting?" — and the
// answer is that we are not waiting for Thursday, we are waiting for the CPSC, which only moves
// on Thursday. Re-measured 2026-08-16 against our own 354 records:
//     US 134 recalls — Thursday 134, every single one, 100%
//     AU  25 — Mon 2 · Tue 4 · Wed 7 · Thu 5 · Fri 7      (Thu 20%)
//     CA  96 — Mon 6 · Tue 18 · Wed 19 · Thu 28 · Fri 23 · Sat 2   (Thu 29%)
//     UK  99 — Mon 19 · Tue 29 · Wed 15 · Thu 15 · Fri 21 (Thu 15%)
// ⛔ SO THE PACING IS ONLY VALID FOR A US LANE, and nothing used to enforce that. Point this at
// Canada and it would divide a steady daily stream by "runs until Thursday" — up to 42 — and
// dribble out one post per run while recalls piled up faster than it published.
// A source that publishes on a weekly drop wants the batch spread until the next drop. A source
// that publishes continuously wants a flat rate. So the schedule is declared per country and the
// divisor follows it, instead of one regulator's calendar being baked in as if it were a fact
// about the world.
const EXPLICIT_LIMIT = process.argv.includes('--limit') ? Number(argOf('--limit', 3)) : null;
const MAX_AGE_DAYS = Number(argOf('--max-age', 30));
// ⭐ Operator action, run once when a country is added to the SITE but not to the Facebook lane.
// After Australia, Canada and the UK landed, 220 recalls sat outside the backfill and RAIL 6 WAS
// THE ONLY THING keeping them off a US page. One rail is not a rail on something that runs
// unattended every four hours: a typo in the country filter, or somebody running --country ca to
// see what would happen, and the page takes a 220-post flood. Recording them as backfill makes
// rails 1 and 6 independent, so either alone is sufficient.
// ⚠ It is a one-way door for those specific recalls: if a country ever gets its own page, its
// backfilled entries stay unpostable. That is the same trade the original 134 took, and by then
// they are old news anyway — a new page wants current recalls, not a three-month archive dump.
const BACKFILL_NOW = process.argv.includes('--backfill');
const PAUSE_MS = Number(argOf('--pause', 45000));

const mask = (s) => (!s ? '(empty)' : `${s.slice(0, 6)}…${s.slice(-4)} (len ${s.length})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the post text ----------
// Assembled from the stored card fields (which build.mjs derived from the CPSC record). Kept
// deliberately flat and factual: this is a safety notice, not marketing. No emoji, no urgency
// language, no "SHARE THIS!" — the people who share these are the audience, and they can tell.
// 🪤 MEASURED ON THE FIRST LIVE POST (2026-08-16), not reasoned about: Facebook collapses the
// message behind "See more" after roughly two lines. The original fourth line — "What was sold,
// what to do, and the official CPSC notice:" plus the URL — was invisible behind that fold AND
// its URL was stripped by Facebook anyway (the link becomes the card). So it cost us the fold
// and bought nothing. TWO LINES ONLY, and the card carries the call to action: it already shows
// STOPHURTING.ORG, the full recall headline and the CPSC product photo.
// ⛔ Do not re-add a CTA line. It will not be seen, and it pushes the hazard behind the fold —
// the hazard is the single most important thing in the post.
function compose(rec) {
  // ⚠ Must match build.mjs's recallPath(). The old /recalls/<slug>/ still 301s, but posting a
  // redirecting URL to Facebook means the card is scraped from the redirect target while the
  // link people share carries the stale path — and every share compounds it. Post the canonical.
  const url = `${ORIGIN}/${rec.country || 'us'}/recalls/${rec.slug}/`;
  // build.mjs's hazardShort() always ends the phrase with the word "hazard", so under a
  // "Hazard:" label it reads "Hazard: Fire and Burn hazard". Drop the duplicate — this removes
  // a repeated word, it does not reword CPSC's phrasing.
  const hazard = String(rec.hazard || '').trim().replace(/\s+hazards?$/i, '');
  // ⭐ THE COUNTRY GOES IN THE FIRST LINE, now that the page carries four of them. A recall is
  // only actionable where it was issued — the retailer, the refund and the phone number are all
  // national — so "which country is this" has to survive the "See more" fold, which cuts after
  // about two lines. Putting it in line one costs a few characters and answers the question
  // before anyone clicks.
  // ⛔ Still TWO LINES. Do not add a third for the country: the hazard is the most important
  // thing in the post and must not be pushed behind the fold to make room.
  const where = { us: 'the US', au: 'Australia', ca: 'Canada', uk: 'the UK' }[rec.country || 'us'];
  const lines = [`Recalled in ${where}: ${rec.prod}`];
  if (hazard) lines.push(`Hazard: ${hazard.charAt(0).toUpperCase() + hazard.slice(1)}`);
  return { message: lines.join('\n'), link: url };
}

// Waits for a URL to actually serve 200. Overridable so the checks can drive it without hitting
// the network, and so a slow deploy does not stall a run forever.
const LIVE_TRIES = Number(argOf('--live-tries', 6));
const LIVE_WAIT_MS = Number(argOf('--live-wait', 15000));
async function urlIsLive(url) {
  for (let i = 1; i <= LIVE_TRIES; i++) {
    try {
      // ⚠ GET, not HEAD. Cloudflare Pages answers HEAD for a path it will 404 on GET, so a HEAD
      // check would have called this page live and posted the dead card anyway.
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'stophurting-recalls/1.0' } });
      if (res.status === 200) { if (i > 1) console.log(`   │ live after ${i} check(s)`); return true; }
      if (i === 1) console.log(`   │ not live yet (HTTP ${res.status}) — waiting for the deploy`);
    } catch { /* network hiccup: treat as not-live and retry */ }
    if (i < LIVE_TRIES) await sleep(LIVE_WAIT_MS);
  }
  return false;
}

// The site's 404 page carries no og:title, so Facebook falls back to its <title> — this exact
// string is what a card reads when it scraped a page that was not there yet.
// ⚠ check-fb-post.mjs asserts this still matches the real 404.html. A detector that quietly stops
// detecting because somebody reworded a page is the failure this whole file exists to prevent.
const NOT_FOUND_TITLE = /page not found/i;

// ⛔⛔ RAIL 8 — OUR 200 IS NOT FACEBOOK'S 200, AND ONLY FACEBOOK'S DECIDES WHAT THE CARD SHOWS.
// Jason found the same broken post on the page TWICE in one day. Rail 7 was not bypassed and did
// not fail: the run log reads "not live yet (HTTP 404) … live after 2 check(s)" and then the post
// shipped reading "Page not found — StopHurting" under a real recall headline. Rail 7 did exactly
// what it was written to do and it was not enough, because it proved the wrong thing.
// A Cloudflare Pages deploy does not reach every edge at the same instant. Our probe was answered
// by IAD; Facebook's crawler asked some other PoP seconds later and was still served the 404. So
// "this machine can fetch the page" was never the precondition — "Facebook can fetch the page" is.
// ⭐ So make FACEBOOK the prober. POST ?id=<url>&scrape=true fetches the URL as the crawler and
// returns the og properties it actually got. That is the real path, checked through the real path,
// which is the only kind of guard worth having — and because the scrape POPULATES the URL cache
// the post will render from, it removes the race rather than narrowing it.
// 🪤 A card is snapshotted at post creation and Facebook does NOT retroactively fix it (measured
// last session: re-scraping updated the cache and left both live posts still reading "Page not
// found"). There is no repair after the fact short of deleting and re-posting, which is why this
// has to be settled BEFORE the feed call.
async function fbPreviewIsGood(url, pageToken) {
  let last = '';
  for (let i = 1; i <= LIVE_TRIES; i++) {
    // id + scrape go in the QUERY STRING, which is the documented form of this call; the token
    // rides the body like every other write.
    const r = await graph('/', { access_token: pageToken }, 'POST', { id: url, scrape: 'true' });
    const title = r.ok ? String(r.data.og_object?.title || r.data.title || '') : '';
    last = r.ok ? (title || '(no title)') : r.error;
    if (title && !NOT_FOUND_TITLE.test(title)) {
      console.log(`   │ facebook scraped: ${title}${i > 1 ? ` (after ${i} scrape(s))` : ''}`);
      return true;
    }
    if (i === 1) console.log(`   │ facebook still sees "${last}" — waiting before it snapshots the card`);
    if (i < LIVE_TRIES) await sleep(LIVE_WAIT_MS);
  }
  console.log(`   │ facebook never got a real page — last scrape: ${last}`);
  return false;
}

// ---------- the digest ----------
// ⭐ ONE post carrying everything the daily budget did not reach. This is what makes the volume
// flat: however many countries the site adds, the page publishes (budget + 1) posts a day.
// ⛔ NO AI here either — it counts records and lists their own product names.
// ⚠ TWO LINES, like every other post, because the "See more" fold cuts after about two. The first
// line is the count and the countries (the reader's "does this concern me"), the second is the
// actual product names, so the post is useful even to someone who never clicks. The card comes
// from the homepage, which already lists the newest recalls from every country.
function composeDigest(recs) {
  const where = { us: 'the US', au: 'Australia', ca: 'Canada', uk: 'the UK' };
  const counts = {};
  for (const r of recs) counts[r.country || 'us'] = (counts[r.country || 'us'] || 0) + 1;
  const byCountry = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cc, n]) => `${n} in ${where[cc] || cc.toUpperCase()}`)
    .join(', ');
  // Name as many products as fit, then say how many are left rather than trailing off.
  const names = recs.map((r) => r.prod);
  let listed = [];
  for (const n of names) {
    const next = [...listed, n].join(' · ');
    if (next.length > 150) break;
    listed.push(n);
  }
  const rest = names.length - listed.length;
  const line2 = listed.join(' · ') + (rest > 0 ? ` + ${rest} more` : '');
  return {
    message: `${recs.length} more recalls today: ${byCountry}.\n${line2}`,
    link: `${ORIGIN}/`,
  };
}

async function postDigest(recs, fb, today, pageId, sysToken, posted) {
  const { message, link } = composeDigest(recs);
  console.log(`digest      : ${recs.length} recall(s) held back — posting the daily digest`);
  console.log(message.split('\n').map((l) => `   │ ${l}`).join('\n'));
  console.log(`   │ [card] ${link}`);
  if (!COMMIT) { console.log('   └ (dry)\n'); return; }

  const pt = await graph(`/${pageId}`, { fields: 'access_token', access_token: sysToken });
  if (!pt.ok || !pt.data.access_token) {
    console.error(`❌ could not derive a page token — ${pt.ok ? 'no access_token field' : pt.error}`);
    process.exitCode = 1;
    return;
  }
  const r = await graph(`/${pageId}/feed`, { message, link, access_token: pt.data.access_token }, 'POST');
  if (!r.ok) {
    // ⛔ Nothing is recorded on failure. The digest retries on the next run, which is still today.
    console.log(`   └ ❌ ${r.error}\n`);
    process.exitCode = 1;
    return;
  }
  // ⭐ Each digested recall is recorded as POSTED, with digest:true. That is what stops the
  // backlog: they are accounted for and never become candidates again. The flag distinguishes
  // them from individual posts so the daily budget does not count the digest against itself.
  const at = new Date().toISOString();
  for (const rec of recs) posted[rec.id] = { at, postId: r.data.id, slug: rec.slug, digest: true };
  fb.posted = posted;
  fb.lastDigest = today;
  writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1));
  console.log(`   └ ✅ digest posted ${r.data.id} covering ${recs.length} recall(s)\n`);
}

// ---------- graph ----------
async function graph(pathname, params, method = 'GET', query = null) {
  const url = new URL(GRAPH + pathname);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (method === 'GET') url.searchParams.set(k, v);
    else body.set(k, v);
  }
  // Some Graph writes take their subject in the query string even though they are POSTs — the
  // scrape call is one. Kept separate from `params` so a POST body stays a POST body.
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const j = await res.json().catch(() => ({}));
  // Meta answers 200 with an `error` object often enough that status alone lies.
  if (j.error) return { ok: false, error: `${j.error.type || 'error'} ${j.error.code}: ${j.error.message}` };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, data: j };
}

async function main() {
  if (!existsSync(TOKEN_FILE)) {
    console.error(`❌ no credential at ${TOKEN_FILE} — run tools/fb-check-token.mjs first.`);
    process.exitCode = 1;
    return;
  }
  const [pageId, sysToken] = readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const fb = existsSync(FB_STATE_FILE)
    ? JSON.parse(readFileSync(FB_STATE_FILE, 'utf8'))
    : null;

  // ── RAIL 1: first run establishes the watermark and posts nothing ──────────
  if (!fb) {
    const backfill = Object.keys(state.seen);
    const next = {
      _note: 'Recall IDs in `backfill` predate the Facebook lane and must NEVER be posted. '
           + 'Written once, on the first run of fb-post.mjs. Deleting this file would make the '
           + 'entire archive look unposted and flood the page — keep it committed.',
      backfilledAt: new Date().toISOString(),
      backfill,
      posted: {},
    };
    writeFileSync(FB_STATE_FILE, JSON.stringify(next, null, 1));
    console.log(`FIRST RUN — recorded ${backfill.length} existing recalls as backfill. Nothing posted.`);
    console.log(`Only recalls first seen AFTER now are candidates. Re-run to post those.`);
    return;
  }

  const backfill = new Set(fb.backfill || []);
  const posted = fb.posted || {};

  if (BACKFILL_NOW) {
    const added = Object.keys(state.seen).filter((id) => !backfill.has(id) && !posted[id]);
    for (const id of added) backfill.add(id);
    fb.backfill = [...backfill];
    fb.backfilledAt = new Date().toISOString();
    writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1));
    console.log(`recorded ${added.length} additional recall(s) as backfill — ${backfill.size} total, none of them ever postable.`);
    console.log('Nothing was published. Re-run without --backfill to post.');
    return;
  }
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);

  // ── candidates, with every rejection reason printed rather than silently dropped ──
  const skipped = { backfill: 0, alreadyPosted: 0, tooOld: 0, otherCountry: 0 };
  const candidates = [];
  for (const [id, rec] of Object.entries(state.seen)) {
    // RAIL 6, checked first so the counts read honestly: a recall skipped for being Australian
    // should not also be reported as "too old".
    if (!postsCountry(rec.country || 'us')) { skipped.otherCountry++; continue; }
    if (backfill.has(id)) { skipped.backfill++; continue; }
    if (posted[id]) { skipped.alreadyPosted++; continue; }
    if ((rec.date || '') < cutoff) { skipped.tooOld++; continue; }   // RAIL 2
    candidates.push({ id, ...rec });
  }
  candidates.sort((a, b) => (a.date || '').localeCompare(b.date || ''));  // oldest first, so nothing starves

  console.log(`page        : ${pageId}`);
  console.log(`token       : ${mask(sysToken)}`);
  console.log(`known       : ${Object.keys(state.seen).length} recalls`);
  console.log(`country     : ${COUNTRY_LABEL}`);
  console.log(`skipped     : ${skipped.otherCountry} other country · ${skipped.backfill} backfill · ${skipped.alreadyPosted} already posted · ${skipped.tooOld} older than ${MAX_AGE_DAYS}d`);
  // ── the daily budget ───────────────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const postedToday = Object.values(posted).filter((p) => String(p.at || '').slice(0, 10) === today && !p.digest).length;
  const budgetLeft = Math.max(0, INDIVIDUAL_PER_DAY - postedToday);
  const LIMIT = EXPLICIT_LIMIT !== null ? EXPLICIT_LIMIT : Math.min(MAX_PER_RUN, budgetLeft);
  console.log(`budget      : ${INDIVIDUAL_PER_DAY}/day individually · ${postedToday} already today -> ${LIMIT} this run${EXPLICIT_LIMIT !== null ? ' (--limit override)' : ''}`);
  console.log(`candidates  : ${candidates.length}${candidates.length > LIMIT ? ` (${candidates.length - LIMIT} held for the digest)` : ''}`);
  console.log(`mode        : ${COMMIT ? '🔴 COMMIT — will publish' : 'DRY — nothing will be published'}\n`);

  // ── the end-of-day digest ──────────────────────────────────────────────────────────────
  // ⭐ Everything the budget did not reach goes out in ONE post at the end of the day, so the
  // overflow is published rather than queued. Without this, a budget below the arrival rate grows
  // a backlog until rail 2 drops each recall at 30 days old — unposted, unreported, and invisible.
  // ⚠ Fires on the FIRST run at or after DIGEST_AFTER_HOUR that has not already digested today,
  // not on a specific run: a missed run, or a machine that was asleep, must not cost the day's
  // digest entirely.
  const hour = new Date().getHours();
  const digestDue = !NO_DIGEST && hour >= DIGEST_AFTER_HOUR && fb.lastDigest !== today;
  // ⛔ ONE leftover is posted normally rather than digested: "1 more recall today" is a worse post
  // than the recall itself, and publishing it costs nothing.
  const soloLeftover = digestDue && candidates.length === LIMIT + 1;
  const batch = candidates.slice(0, soloLeftover ? LIMIT + 1 : LIMIT);          // RAIL 3
  const forDigest = candidates.slice(batch.length);
  if (soloLeftover) console.log('digest      : only 1 held back — posting it individually instead\n');
  else if (digestDue && forDigest.length) console.log(`digest      : due — ${forDigest.length} will be summarised after the individual posts\n`);
  else if (digestDue) console.log('digest      : due, but nothing was held back today\n');
  else if (!NO_DIGEST && forDigest.length) console.log(`digest      : ${forDigest.length} held for the end-of-day digest (after ${DIGEST_AFTER_HOUR}:00)\n`);

  // 🪤 THE DIGEST RUNS AFTER THE BATCH, NOT INSTEAD OF IT. The first version returned as soon as
  // it had digested, which skipped the day's individual posts entirely — so on a day when every
  // recall arrived after the digest hour, all seven would have been summarised in one line and
  // none of them featured. Caught by asserting the call count against the fake Graph: one feed
  // call where there should have been four.
  const runDigest = async () => {
    if (digestDue && forDigest.length) await postDigest(forDigest, fb, today, pageId, sysToken, posted);
    else if (digestDue) { fb.lastDigest = today; if (COMMIT) writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1)); }
  };
  if (!batch.length) { await runDigest(); console.log('nothing else to post.'); return; }

  let pageToken = null;
  if (COMMIT) {
    const pt = await graph(`/${pageId}`, { fields: 'access_token', access_token: sysToken });
    if (!pt.ok || !pt.data.access_token) {
      console.error(`❌ could not derive a page token — ${pt.ok ? 'no access_token field' : pt.error}`);
      process.exitCode = 1;
      return;
    }
    pageToken = pt.data.access_token;
  }

  // Things a human has to act on, as opposed to things the next run fixes by itself. A rail that
  // refuses needs nobody: the recall is unrecorded and comes back round. A post that is already
  // live and wrong cannot be repaired in place — Facebook snapshots the card — so it goes here.
  let published = 0, failed = 0;
  const problems = [];
  for (const [i, rec] of batch.entries()) {
    const { message, link } = compose(rec);
    console.log(`── ${rec.date}  ${rec.slug}`);
    console.log(message.split('\n').map((l) => `   │ ${l}`).join('\n'));
    // The link is NOT in the message (Facebook renders it as the card and strips it from the
    // text), so a dry run has to show it separately or it looks like we forgot the link.
    console.log(`   │ [card] ${link}`);
    console.log(`   │ (message ${message.length} chars — over ~120 risks the "See more" fold)`);

    if (!COMMIT) { console.log('   └ (dry)\n'); continue; }              // RAIL 4

    // ⛔⛔ RAIL 7 — NEVER POST A URL THAT IS NOT LIVE YET. Jason caught this on the page: a real
    // post read "Recalled in the UK: ASDA Hapello Power Train" above a card saying
    // "Page not found — StopHurting".
    // The cause is a RACE I created by wiring this as the task's second action: build.mjs commits
    // and pushes, this runs seconds later, and Cloudflare Pages has not finished deploying. The
    // page existed in git and 404'd on the web. Facebook scrapes the instant the post is created,
    // so it cached the 404 — and rail 5 passed it, because a card DID render. It rendered our
    // 404 page.
    // Deploys land in about a minute, so wait for it rather than skipping: a recall held back
    // here would just post on the next run four hours later.
    if (!await urlIsLive(link)) {
      console.log('   └ ⏭ page is not live yet (deploy still landing) — leaving it for the next run\n');
      failed++;
      continue;                       // NOT recorded as posted, so it is a candidate again
    }

    // ⛔⛔ RAIL 8 — and Facebook has to see it too. Rail 7 above is kept because it is free and it
    // fails fast on the common case; it is no longer trusted to be sufficient. Same disposal as
    // rail 7: unrecorded, so the recall is a candidate again rather than lost.
    if (!await fbPreviewIsGood(link, pageToken)) {
      console.log('   └ ⏭ facebook cannot see the page yet — leaving it for the next run\n');
      failed++;
      continue;
    }

    const r = await graph(`/${pageId}/feed`, { message, link, access_token: pageToken }, 'POST');
    if (!r.ok) {
      // A failure must not poison the rest of the batch, and must NOT be recorded as posted —
      // an unrecorded failure retries next run, a wrongly-recorded one is lost forever.
      console.log(`   └ ❌ ${r.error}\n`);
      failed++;
      continue;
    }
    // ── RAIL 5: the post must actually CARRY the link ───────────────────────
    // The URL is not in the message — Facebook strips it and renders the card instead. So if a
    // scrape ever fails, we would publish a recall notice with no way to reach the recall: the
    // one outcome worse than not posting. Verify the card exists; if it does not, add the URL as
    // a comment, which cannot fail to scrape because it is plain text.
    // ⚠ ASK WHAT RENDERED, NOT MERELY WHETHER SOMETHING DID. This checked only that an attachment
    // existed, so it recorded `card: rendered` for a post whose card read "Page not found —
    // StopHurting". A card that renders the wrong page is not a card.
    // ⛔ A WRONG CARD IS A MISSING LINK. This used to detect the 404 card, record it, print a red
    // line — and then return a run that exited 0, so Task Scheduler said success and the only
    // person who found out was Jason, scrolling his own page. The reader's problem is identical in
    // both cases: a recall notice with no way to reach the recall. So both now take the SAME
    // remedy (comment the URL, which is plain text and cannot fail to scrape) and both make the
    // run fail loudly.
    let card = 'rendered';
    const att = await graph(`/${r.data.id}`, { fields: 'attachments{url,media_type,title}', access_token: pageToken });
    const got = att.ok ? att.data.attachments?.data?.[0] : null;
    const wrongCard = !!got && NOT_FOUND_TITLE.test(got.title || '');
    // ⚠ "WE COULD NOT READ IT BACK" IS NOT "FACEBOOK RENDERED NOTHING." These were one condition,
    // so a failed read-back — and graph() returns !ok for any Meta error object, on a call this
    // file's own comment says answers 200-with-an-error often enough that status alone lies —
    // was reported as a missing card, commented a URL onto a post that may already carry a
    // perfectly good one, and mailed him about it. Unknown is its own answer.
    const unreadable = !att.ok;
    const noCard = att.ok && !(att.data.attachments?.data?.length);
    if (wrongCard) console.log('   │ 🔴 the card scraped our 404 page — the URL was not live when Facebook fetched it');
    if (noCard || wrongCard) {
      const c = await graph(`/${r.data.id}/comments`, { message: link, access_token: pageToken }, 'POST');
      if (wrongCard) card = c.ok ? 'SCRAPED-404+comment' : 'SCRAPED-404';
      else card = c.ok ? 'self-healed-comment' : 'MISSING-LINK';
      console.log(c.ok
        ? `   │ ⚠ ${wrongCard ? 'wrong' : 'no'} link card — posted the URL as a comment (${c.data.id})`
        : `   │ 🔴 ${wrongCard ? 'wrong' : 'no'} link card AND the comment failed (${c.error}) — THIS POST HAS NO LINK`);
      // ⭐ The post is live and cannot be repaired in place, so this needs a human. Saying so in a
      // log nobody reads is what let it stand for seven hours.
      problems.push(wrongCard
        ? `${rec.slug}: facebook rendered our 404 page — post ${r.data.id} must be DELETED and re-posted (the preview is snapshotted at creation and never re-renders)`
        : `${rec.slug}: facebook rendered no link card — post ${r.data.id} has the URL in a comment; check whether the card is worth re-posting for`);
      process.exitCode = 1;
    }
    // Unknown is reported, never guessed at. We do not comment (the post may already carry a good
    // card, and a duplicate URL under a correct post is its own small mess) and we do not claim
    // the card rendered either — `fb-verify-post.mjs` reads the post back on demand.
    if (unreadable) {
      card = 'UNVERIFIED';
      console.log(`   │ ⚠ could not read the post back (${att.error}) — the card is UNKNOWN, not confirmed`);
      problems.push(`${rec.slug}: post ${r.data.id} published but its card could not be read back (${att.error}) — run fb-verify-post.mjs`);
      process.exitCode = 1;
    }

    posted[rec.id] = { at: new Date().toISOString(), postId: r.data.id, slug: rec.slug, card };
    fb.posted = posted;
    writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1));           // persist per post, not per batch
    console.log(`   └ ✅ posted ${r.data.id}${card === 'rendered' ? '' : ` (${card})`}\n`);
    published++;

    if (i < batch.length - 1 && PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  // ⛔⛔ COMMIT THE STATE FILE. fb-state.json is the ONLY record of what has been posted, and its
  // own header says deleting it re-arms the 134-post flood. Until now nothing committed it:
  // build.mjs does `git add -A`, but only on a run that found NEW recalls, so after a quiet week
  // the record of everything posted was sitting untracked on one machine. A re-clone, a disk
  // failure or a `git checkout .` and the whole archive becomes postable again.
  // ⚠ Deliberately not pushed here — build.mjs owns the push, and two processes racing a push in
  // the same repo is how you get a rejected non-fast-forward at 3am. The next build carries it.
  if (COMMIT && published) {
    try {
      execFileSync('git', ['add', '--', FB_STATE_FILE], { cwd: path.resolve(HERE, '..', '..') });
      execFileSync('git', ['commit', '-m', `fb: record ${published} posted recall(s)`,
        '-m', 'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'],
      { cwd: path.resolve(HERE, '..', '..') });
      console.log('fb-state.json committed.');
    } catch (e) {
      // A failed commit must not look like a failed post. The posts are already live.
      console.log(`⚠ could not commit fb-state.json (${String(e.message).split('\n')[0]}) — it is still written to disk; commit it by hand.`);
    }
  }

  // The overflow goes out after the individual posts, so the day ends with what was featured plus
  // one line covering everything else.
  await runDigest();

  if (COMMIT) console.log(`published ${published}${failed ? ` · ${failed} failed (will retry next run)` : ''}`);
  else console.log(`${batch.length} would be published. Re-run with --commit to publish.`);

  // ⛔⛔ AND TELL SOMEBODY. This is the half that was missing: the 404 card WAS detected, printed
  // and recorded on 2026-08-17, the run exited 0, and the first human to know was Jason looking at
  // the page seven hours later. A correct signal into a log nobody reads is not a signal.
  // ⭐ IT REPORTS TO THE BOARD, not to an inbox — an email can only be sent by a run that happens,
  // and the failure worth catching includes "this poster stopped running at all".
  if (problems.length) {
    console.error(`\n🔴 ${problems.length} POST(S) NEED A HUMAN:`);
    for (const p of problems) console.error(`   · ${p}`);
  }
  HB.ok = problems.length === 0;
  HB.detail = problems.length
    ? problems[0]                                    // the first one names the post that needs deleting
    : `${published} posted this run · ${Object.keys(posted).length} total, all cards verified`;
}

// ⛔⛔ THE HEARTBEAT LIVES OUT HERE, NOT INSIDE main(), AND THAT IS THE WHOLE POINT.
// main() returns early on a quiet run — no candidates, nothing to post — which is MOST runs. A
// heartbeat inside it would therefore fire only on the rare days something was published, the row
// would go stale on every ordinary day, and the board would cry wolf until he stopped reading it.
// Silence is what this board alarms on, so the liveness signal has to survive every exit path.
// ⛔ ITS OWN ROW, separate from the feed build: they are two ACTIONS of one Windows task and Task
// Scheduler keeps only the LAST action's exit code, so a dead feed is masked by a clean poster
// run. One integer cannot represent two jobs; two rows can.
const HB = { ok: true, detail: 'ran, nothing due to post' };
try {
  await main();
} catch (e) {
  // A crash must reach the board as a failure rather than as silence.
  HB.ok = false;
  HB.detail = `CRASHED — ${String(e && e.message || e)}`;
  process.exitCode = 1;
  console.error(e);
}
const { beat } = await import('./heartbeat.mjs');
await beat('stophurting-fb', {
  name: 'stophurting · recalls to Facebook',
  ok: HB.ok,
  detail: HB.detail,
  expectHours: 5,           // the task fires every 4h: one miss warns, two err
  commit: COMMIT,
});
