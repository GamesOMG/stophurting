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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

function loadState() {
  if (!existsSync(ALERT_STATE)) return { open: {} };
  try { return JSON.parse(readFileSync(ALERT_STATE, 'utf8')); } catch { return { open: {} }; }
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
  const t = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass },
  });
  await t.sendMail({ from: `StopHurting <${c.from}>`, to: TO, subject, text: body });
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

  const toMail = [];
  for (const [k, text] of current) {
    const seen = state.open[k];
    if (!seen) toMail.push(`NEW: ${text}`);
    else if (now - new Date(seen).getTime() > REMIND_AFTER_HOURS * 3600e3) toMail.push(`STILL BROKEN: ${text}`);
  }
  const cleared = Object.keys(state.open).filter((k) => !current.has(k));

  if (!toMail.length && !cleared.length) {
    if (problems.length) console.log(`   ✉ ${problems.length} known problem(s), already reported — not re-mailing`);
    return;
  }

  const lines = [];
  if (toMail.length) { lines.push('Problems:', ...toMail.map((t) => `  · ${t}`), ''); }
  if (cleared.length) { lines.push('Recovered:', ...cleared.map((k) => `  · ${state.open[k + '__text'] || k}`), ''); }
  lines.push(
    'This is the stophurting-recalls task, which runs every 4 hours on the workshop PC.',
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
    return;
  }
  try {
    const sent = await send(subject, lines.join('\n'));
    if (!sent) return;                      // no credential: do NOT record, so it mails once configured
  } catch (e) {
    // ⛔ A failed alert must never fail the build. The build's own non-zero exit and run.log are
    // still there; losing those too because the mail server hiccuped would be the worse outcome.
    console.log(`   ✉ alert failed to send (${String(e.message).split('\n')[0]}) — run.log still has it`);
    return;
  }
  const next = { open: {} };
  for (const [k, text] of current) {
    next.open[k] = current.has(k) && state.open[k] && !toMail.some((t) => t.includes(text))
      ? state.open[k]                        // keep the original first-seen time
      : new Date().toISOString();
    next.open[`${k}__text`] = text;
  }
  writeFileSync(ALERT_STATE, JSON.stringify(next, null, 1));
}
