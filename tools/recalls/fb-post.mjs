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
//
// Credential: C:\Users\ImNot\.secrets\stophurting-fb-token.txt
//   line 1 = page NODE id (222728804264171 — NOT the URL id 61557134872247, see fb-check-token.mjs)
//   line 2 = SYSTEM-USER token (never expires; business-portfolio owned, so a password change
//            or app revocation cannot kill it — that is why it is not a user token)
// A PAGE token is derived per run from the system-user token, so a rotated page token can
// never strand this.
//
// ── FOUR RAILS, each guarding a specific way this could embarrass us ──────────────────────
// 1. BACKFILL WATERMARK. state.seen holds every recall ever generated (134 at build time), none
//    of them posted. Without a watermark the first run is a 134-post flood on a page that has
//    never posted anything. So the FIRST run posts NOTHING: it records every currently-known
//    recall as backfill and exits. Only recalls first seen AFTER that are ever candidates.
// 2. AGE CUTOFF. Independent of the watermark, nothing older than --max-age days is posted.
//    `build.mjs --rebuild` and `--since` both re-walk old recalls; if either ever perturbs the
//    watermark, this stops history from being replayed onto the page.
// 3. PER-RUN CAP. CPSC drops in batches. The cron runs every 4h; a cap of 3 per run spaces a
//    batch out over days instead of dumping it in one burst, with a pause between each.
// 4. DRY BY DEFAULT. Nothing publishes without --commit, and every skip prints its reason.
//
// State: tools/recalls/fb-state.json — deliberately SEPARATE from state.json, which build.mjs
// rewrites wholesale on every run; sharing one file invites a lost update between the two tools.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable ONLY so the rails can be driven against fixtures by check-fb-post.mjs. A guard
// that has never been seen refusing is indistinguishable from no guard — and this file's whole
// job is refusing. Production passes none of these; the defaults are the real paths.
const STATE_FILE = process.env.SH_STATE_FILE || path.join(HERE, 'state.json');
const FB_STATE_FILE = process.env.SH_FB_STATE_FILE || path.join(HERE, 'fb-state.json');
const TOKEN_FILE = process.env.SH_FB_TOKEN_FILE || 'C:\\Users\\ImNot\\.secrets\\stophurting-fb-token.txt';
const ORIGIN = 'https://stophurting.org';
// Overridable only so check-fb-post.mjs can point the publish path at a local fake Graph. The
// publish path cannot otherwise be tested without publishing, and an untested publish path is
// where the "we'll fix it when it breaks" bugs live.
const GRAPH = process.env.SH_FB_GRAPH_BASE || 'https://graph.facebook.com/v21.0';

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const COMMIT = process.argv.includes('--commit');

// ⭐ CPSC POSTS ONLY ON THURSDAYS. Measured 2026-08-16 across 57 days: 109 recalls, every single
// one on a Thursday, nine Thursdays in a row, 7–18 per drop. Nothing on any other weekday, ever.
// A fixed cap of 3/run with a 4-hourly task would clear an 18-recall Thursday inside 12 hours and
// then post nothing for six days — burst, then dead air, which is the worst shape for a
// feed-ranked platform.
// So the cap is COMPUTED: remaining candidates ÷ runs left before the next Thursday. An 18-recall
// batch becomes ~1 per run across the week, and a missed run shrinks the divisor so the next run
// catches up on its own. No schedule table, and nothing for Jason to do on Thursdays.
const RUN_INTERVAL_HOURS = 4;   // the stophurting-recalls task cadence
const MAX_PER_RUN = 3;          // hard ceiling, whatever the maths says
function runsUntilNextDrop(now = new Date()) {
  const day = now.getDay();                    // 0 Sun … 4 Thu
  let daysToThu = (4 - day + 7) % 7;
  if (daysToThu === 0) daysToThu = 7;          // it IS Thursday: the next drop is a week out
  const hoursLeft = daysToThu * 24 - now.getHours();
  return Math.max(1, Math.floor(hoursLeft / RUN_INTERVAL_HOURS));
}
// --runs-left exists so the pacing can be tested deterministically; production never passes it.
const RUNS_LEFT = Number(argOf('--runs-left', runsUntilNextDrop()));
const EXPLICIT_LIMIT = process.argv.includes('--limit') ? Number(argOf('--limit', 3)) : null;
const MAX_AGE_DAYS = Number(argOf('--max-age', 30));
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
  const url = `${ORIGIN}/recalls/${rec.slug}/`;
  // build.mjs's hazardShort() always ends the phrase with the word "hazard", so under a
  // "Hazard:" label it reads "Hazard: Fire and Burn hazard". Drop the duplicate — this removes
  // a repeated word, it does not reword CPSC's phrasing.
  const hazard = String(rec.hazard || '').trim().replace(/\s+hazards?$/i, '');
  const lines = [`Recalled: ${rec.prod}`];
  if (hazard) lines.push(`Hazard: ${hazard.charAt(0).toUpperCase() + hazard.slice(1)}`);
  return { message: lines.join('\n'), link: url };
}

