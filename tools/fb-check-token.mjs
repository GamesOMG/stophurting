#!/usr/bin/env node
// stophurting.org — verify the Facebook posting credential end to end.
//
// REPLACES fb-mint-page-token.mjs (2026-08-16). That script implemented the USER-token flow:
// short-lived -> long-lived -> page token. Jason killed that route for the right reason — a page
// token derived from a personal grant dies when the account's password changes or the app is
// revoked, which is exactly what killed the 2026-08-14 token. We now use a SYSTEM USER instead:
// business-portfolio owned, unaffected by his personal account, expiry set to Never.
//
// ⚠ TWO CORRECTIONS THAT COST THE 08-14 SESSION, recorded so nobody re-derives them:
//   1. THE PAGE ID WAS WRONG. Notes carried 61557134872247 — that is the page's URL/vanity id.
//      The Graph NODE id is 222728804264171. `GET /61557134872247?fields=access_token` returns
//      "does not exist / missing permissions", which reads exactly like a permissions failure
//      and sent the whole session chasing the grant instead of the identifier.
//   2. "No configurations available" was written off as a red herring. It was THE blocker. This
//      app uses Facebook Login for Business, which grants only what a saved configuration
//      declares — with none, Graph Explorer's permission picker is empty and any token minted
//      carries no page. (Moot now: the system-user route does not use that configuration at all.)
//
// ⛔ HOLDS NO SECRETS. Reads them from outside every git working tree:
//     C:\Users\ImNot\.secrets\fb-provision-tmp.txt      line 1 app id, line 2 app secret
//     C:\Users\ImNot\.secrets\stophurting-fb-token.txt  line 1 page id, line 2 SYSTEM-USER token
//
// 🪤 The stored credential is the SYSTEM-USER token, not a page token. Page posting still needs a
//    PAGE token, so the poster derives one per run via GET /<page-id>?fields=access_token. That is
//    one extra call and it means a rotated page token can never strand us — the durable secret is
//    the one that never expires.
//
// Usage: node tools/fb-check-token.mjs

import { readFileSync, existsSync } from 'node:fs';

const SECRETS = 'C:\\Users\\ImNot\\.secrets\\fb-provision-tmp.txt';
const TOKEN_FILE = 'C:\\Users\\ImNot\\.secrets\\stophurting-fb-token.txt';
const GRAPH = 'https://graph.facebook.com/v21.0';

const mask = (s) => (!s ? '(empty)' : `${s.slice(0, 6)}…${s.slice(-4)} (len ${s.length})`);

class Bail extends Error {}
const die = (msg) => { throw new Bail(msg); };

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
  for (const f of [SECRETS, TOKEN_FILE]) if (!existsSync(f)) die(`missing ${f}`);
  const [appId, appSecret] = readFileSync(SECRETS, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const [pageId, sysToken] = readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim());
  if (!appId || !appSecret) die(`${SECRETS} needs app id on line 1 and app secret on line 2`);
  if (!pageId || !sysToken) die(`${TOKEN_FILE} needs page id on line 1 and the token on line 2`);

  console.log(`app id      : ${appId}`);
  console.log(`page id     : ${pageId}`);
  console.log(`system token: ${mask(sysToken)}\n`);

  // ── 1. Does the token itself hold up, and does it truly never expire? ───────
  console.log('1/3  debug_token…');
  const dbg = await graph('/debug_token', { input_token: sysToken, access_token: `${appId}|${appSecret}` });
  if (!dbg.ok) die(`debug_token failed — ${dbg.error}`);
  const d = dbg.data.data || {};
  const scopes = d.scopes || [];
  console.log(`     app_id     : ${d.app_id}`);
  console.log(`     type       : ${d.type}`);
  console.log(`     valid      : ${d.is_valid}`);
  console.log(`     expires_at : ${d.expires_at} ${d.expires_at === 0 ? '✅ never expires' : '⚠ EXPIRES'}`);
  console.log(`     scopes     : ${scopes.join(', ') || '(none)'}`);
  if (!d.is_valid) die('is_valid=false — the stored token is not usable.');
  if (d.expires_at !== 0) die(`expires_at is ${d.expires_at}, not 0 — this token has a lifetime and the poster will die when it ends.`);
  if (!scopes.includes('pages_manage_posts')) die(`scopes lack pages_manage_posts — got: ${scopes.join(', ') || '(none)'}`);
  if (String(d.app_id) !== String(appId)) die(`token belongs to app ${d.app_id}, not ${appId}`);

  // ── 2. Can it actually SEE the page? This is where the wrong id showed up. ──
  console.log('\n2/3  resolving the page by node id…');
  const pg = await graph(`/${pageId}`, { fields: 'id,name', access_token: sysToken });
  if (!pg.ok) {
    die(`cannot read page ${pageId} — ${pg.error}\n\n` +
        `If this says "does not exist", check the ID is the GRAPH NODE id (222728804264171) and\n` +
        `not the URL id (61557134872247). That mix-up is what derailed 2026-08-14.`);
  }
  console.log(`     ✅ ${pg.data.name} (${pg.data.id})`);

  // ── 3. Derive the PAGE token the poster will actually use. ─────────────────
  console.log('\n3/3  deriving the page token…');
  const pt = await graph(`/${pageId}`, { fields: 'access_token', access_token: sysToken });
  if (!pt.ok || !pt.data.access_token) die(`could not derive a page token — ${pt.ok ? 'no access_token field returned' : pt.error}`);
  console.log(`     ✅ page token: ${mask(pt.data.access_token)}`);

  const pdbg = await graph('/debug_token', { input_token: pt.data.access_token, access_token: `${appId}|${appSecret}` });
  if (pdbg.ok) {
    const p = pdbg.data.data || {};
    console.log(`     type       : ${p.type}`);
    console.log(`     expires_at : ${p.expires_at} ${p.expires_at === 0 ? '✅ never expires' : '⚠ EXPIRES'}`);
    console.log(`     scopes     : ${(p.scopes || []).join(', ') || '(none)'}`);
  }

  console.log(`\n✅ CREDENTIAL GOOD. The poster can authenticate as ${pg.data.name}.`);
  console.log(`⚠ Not proven here: an actual publish. Nothing short of posting proves posting,`);
  console.log(`  and that is a visible action on a live page — so it stays Jason's call.`);
}

try {
  await main();
} catch (e) {
  if (e instanceof Bail) { console.error(`\n❌ ${e.message}`); process.exitCode = 1; }
  else throw e;
}
