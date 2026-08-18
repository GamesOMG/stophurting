// ⛔⛔ DORMANT BY DESIGN SINCE 2026-08-17 — NOTHING CALLS THIS, AND THAT IS DELIBERATE.
// Superseded by heartbeat.mjs, which reports to the watchtower board instead of emailing.
// ⛔ DO NOT RE-WIRE IT because it looks orphaned. It looked orphaned once before and the correct
// reading was "never finished"; this time it is "finished, then replaced", for two reasons:
//   1. AN EMAIL CAN ONLY BE SENT BY A RUN THAT HAPPENS. Disable the task, sleep the machine, or
//      die before node loads and there is no mail AND no signal — the exact failure that hid four
//      jobs for twelve days. The board alarms on ABSENCE, which is strictly stronger.
//   2. Jason asked for a PAGE, in his words: "when I open my browser, its in my face, what
//      shipped, what is green, what is red." Email delivers somewhere he did not ask for.
// It also needed a Zoho app password that was never written, so it never sent a single message.
// ⭐ KEPT, not deleted: it is complete and has 26 assertions behind it (check-alert.mjs, in the
// gate), so it is one import away if a second channel is ever wanted — a real fallback rather than
// a rewrite. ⚠ If it is still uncalled in a month, delete it; two alerting paths is how one rots.
//
// ── original header ────────────────────────────────────────────────────────────────────────────
// Emails admin@stophurting.org when the unattended pipeline breaks.
//
// ⭐ WHY. The 4-hourly task runs with nobody watching. It now exits non-zero and writes run.log
// when a country's feed dies or goes quiet — but Jason's words: "email me at
// admin@stophurting.org if something breaks." A signal nobody is looking at is not a signal.
//
// ⛔ THE CREDENTIAL IS NEVER IN THE REPO AND NEVER IN CHAT. Same shape as the Facebook token: a
// file outside the tree that Jason writes himself, read at run time, never printed. If it is
// absent this module says so and does nothing — an unconfigured alerter must not break the build
// it is meant to report on.
//
//   C:\Users\ImNot\.secrets\stophurting-smtp.txt
//     line 1  smtp.zoho.com:465
//     line 2  the Zoho LOGIN address (the mailbox, not the alias)
//     line 3  a Zoho APP PASSWORD  (Zoho requires one when 2FA is on — a normal password is
//             rejected by SMTP, which is the failure people spend an evening on)
//     line 4  (optional) the From address; defaults to admin@stophurting.org
//
// ⚠ admin@stophurting.org is an ALIAS, not a mailbox. Zoho authenticates as the parent mailbox
// and sends AS the alias, so line 2 and line 4 are usually different addresses.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = process.env.SH_SMTP_FILE || 'C:\\Users\\ImNot\\.secrets\\stophurting-smtp.txt';
const ALERT_STATE = process.env.SH_ALERT_STATE || path.join(HERE, 'alert-state.json');
const TO = 'admin@stophurting.org';

// ⭐⭐ THE DE-DUPLICATION IS THE WHOLE DESIGN, not a refinement. The task runs six times a day; a
// stale Australian feed is still stale on the next run, and the one after that. Mailing every
// time turns a real alarm into six identical messages a day, which is how an inbox teaches you to
// ignore an alert — and then the alert is worth nothing on the day it matters.
// So: mail when a problem is NEW, mail again only if it is still there 24h later, and mail once
// when it CLEARS. Silence in between means "still broken, you already know".
const REMIND_AFTER_HOURS = 24;

// ⛔⛔ THE NETWORK CALL WAS GUARDED AND THE TWO FILESYSTEM BOUNDARIES AROUND IT WERE NOT — which
// is backwards, because this module's whole contract is "a failed alert must never fail the build
// it observes", and the build now `await`s it at top level where a throw is fatal.
// Read side: JSON.parse was guarded but the SHAPE was not, so a file holding `{}`, `null` or `[]`
// parsed happily and then threw a TypeError on `state.open[k]` — on a HEALTHY run too.
function loadState() {
  const empty = { open: {}, pending: {} };
  if (!existsSync(ALERT_STATE)) return empty;
  try {
    const s = JSON.parse(readFileSync(ALERT_STATE, 'utf8'));
    if (!s || typeof s !== 'object') return empty;
    return {
      open: s.open && typeof s.open === 'object' ? s.open : {},
      pending: s.pending && typeof s.pending === 'object' ? s.pending : {},
    };
  } catch { return empty; }
}