// ---------- graph ----------
async function graph(pathname, params, method = 'GET') {
  const url = new URL(GRAPH + pathname);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (method === 'GET') url.searchParams.set(k, v);
    else body.set(k, v);
  }
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
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);

  // ── candidates, with every rejection reason printed rather than silently dropped ──
  const skipped = { backfill: 0, alreadyPosted: 0, tooOld: 0 };
  const candidates = [];
  for (const [id, rec] of Object.entries(state.seen)) {
    if (backfill.has(id)) { skipped.backfill++; continue; }
    if (posted[id]) { skipped.alreadyPosted++; continue; }
    if ((rec.date || '') < cutoff) { skipped.tooOld++; continue; }   // RAIL 2
    candidates.push({ id, ...rec });
  }
  candidates.sort((a, b) => (a.date || '').localeCompare(b.date || ''));  // oldest first, so nothing starves

  console.log(`page        : ${pageId}`);
  console.log(`token       : ${mask(sysToken)}`);
  console.log(`known       : ${Object.keys(state.seen).length} recalls`);
  console.log(`skipped     : ${skipped.backfill} backfill · ${skipped.alreadyPosted} already posted · ${skipped.tooOld} older than ${MAX_AGE_DAYS}d`);
  // Pace: spread what is left across the runs remaining before the next Thursday drop.
  const LIMIT = EXPLICIT_LIMIT !== null
    ? EXPLICIT_LIMIT
    : Math.max(1, Math.min(MAX_PER_RUN, Math.ceil(candidates.length / RUNS_LEFT)));
  console.log(`pacing      : ${RUNS_LEFT} run(s) left before the next Thursday drop -> ${LIMIT}/run${EXPLICIT_LIMIT !== null ? ' (--limit override)' : ''}`);
  console.log(`candidates  : ${candidates.length}${candidates.length > LIMIT ? ` (capping at ${LIMIT} this run)` : ''}`);
  console.log(`mode        : ${COMMIT ? '🔴 COMMIT — will publish' : 'DRY — nothing will be published'}\n`);

  const batch = candidates.slice(0, LIMIT);                              // RAIL 3
  if (!batch.length) { console.log('nothing to post.'); return; }

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

  let published = 0, failed = 0;
  for (const [i, rec] of batch.entries()) {
    const { message, link } = compose(rec);
    console.log(`── ${rec.date}  ${rec.slug}`);
    console.log(message.split('\n').map((l) => `   │ ${l}`).join('\n'));
    // The link is NOT in the message (Facebook renders it as the card and strips it from the
    // text), so a dry run has to show it separately or it looks like we forgot the link.
    console.log(`   │ [card] ${link}`);
    console.log(`   │ (message ${message.length} chars — over ~120 risks the "See more" fold)`);

    if (!COMMIT) { console.log('   └ (dry)\n'); continue; }              // RAIL 4

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
    let card = 'rendered';
    const att = await graph(`/${r.data.id}`, { fields: 'attachments{url,media_type}', access_token: pageToken });
    if (!att.ok || !(att.data.attachments?.data?.length)) {
      const c = await graph(`/${r.data.id}/comments`, { message: link, access_token: pageToken }, 'POST');
      card = c.ok ? 'self-healed-comment' : 'MISSING-LINK';
      console.log(c.ok
        ? `   │ ⚠ no link card — posted the URL as a comment (${c.data.id})`
        : `   │ 🔴 no link card AND the comment failed (${c.error}) — THIS POST HAS NO LINK`);
    }

    posted[rec.id] = { at: new Date().toISOString(), postId: r.data.id, slug: rec.slug, card };
    fb.posted = posted;
    writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1));           // persist per post, not per batch
    console.log(`   └ ✅ posted ${r.data.id}${card === 'rendered' ? '' : ` (${card})`}\n`);
    published++;

    if (i < batch.length - 1 && PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  if (COMMIT) console.log(`published ${published}${failed ? ` · ${failed} failed (will retry next run)` : ''}`);
  else console.log(`${batch.length} would be published. Re-run with --commit to publish.`);
}

await main();
