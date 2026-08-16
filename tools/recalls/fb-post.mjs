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
const GRAPH = 'https://graph.facebook.com/v21.0';

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const COMMIT = process.argv.includes('--commit');
const LIMIT = Number(argOf('--limit', 3));
const MAX_AGE_DAYS = Number(argOf('--max-age', 30));
const PAUSE_MS = Number(argOf('--pause', 45000));

const mask = (s) => (!s ? '(empty)' : `${s.slice(0, 6)}…${s.slice(-4)} (len ${s.length})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the post text ----------
// Assembled from the stored card fields (which build.mjs derived from the CPSC record). Kept
// deliberately flat and factual: this is a safety notice, not marketing. No emoji, no urgency
// language, no "SHARE THIS!" — the people who share these are the audience, and they can tell.
function compose(rec) {
  const url = `${ORIGIN}/recalls/${rec.slug}/`;
  // build.mjs's hazardShort() always ends the phrase with the word "hazard", so under a
  // "Hazard:" label it reads "Hazard: Fire and Burn hazard". Drop the duplicate — this removes
  // a repeated word, it does not reword CPSC's phrasing.
  const hazard = String(rec.hazard || '').trim().replace(/\s+hazards?$/i, '');
  const lines = [`Recalled: ${rec.prod}`];
  if (hazard) lines.push(`Hazard: ${hazard.charAt(0).toUpperCase() + hazard.slice(1)}`);
  lines.push('', 'What was sold, what to do, and the official CPSC notice:', url);
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

    if (!COMMIT) { console.log('   └ (dry)\n'); continue; }              // RAIL 4

    const r = await graph(`/${pageId}/feed`, { message, link, access_token: pageToken }, 'POST');
    if (!r.ok) {
      // A failure must not poison the rest of the batch, and must NOT be recorded as posted —
      // an unrecorded failure retries next run, a wrongly-recorded one is lost forever.
      console.log(`   └ ❌ ${r.error}\n`);
      failed++;
      continue;
    }
    posted[rec.id] = { at: new Date().toISOString(), postId: r.data.id, slug: rec.slug };
    fb.posted = posted;
    writeFileSync(FB_STATE_FILE, JSON.stringify(fb, null, 1));           // persist per post, not per batch
    console.log(`   └ ✅ posted ${r.data.id}\n`);
    published++;

    if (i < batch.length - 1 && PAUSE_MS > 0) await sleep(PAUSE_MS);
  }

  if (COMMIT) console.log(`published ${published}${failed ? ` · ${failed} failed (will retry next run)` : ''}`);
  else console.log(`${batch.length} would be published. Re-run with --commit to publish.`);
}

await main();