// Write side: this used to sit outside every try/catch, one statement past a mail that had already
// gone out. A locked or read-only file (AV, an open editor, an ACL) therefore mailed him and THEN
// threw — killing the build, and losing the memory that stops the identical mail going out again
// on all six runs the next day. It must never throw, and it must never leave a half-written file
// for the next run to read.
function persist(next) {
  try {
    writeFileSync(`${ALERT_STATE}.tmp`, JSON.stringify(next, null, 1));
    renameSync(`${ALERT_STATE}.tmp`, ALERT_STATE);
  } catch (e) {
    console.log(`   ✉ alert state not saved (${String(e.message).split('\n')[0]}) — the next run may repeat this mail`);
  }
}

function creds() {
  if (!existsSync(CRED_FILE)) return null;
  const [hostPort, user, pass, from] = readFileSync(CRED_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim());
  if (!hostPort || !user || !pass) return null;
  const [host, port] = hostPort.split(':');
  return { host, port: Number(port) || 465, user, pass, from: from || TO };
}

async function send(subject, body) {
  const c = creds();
  if (!c) {
    console.log(`   ✉ alert NOT sent — no credential at ${CRED_FILE}. See the header of alert.mjs.`);
    return false;
  }
  const { default: nodemailer } = await import('nodemailer');
  // ⚠ SH_SMTP_JSON is the TEST SEAM: nodemailer's built-in jsonTransport composes the message and
  // returns it instead of connecting to anything. It is what lets check-alert.mjs drive the REAL
  // send path — state persistence and all — with no network and no credential of Jason's. Without
  // it, the only code that has ever run this function is the code that mails him.
  // ⛔⛔ TIMEOUTS ARE NOT OPTIONAL HERE. try/catch catches an SMTP *error*; it does not catch an
  // SMTP *hang*, and nodemailer's defaults are generous. This runs inside an unattended 4-hourly
  // task, so a Zoho outage that accepts the TCP connection and then says nothing would stall the
  // recall pipeline behind the thing that was only ever meant to describe it.
  const t = process.env.SH_SMTP_JSON
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
  const info = await t.sendMail({ from: `StopHurting <${c.from}>`, to: TO, subject, text: body });
  if (process.env.SH_SMTP_JSON) writeFileSync(process.env.SH_SMTP_JSON, String(info.message));
  console.log(`   ✉ emailed ${TO}: ${subject}`);
  return true;
}

