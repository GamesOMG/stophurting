#!/usr/bin/env node
// Prove a recorded post actually EXISTS on the page, and print its permalink.
//
// WHY: fb-post.mjs records a post id because Graph returned one. That is the API agreeing it
// accepted the call — it is not the same as a human being able to see the post. This fetches
// each recorded post back and prints what the page actually holds. An exit code is not evidence.
//
// Reads C:\Users\ImNot\.secrets\stophurting-fb-token.txt (page id + SYSTEM-USER token) and
// derives a page token per run. Prints no secrets.
//
// Usage:
//   node tools/recalls/fb-verify-post.mjs           # verify every recorded post
//   node tools/recalls/fb-verify-post.mjs --last    # only the most recent one

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FB_STATE_FILE = process.env.SH_FB_STATE_FILE || path.join(HERE, 'fb-state.json');
const TOKEN_FILE = process.env.SH_FB_TOKEN_FILE || 'C:\\Users\\ImNot\\.secrets\\stophurting-fb-token.txt';
const GRAPH = 'https://graph.facebook.com/v21.0';
const LAST_ONLY = process.argv.includes('--last');

async function graph(pathname, params) {
  const url = new URL(GRAPH + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (j.error) return { ok: false, error: `${j.error.type || 'error'} ${j.error.code}: ${j.error.message}` };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, data: j };
}

for (const f of [FB_STATE_FILE, TOKEN_FILE]) {
  if (!existsSync(f)) { console.error(`❌ missing ${f}`); process.exit(1); }
}
const [pageId, sysToken] = readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim());
const fb = JSON.parse(readFileSync(FB_STATE_FILE, 'utf8'));
let entries = Object.entries(fb.posted || {});
if (!entries.length) { console.log('nothing recorded as posted.'); process.exit(0); }
entries.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
if (LAST_ONLY) entries = entries.slice(-1);

const pt = await graph(`/${pageId}`, { fields: 'access_token', access_token: sysToken });
if (!pt.ok || !pt.data.access_token) {
  console.error(`❌ could not derive a page token — ${pt.ok ? 'no access_token field' : pt.error}`);
  process.exit(1);
}
const pageToken = pt.data.access_token;

let good = 0, bad = 0;
for (const [recallId, rec] of entries) {
  const r = await graph(`/${rec.postId}`, {
    fields: 'id,created_time,message,permalink_url,is_published,attachments{title,url,media_type}',
    access_token: pageToken,
  });
  if (!r.ok) {
    console.log(`❌ recall ${recallId} — post ${rec.postId} NOT retrievable: ${r.error}`);
    bad++;
    continue;
  }
  const d = r.data;
  const att = d.attachments?.data?.[0];
  console.log(`✅ recall ${recallId} — ${rec.slug}`);
  console.log(`   post id    : ${d.id}`);
  console.log(`   created    : ${d.created_time}`);
  console.log(`   published  : ${d.is_published}`);
  console.log(`   permalink  : ${d.permalink_url}`);
  if (att) console.log(`   card       : ${att.media_type}${att.title ? ` — ${att.title}` : ''}`);
  console.log(`   message    :\n${String(d.message || '(none)').split('\n').map((l) => `     │ ${l}`).join('\n')}`);
  good++;
}
console.log(`\n${good} verified live${bad ? ` · ${bad} MISSING` : ''}`);
process.exitCode = bad ? 1 : 0;
