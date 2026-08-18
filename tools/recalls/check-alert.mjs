#!/usr/bin/env node
// Prove the email alerter says the right thing, and — far more often — says NOTHING.
//
// ⛔ WHY THIS EXISTS AT ALL. alert.mjs was written, committed by an automated run, and imported by
// NOTHING for days. The first code ever to execute it would have been the code that mails Jason.
// Measured before it was wired up, it had a bug that made its very first act a lie: a still-broken
// feed produced "1 problem" on one run and "recall feed recovered" on the next, six times a day.
//
// ⭐ This drives the REAL exported functions in-process. It re-implements none of them. The send
// path is exercised through nodemailer's own jsonTransport (SH_SMTP_JSON), so every assertion
// below covers the actual code that talks to Zoho — composition, state promotion and all — with
// no network and none of Jason's credentials.
//
// ⭐⭐ ALMOST EVERY SCENARIO HERE IS A SILENCE TEST. An alerter is judged on what it does NOT send:
// a repeating alarm is one you filter, and a filtered alarm is worth nothing on the day it matters.
//
// Usage: node tools/recalls/check-alert.mjs

import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'sh-alert-'));
const STATE = path.join(tmp, 'alert-state.json');
const SENT = path.join(tmp, 'sent.eml');
const CRED = path.join(tmp, 'smtp.txt');

process.env.SH_ALERT_STATE = STATE;
process.env.SH_SMTP_JSON = SENT;
process.env.SH_SMTP_FILE = CRED;
const withCredential = () => writeFileSync(CRED, 'smtp.example.invalid:465\nfixture@example.invalid\nFIXTURE-PASSWORD\nadmin@stophurting.org\n');
const withoutCredential = () => { if (existsSync(CRED)) rmSync(CRED); };

// Imported AFTER the env is set: alert.mjs reads its paths at module load, which is the same
// constraint production has.
const { reportHealth, reportEvent } = await import('./alert.mjs');

let pass = 0, fail = 0;
const AU = 'AU has published nothing for 21 days (expected within 21)';
const UK = 'UK feed failed: HTTP 503 from gov.uk';

// Every run starts by forgetting what was sent, so "did this run mail?" is answered by the file
// existing, not by parsing a counter we maintain ourselves.
async function run(problems, { commit = true } = {}) {
  if (existsSync(SENT)) rmSync(SENT);
  const result = await reportHealth(problems, { commit });
  return { result, mail: existsSync(SENT) ? readFileSync(SENT, 'utf8') : null };
}

function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
const reset = () => { if (existsSync(STATE)) rmSync(STATE); };
const silent = (r, why) => { if (r.mail) throw new Error(`${why} — but it mailed: ${JSON.parse(r.mail).subject}`); };
const mailed = (r, needle, why) => {
  if (!r.mail) throw new Error(`${why} — but NOTHING was sent`);
  const m = JSON.parse(r.mail);
  const hay = `${m.subject}\n${m.text}`;
  if (!hay.includes(needle)) throw new Error(`${why} — sent, but "${needle}" is not in it:\n${hay}`);
};

console.log('alert.mjs (real functions, nodemailer jsonTransport):\n');
withCredential();

// ── the two-stage ladder ───────────────────────────────────────────────────────────────────
// ⛔⛔ THE BLIP RULE. Half of what this watches is `XX feed failed: <network error>`, and a single
// dropped connection on a 4-hourly job is not a problem — it is weather. Mailing it would produce
// a "broken" and a "recovered" for nothing, which is precisely how an inbox learns to ignore you.
reset();
{
  const r = await run([UK]);
  check('a problem seen ONCE is held back, not mailed', () => {
    silent(r, 'one sighting of a feed error is a blip');
    if (!/held one run/.test('' + (r.result.held ? 'held one run' : ''))) throw new Error('the run must say it held something back');
  });
}
{
  const r = await run([]);
  check('a blip that clears while held is never mentioned at all', () => {
    silent(r, 'it was never reported, so there is nothing to recover from');
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if (Object.keys(s.pending).length) throw new Error('a problem that went away must not stay pending');
    if (Object.keys(s.open).length) throw new Error('it must never have been opened');
  });
}
reset();
{
  await run([AU]);                                   // first sighting — held
  const r = await run([AU]);                         // second consecutive — real
  check('a problem seen on TWO consecutive runs is mailed once', () => {
    mailed(r, 'NEW: AU has published nothing', 'the second sighting is the real alarm');
  });
}
{
  const r = await run([AU]);
  check('the same problem on the next run is SILENT', () => {
    silent(r, 'he already knows; six identical mails a day is how an alarm dies');
  });
}
{
  const r = await run([AU]);
  check('and silent again — silence means "still broken, you know"', () => silent(r, 'still nothing new to say'));
}

// ── the 24h reminder ───────────────────────────────────────────────────────────────────────
{
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  s.open['AU has published'].since = new Date(Date.now() - 25 * 3600e3).toISOString();
  writeFileSync(STATE, JSON.stringify(s));
  const r = await run([AU]);
  check('after 24 hours it reminds him, once', () => mailed(r, 'STILL BROKEN', 'a day of silence on a live problem is too long'));
  const after = await run([AU]);
  check('and then goes quiet again for another day', () => silent(after, 'the reminder resets the clock'));
}

// ── recovery ───────────────────────────────────────────────────────────────────────────────
{
  const r = await run([]);
  check('recovery is mailed once', () => mailed(r, 'Recovered:', 'a closed alarm has to be closed out loud'));
  const again = await run([]);
  check('a recovered problem is not re-announced every run', () => silent(again, 'it recovered once'));
}