// `problems` is the array of human-readable strings build.mjs already prints. Each is its own
// alarm, keyed on its first few words so a changing day-count does not read as a new problem.
export async function reportHealth(problems, { commit = false } = {}) {
  const state = loadState();
  const now = Date.now();
  const key = (p) => p.split(' ').slice(0, 3).join(' ');
  const current = new Map(problems.map((p) => [key(p), p]));

  // ⛔⛔ EVERY KEY IN `open` IS AN ALARM AND NOTHING ELSE. This used to store the problem's text as
  // a SECOND key, `${k}__text`, alongside it — and `cleared` below is "every key in open that is
  // not in current". A `__text` twin is never in `current`, so from the second run onward it was
  // always counted as recovered: measured before wiring this up, a still-broken feed produced
  //   run 1  "1 problem with the recall feed"
  //   run 2  "recall feed recovered"      ← nothing had changed
  // Six runs a day, each one telling him a dead feed was fine. That is worse than the silence it
  // was written to fix, and it would have been the FIRST thing this alerter ever did.
  // 📖 The shape is the fix: one key per alarm, its payload nested. A parallel key that means
  // something other than "an alarm is open" cannot survive in a map that is read as a set.
  // ⛔ NO COMPATIBILITY SHIM FOR THE OLD SHAPE, deliberately: reportHealth had never been called
  // by anything, so no alert-state.json has ever existed on any machine (checked). A branch that
  // can never execute is not backwards compatibility, it is a second unreadable path that makes
  // the bug look handled — and it would NOT have been, because `cleared` would still count the
  // stray `__text` keys.
  const since = (k) => state.open[k]?.since;
  const textOf = (k) => state.open[k]?.text || k;

  // ⛔⛔ ONE SIGHTING IS NOT A PROBLEM — IT IS A BLIP, and mailing blips is how an alarm dies.
  // Half of what this watches is `XX feed failed: <network error>`. A single dropped connection on
  // a 4-hourly job (the Canadian CSV is DOCUMENTED as getting dropped mid-transfer) would have
  // mailed "problem" on one run and "recovered" on the next: two emails, nothing wrong, six
  // chances a day. That is the exact shape his own doctrine names — a repeating alarm is one you
  // filter, and then it is worth nothing on the day it matters.
  // ⭐ So an alarm has TWO stages. `pending` = seen once, saying nothing. `open` = seen on two
  // consecutive runs, mailed. Only `open` alarms can "recover", which also means we can never
  // announce the recovery of something we never reported — four hours of grace costs nothing
  // against thresholds measured in DAYS, and a genuinely dead feed is still dead on the next run.
  const toMail = [];
  const nextOpen = {};
  const nextPending = {};
  for (const [k, text] of current) {
    if (state.open[k]) {
      const age = now - new Date(since(k)).getTime();
      // NaN (a corrupted timestamp) must not silence the reminder forever — treat it as due.
      const due = !(age < REMIND_AFTER_HOURS * 3600e3);
      if (due) toMail.push(`STILL BROKEN: ${text}`);
      nextOpen[k] = { since: due ? new Date().toISOString() : since(k), text };
    } else if (state.pending?.[k]) {
      toMail.push(`NEW: ${text}`);                       // second consecutive sighting — now it is real
      nextOpen[k] = { since: new Date().toISOString(), text };
    } else {
      nextPending[k] = { since: new Date().toISOString(), text };   // first sighting — hold it back
    }
  }
  // Only things we actually told him about can be told they are fixed.
  const cleared = Object.keys(state.open).filter((k) => !current.has(k));

  // ⛔⛔ WHAT THE LADDER LOOKS LIKE WHEN NOTHING WAS ACTUALLY SENT. Caught by check-alert.mjs the
  // first time it ran, in this file's own new code: on a run that tried to promote a problem and
  // could not mail (no credential yet, or Zoho refused), the key had left `pending` for `nextOpen`
  // and `nextOpen` was then discarded — so it belonged to NEITHER stage and the next run treated
  // it as a first sighting again. With no credential that oscillates forever: held, attempted,
  // forgotten, held. The backlog he is owed the moment he writes the credential file would never
  // have existed, which is the one property the no-credential path is FOR.
  // So every unsent run falls back to "still pending, keep its original clock".
  const stillPending = {};
  for (const [k, text] of current) {
    if (state.open[k]) continue;                       // already open; a failed send cannot demote it
    const prior = state.pending?.[k] || nextPending[k];
    stillPending[k] = { since: prior?.since || new Date().toISOString(), text };
  }

  const held = Object.keys(nextPending);
  if (held.length) console.log(`   ✉ ${held.length} problem(s) seen for the first time — held one run in case it is a blip`);

  if (!toMail.length && !cleared.length) {
    if (problems.length && !held.length) console.log(`   ✉ ${problems.length} known problem(s), already reported — not re-mailing`);
    // ⛔ STILL PERSIST. `pending` is the memory that makes the second sighting mean something; an
    // early return here would reset every alarm to "first sighting" on every run, and nothing
    // would ever be mailed at all. The quiet path is the one that had to keep writing.
    persist({ open: state.open, pending: stillPending });
    return { mailed: false, held: held.length, open: Object.keys(state.open).length };
  }

  const lines = [];
  if (toMail.length) { lines.push('Problems:', ...toMail.map((t) => `  · ${t}`), ''); }
  if (cleared.length) { lines.push('Recovered:', ...cleared.map((k) => `  · ${textOf(k)}`), ''); }
  lines.push(
    'This is the stophurting-recalls task, which runs every 4 hours on Borg-Cube.',
    'Full output: C:\\GitHub\\stophurting\\tools\\recalls\\run.log',
    '',
    'A stale country means recalls are not being published to the site. Australia is the',
    'urgent one: its feed is a rolling 25 items with no archive, so anything that scrolls',
    'off while the feed is broken is gone permanently.',
  );
  const subject = toMail.length
    ? `stophurting: ${toMail.length} problem${toMail.length > 1 ? 's' : ''} with the recall feed`
    : 'stophurting: recall feed recovered';

  if (!commit) {
    console.log(`   ✉ WOULD email ${TO}: ${subject}`);
    // A dry run must not promote anything to `open` — nothing was actually said — but it still
    // records what it saw, so a dry run followed by a real one behaves like two real runs.
    persist({ open: state.open, pending: stillPending });
    return { mailed: false, would: subject, held: held.length };
  }
  try {
    const sent = await send(subject, lines.join('\n'));
    // ⛔ NO CREDENTIAL = NOTHING WAS SAID. Keep `open` exactly as it was so the first run after
    // Jason writes the credential file mails the backlog rather than silently adopting it.
    if (!sent) { persist({ open: state.open, pending: stillPending }); return { mailed: false, reason: 'no-credential' }; }
  } catch (e) {
    // ⛔ A failed alert must never fail the build. The build's own non-zero exit and run.log are
    // still there; losing those too because the mail server hiccuped would be the worse outcome.
    console.log(`   ✉ alert failed to send (${String(e.message).split('\n')[0]}) — run.log still has it`);
    persist({ open: state.open, pending: stillPending });
    return { mailed: false, reason: 'send-failed' };
  }
  // Promote only now: an alarm is `open` once he has actually been told about it.
  persist({ open: nextOpen, pending: nextPending });
  return { mailed: true, subject, problems: toMail.length, cleared: cleared.length };
}

