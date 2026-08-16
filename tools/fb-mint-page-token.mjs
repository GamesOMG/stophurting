#!/usr/bin/env node
// stophurting.org — mint a NEVER-EXPIRING Facebook PAGE token for the Stop Hurting page.
//
// WHY THIS EXISTS AS A SCRIPT: the 2026-08-14 session did this by hand across a 2h Meta maze
// and lost the steps when the session ended. The clicking part is unavoidably his; everything
// after "copy the token out of Graph Explorer" is deterministic and belongs here.
//
// ⛔ HOLDS NO SECRETS. Reads them from a file OUTSIDE every git working tree:
//      C:\Users\ImNot\.secrets\fb-provision-tmp.txt
//        line 1 = app id
//        line 2 = app secret
//        line 3 = the SHORT-LIVED USER token pasted from Graph Explorer
//   (that file used to sit in _monitoring/ and a `git add -A` swept it into a commit on
//    2026-08-16 — caught before any push. It does not go back into a repo.)
//
// THE THREE STEPS, and why each one is here:
//   1. fb_exchange_token  — short-lived user token (~1-2h) -> long-lived user token (~60d).
//   2. GET /<pageId>?fields=access_token with the LONG-LIVED user token -> the PAGE token.
//      🪤 A page token derived from a long-lived user token never expires. Derived from the
//         SHORT-lived one it inherits the ~1-2h life and the poster dies overnight — which is
//         the entire reason step 1 is not optional.
//      🪤 /me/accounts is EMPTY for New-Page-Experience pages (same trap hit on the GamesOMG
//         provisioning in July). Asking for the page by EXPLICIT ID is the whole workaround —
//         do not "fix" this by switching to /me/accounts.
//   3. debug_token — the PROOF. expires_at must be 0 (never expires) and the scopes must
//      include pages_manage_posts. An exit code is not evidence; this prints what it read.
//
// Usage:  node tools/fb-mint-page-token.mjs          # mint + verify + write
//         node tools/fb-mint-page-token.mjs --dry    # mint + verify, write nothing
//
// On success writes C:\Users\ImNot\.secrets\stophurting-fb-token.txt as:
//      <pageId>\n<pageToken>\n
// and tells you to shred line 3 of the tmp file.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SECRETS = 'C:\\Users\\ImNot\\.secrets\\fb-provision-tmp.txt';
const OUT     = 'C:\\Users\\ImNot\\.secrets\\stophurting-fb-token.txt';
const PAGE_ID = '61557134872247';           // the "Stop Hurting" FB page
const GRAPH   = 'https://graph.facebook.com/v21.0';
const DRY     = process.argv.includes('--dry');

// Never print a secret. Enough to identify it, not enough to use it.
const mask = (s) => (!s ? '(empty)' : `${s.slice(0, 6)}…${s.slice(-4)} (len ${s.length})`);

// 🪤 process.exit() trips a libuv assertion on Windows while fetch's handles are still closing,
// which returns a junk exit code (127) over a perfectly clear error message. So `die` throws a
// Bail, main() catches it, and the status matches what was actually printed.
class Bail extends Error {}
function die(msg) {
  throw new Bail(msg);
}

async function graph(path, params) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  // Meta answers 200 with an `error` object often enough that status alone lies.
  if (j.error) {
    const e = j.error;
    return { ok: false, error: `${e.type || 'error'} ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.message}` };
  }
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  return { ok: true, data: j };
}

