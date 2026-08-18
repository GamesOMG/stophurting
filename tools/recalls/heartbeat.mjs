// Report this pipeline's health to the AcidNodes watchtower, which is the board Jason actually
// opens (/bridge, "Automations - is it humming?").
//
// ⭐ WHY THIS AND NOT EMAIL. alert.mjs was built first and it was the wrong shape, for a reason
// that is worth keeping: AN EMAIL CAN ONLY BE SENT BY A RUN THAT HAPPENS. Disable the scheduled
// task, sleep the machine, or die before node loads, and there is no mail and no signal at all —
// which is the exact failure that hid four jobs for twelve days. The board alarms on ABSENCE: a
// job that stops reporting goes stale on its own. That is strictly stronger, and it needs no new
// credential, because the dash token is already on this box.
// 📖 Jason's own words for why a page beats a chat message: "when I open my browser, its in my
// face, what shipped, what is green, what is red."
//
// ⛔ TWO JOBS, NOT ONE, and that is load-bearing. build.mjs and fb-post.mjs are two ACTIONS of one
// Windows task, and Task Scheduler records only the LAST action's exit code — so a dead recall feed
// (build exits 1) is masked by a clean poster run. One integer cannot represent both. Two rows can.
//
// The token is read at run time and never printed. Same rule as the Facebook credential.

import { readFileSync, existsSync } from 'node:fs';

const WORKER = process.env.SH_WATCHTOWER || 'https://vln-watchtower.jason-c61.workers.dev';
const TOKEN_FILE = process.env.SH_DASH_TOKEN_FILE || 'C:\\GitHub\\_monitoring\\dash-token.txt';

function token() {
  if (process.env.SH_DASH_TOKEN) return process.env.SH_DASH_TOKEN.trim();
  if (!existsSync(TOKEN_FILE)) return null;
  const t = readFileSync(TOKEN_FILE, 'utf8').trim();
  return t || null;
}

/**
 * @param {string} job   stable id, <=40 chars — this is the PRIMARY KEY on the board
 * @param {string} name  human label, <=60
 * @param {boolean} ok   false puts the row straight into err, regardless of freshness
 * @param {string} detail  <=120, and it is the only thing he reads before deciding to care
 * @param {number} expectHours  ok inside this, warn to 2x, err past that
 */
export async function beat(job, { name, ok = true, detail = '', expectHours = 5, commit = false } = {}) {
  const line = `${ok ? 'ok' : 'FAIL'} · ${detail}`.slice(0, 120);
  if (!commit) { console.log(`   ♥ would report ${job}: ${line}`); return { delivered: false, dry: true }; }
  const k = token();
  if (!k) {
    // Loud, and still not fatal. An unreported run is worse than a noisy one, but a reporting
    // failure must never be the thing that breaks the pipeline it describes.
    console.log(`   ♥ NOT REPORTED — no dash token at ${TOKEN_FILE}. ${job} is INVISIBLE on the board.`);
    return { delivered: false, reason: 'no-token' };
  }
  try {
    // ⛔ READ THE STATUS. The whole class of failure this repo keeps paying for is a curl whose
    // exit code was discarded: four jobs logged "ok=1" while being 403'd for twelve days. A
    // heartbeat that ignores the response reports that it RAN, not that it ARRIVED.
    const res = await fetch(`${WORKER}/heartbeat?k=${encodeURIComponent(k)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job, name: name || job, detail: line, ok: ok ? 1 : 0, expect_hours: expectHours }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 200) {
      console.log(`   ♥ heartbeat NOT DELIVERED for ${job}: HTTP ${res.status} — the board will go stale, which is the correct outcome`);
      return { delivered: false, status: res.status };
    }
    console.log(`   ♥ reported ${job}: ${line}`);
    return { delivered: true };
  } catch (e) {
    console.log(`   ♥ heartbeat failed for ${job} (${String(e.message).split('\n')[0]}) — run.log still has the detail`);
    return { delivered: false, reason: 'threw' };
  }
}