// ⛔ THE BUG THAT WAS MEASURED BEFORE THIS FILE EXISTED. Its first act would have been to tell him
// a dead feed was fine. Keyed on the reader's experience, not on the implementation that caused it.
reset();
{
  await run([AU]); await run([AU]);                  // ladder: held, then mailed
  const r = await run([AU]);
  check('an UNCHANGED problem is never reported as recovered', () => {
    if (r.mail && /recovered/i.test(JSON.parse(r.mail).subject)) {
      throw new Error('it told him a still-broken feed had recovered — the original defect');
    }
    silent(r, 'nothing changed');
  });
}

// ── two independent alarms ─────────────────────────────────────────────────────────────────
reset();
{
  await run([AU, UK]); const both = await run([AU, UK]);
  check('two different problems open independently', () => {
    mailed(both, 'AU has published', 'AU must be named');
    mailed(both, 'UK feed failed', 'UK must be named');
  });
  const r = await run([AU]);                          // UK clears, AU persists
  check('one recovering does not clear the other', () => {
    mailed(r, 'Recovered:', 'UK recovered');
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if (!s.open['AU has published']) throw new Error('AU is still broken and must stay open');
  });
  const quiet = await run([AU]);
  check('and the survivor stays silent afterwards', () => silent(quiet, 'AU was already reported'));
}

// ── the credential, which is Jason's to write ──────────────────────────────────────────────
// ⭐ The point of this pair: an unconfigured alerter must LOSE NOTHING. If a missing credential
// silently marked problems as reported, the first run after he writes the file would say nothing
// and the backlog would be gone.
reset();
withoutCredential();
{
  await run([AU]); const r = await run([AU]);
  check('with no credential it reports that it could not send', () => {
    silent(r, 'nothing can be sent without a credential');
    if (r.result.reason !== 'no-credential') throw new Error(`the caller must be told why, got ${JSON.stringify(r.result)}`);
  });
  check('and it does NOT record the problem as reported', () => {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if (Object.keys(s.open).length) throw new Error('a problem he was never told about must not be marked as told');
  });
}
withCredential();
{
  const r = await run([AU]);
  check('the first run after the credential appears mails the backlog', () => {
    mailed(r, 'NEW: AU has published', 'the alarm was waiting, not lost');
  });
}

// ── it must never be the thing that breaks the build ───────────────────────────────────────
// ⛔ Its own contract, and it used to be false: the state write sat outside every try/catch, one
// statement after a mail that had already gone out.
reset();
{
  process.env.SH_ALERT_STATE = path.join(tmp, 'no', 'such', 'dir', 'state.json');
  const { reportHealth: rh } = await import(`./alert.mjs?unwritable=1`);
  let threw = null;
  try { await rh([AU], { commit: true }); await rh([AU], { commit: true }); } catch (e) { threw = e; }
  check('an unwritable state file does not throw out of reportHealth', () => {
    if (threw) throw new Error(`it threw ${threw.message} — build.mjs awaits this at top level, so that kills the run`);
  });
  process.env.SH_ALERT_STATE = STATE;
}
for (const junk of ['{}', 'null', '[]', '{"open":null}', 'not json at all']) {
  reset();
  writeFileSync(STATE, junk);
  const { reportHealth: rh } = await import(`./alert.mjs?junk=${encodeURIComponent(junk)}`);
  let threw = null;
  try { await rh([], { commit: true }); } catch (e) { threw = e; }
  check(`a state file holding ${junk} is survived, not thrown on`, () => {
    if (threw) throw new Error(`threw ${threw.message} — and this fires on a HEALTHY run too`);
  });
}
reset();

// ── reportEvent: a different shape of thing entirely ───────────────────────────────────────
{
  if (existsSync(SENT)) rmSync(SENT);
  await reportEvent('subject line', ['a post shipped wrong'], { commit: true, why: ['because reasons'] });
  check('reportEvent sends what it was given', () => {
    const m = JSON.parse(readFileSync(SENT, 'utf8'));
    if (!m.text.includes('a post shipped wrong')) throw new Error('the incident must be in the body');
    if (!m.text.includes('because reasons')) throw new Error('the caller-supplied explanation must be in the body');
  });
  check('reportEvent writes NO state', () => {
    // ⛔ Load-bearing. An event is not a condition: if it shared reportHealth's state file, a
    // facebook run with nothing wrong would mail "recovered" for a feed that is still stale.
    if (existsSync(STATE)) throw new Error('reportEvent must not touch the health alarm ledger');
  });
  if (existsSync(SENT)) rmSync(SENT);
  await reportEvent('subject line', [], { commit: true });
  check('reportEvent with nothing to say says nothing', () => {
    if (existsSync(SENT)) throw new Error('an empty incident list must not produce a mail');
  });
  if (existsSync(SENT)) rmSync(SENT);
  await reportEvent('subject line', ['x'], { commit: true });
  check('reportEvent carries no explanation it was not given', () => {
    const m = JSON.parse(readFileSync(SENT, 'utf8'));
    // It used to weld one incident's postmortem — "cannot be repaired in place… delete the post" —
    // into every event it would ever send, including ones with an entirely different fix.
    if (/repaired in place|delete the post/i.test(m.text)) throw new Error('a hardcoded postmortem tells him to go and do the wrong thing');
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed${fail ? ` · ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);