// ⭐ AN EVENT IS NOT A CONDITION, and reportHealth above is built for conditions. "Australia has
// published nothing for 21 days" is true until it stops being true, so it dedupes and it recovers.
// "This post shipped with the wrong card" happens once, is already in the past by the time anyone
// reads it, and never recovers on its own — a post is examined once and then recorded as posted,
// so it can never be re-detected and there is nothing for a "recovered" mail to mean.
// ⛔ Running one through the other would also make them clobber each other: reportHealth treats
// every key absent from THIS call as cleared, so a facebook run with nothing wrong would mail
// "recovered" for a stale feed that is still stale. Separate function, separate semantics, no
// shared state file.
// ⛔ `why` IS A PARAMETER BECAUSE THIS IS A GENERIC REPORTER. The first version welded one
// incident's postmortem — "a post whose card scraped the 404 page cannot be repaired in place" —
// into the body of every event it would ever send, and its very first caller already has a second
// trigger (a post with no card at all, which is a different failure with a different fix). An
// explanation that is only sometimes true is worse than none: it tells him what to go and do.
export async function reportEvent(subject, lines, { commit = false, why = [] } = {}) {
  if (!lines.length) return { mailed: false, reason: 'nothing-to-report' };
  const body = [
    ...lines.map((l) => `  · ${l}`),
    '',
    'This is the stophurting-recalls task, which runs every 4 hours on Borg-Cube.',
    'Full output: C:\\GitHub\\stophurting\\tools\\recalls\\run.log',
    ...(why.length ? ['', ...why] : []),
  ].join('\n');
  if (!commit) { console.log(`   ✉ WOULD email ${TO}: ${subject}`); return { mailed: false, would: subject }; }
  try {
    const sent = await send(subject, body);
    return { mailed: sent, subject };
  } catch (e) {
    // Same rule as above: a failed alert must never be the thing that fails the run.
    console.log(`   ✉ alert failed to send (${String(e.message).split('\n')[0]}) — run.log still has it`);
    return { mailed: false, reason: 'send-failed' };
  }
}