async function main() {
  if (!existsSync(SECRETS)) die(`secrets file not found: ${SECRETS}`);
  const lines = readFileSync(SECRETS, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const [appId, appSecret, userToken] = lines;
  if (!appId || !appSecret || !userToken) {
    die(`${SECRETS} needs 3 lines: app id, app secret, short-lived user token.\n` +
        `  line 1: ${mask(appId)}\n  line 2: ${mask(appSecret)}\n  line 3: ${mask(userToken)}`);
  }
  console.log(`app id    : ${appId}`);
  console.log(`app secret: ${mask(appSecret)}`);
  console.log(`user token: ${mask(userToken)}`);
  console.log(`page id   : ${PAGE_ID}\n`);

  // ── 1. short-lived user token -> long-lived user token ─────────────────────
  console.log('1/3  exchanging for a long-lived user token…');
  const ll = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken,
  });
  if (!ll.ok) {
    die(`long-lived exchange failed — ${ll.error}\n\n` +
        `Line 3 is not a usable token. Graph Explorer tokens last ~1-2h, and subcode 466\n` +
        `specifically means the session was explicitly revoked (removing the app from Business\n` +
        `Integrations does that). Either way: generate a fresh one and replace line 3.`);
  }
  const longUser = ll.data.access_token;
  console.log(`     ✅ long-lived user token: ${mask(longUser)}`);
  console.log(`        expires_in: ${ll.data.expires_in ?? '(absent)'} s\n`);

  // ── 2. long-lived user token -> PAGE token (explicit id; /me/accounts is empty for NPE) ──
  console.log('2/3  asking for the page token by explicit id…');
  const pg = await graph(`/${PAGE_ID}`, { fields: 'access_token,name', access_token: longUser });
  if (!pg.ok) {
    die(`page token fetch failed — ${pg.error}\n\n` +
        `THIS IS THE KNOWN BLOCKER: it means the grant carried NO PAGE. The "just confirm"\n` +
        `fast-path consent attaches zero pages, and the Business-Integrations edit dialog has no\n` +
        `page section for New Page Experience pages.\n\n` +
        `Fix (his clicks, ~2 min):\n` +
        `  1. facebook.com/settings/?tab=business_tools -> REMOVE the StopHurting integration\n` +
        `  2. developers.facebook.com/tools/explorer/${appId}/ -> Generate Access Token\n` +
        `  3. the FRESH consent now shows a Pages step -> CHECK "Stop Hurting" -> continue\n` +
        `  4. copy the token into line 3 of the secrets file and re-run this script`);
  }
  const pageToken = pg.data.access_token;
  console.log(`     ✅ page: ${pg.data.name}`);
  console.log(`        page token: ${mask(pageToken)}\n`);

  // ── 3. PROVE it never expires and can actually post ────────────────────────
  console.log('3/3  verifying with debug_token…');
  const dbg = await graph('/debug_token', { input_token: pageToken, access_token: `${appId}|${appSecret}` });
  if (!dbg.ok) die(`debug_token failed — ${dbg.error}`);
  const d = dbg.data.data || {};
  const scopes = d.scopes || [];
  const neverExpires = d.expires_at === 0;
  console.log(`     type       : ${d.type}`);
  console.log(`     valid      : ${d.is_valid}`);
  console.log(`     expires_at : ${d.expires_at} ${neverExpires ? '✅ never expires' : '⚠ EXPIRES — see below'}`);
  console.log(`     scopes     : ${scopes.join(', ') || '(none)'}`);

  if (!d.is_valid) die('token reports is_valid=false — do not store it.');
  if (!neverExpires) {
    die(`expires_at is ${d.expires_at}, not 0.\n\n` +
        `The page token inherited a lifetime, which means step 1 did not really produce a\n` +
        `long-lived user token. Do NOT store this — a poster built on it dies in about an hour.`);
  }
  if (!scopes.includes('pages_manage_posts')) {
    die(`scopes do not include pages_manage_posts, so this token cannot post.\n` +
        `Got: ${scopes.join(', ') || '(none)'}`);
  }

  if (DRY) {
    console.log(`\n✅ all three checks pass. --dry, so nothing written.`);
    return;
  }
  writeFileSync(OUT, `${PAGE_ID}\n${pageToken}\n`, 'utf8');
  console.log(`\n✅ WROTE ${OUT}  (line 1 = page id, line 2 = page token)`);
  console.log(`▶ Now shred line 3 of ${SECRETS} — the user token has done its job.`);
  console.log(`▶ The app secret on line 2 was rendered unmasked in the 08-14 transcript;`);
  console.log(`  resetting it in the app dashboard is worth doing, no urgency, and it does`);
  console.log(`  NOT invalidate the page token you just minted.`);
}

try {
  await main();
} catch (e) {
  if (e instanceof Bail) {
    console.error(`\n❌ ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
