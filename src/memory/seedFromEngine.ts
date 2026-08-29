// The install-time seed: what the engine knew about its user, folded into Irises' own memory tiers
// so her very first message is not a cold one. Runs ONCE per install, minutes after
// `engine-setup.sh` finished, from the first-move state machine (src/agents/ops/firstMove.ts) —
// which owns the asking, the sanitizing and the chat_id write. This file only writes memory, and
// only for the handle it is handed.
//
// Every rule below comes from one fact: THIS IS SECOND-HAND. Nobody told Irises any of it; another
// agent did, about a person she has never spoken to.
//   • ONLY WHERE MEMORY IS EMPTY. The dossier is written only when both the legacy dossier and the
//     long doc are blank. Earned memory always outranks a seed, and "empty" doubles as the
//     idempotency test — a re-install, a resumed phase, or a re-key onto the real inbound handle
//     all re-run this function, and the second run must be a near no-op rather than a clobber.
//   • THE PROVENANCE TRAVELS WITH IT. The dossier carries an italic line saying where the picture
//     came from, and the medium tier gets one important note saying to hold it lightly. Without
//     those she would quote the engine's summary back as something they told her, which is the one
//     failure mode that would make the whole feature feel like surveillance.
//   • THEMES ARE MINTED THROUGH THE REAL PATH. applyThreadHarvest, not a hand-built row: a seeded
//     theme has to be byte-identical to one she noticed herself (status `open`, mint confidence,
//     one evidence day, never surfaceable until a second day's evidence arrives), or the seed would
//     be jumping a queue the whole threading feature is built on. The harvest COUNTERS it bumps are
//     put back to zero afterwards — she has not actually had two turns with this person.
//   • ONE TIER'S FAILURE COSTS ONE TIER. Each phase is caught on its own: a mangled long doc must
//     not cost the medium fact, and neither may take the introduction down with it.
//
// No LLM call anywhere in here, by design. The engine already wrote the prose; a summarizer pass
// over a summary would only add a place for a hallucination to enter durable memory.

import { getForgetEpoch, getMemory } from '../db/repositories/memory.js';
import { getLongDoc } from '../db/repositories/memoryLong.js';
import { addImportantNote, upsertFact } from '../db/repositories/memoryMedium.js';
import { setUserName } from '../db/repositories/profiles.js';
import {
  getThreadInventory, saveThreadInventory, threadingEnabled,
} from '../db/repositories/threadInventory.js';
import { applyThreadHarvest, THREAD_NOTE_PREFIX_RE, type ThreadInventory } from '../persona/threads.js';
import { persistDossierMerge } from './dossier.js';
import type { EngineProfile } from '../agents/ops/firstMoveProfile.js';

/** What was actually written. `facts` counts MEDIUM-TIER ENTRIES (the details fact + the
 *  hold-it-lightly note), not fields of the profile — the name lands on the profile row, which is
 *  not a medium entry. The caller puts these on the `first-move:seeded` receipt. */
export interface SeedCounts {
  dossier: boolean;
  facts: number;
  themes: number;
}

/** The single fact key the details live under. A KEY, not an append: upsertFact supersedes by key,
 *  so re-running the seed rewrites one row instead of stacking five near-duplicates. */
export const SEED_FACT_KEY = 'engine_seed_details';

/** The `source` stamped on every medium entry written here, so a later groom (or a human reading
 *  MEDIUM.md) can tell seeded material from something she was actually told. */
export const SEED_SOURCE = 'engine_seed';

/** The one note that keeps everything else here honest. Byte-pinned by the test: this sentence is
 *  what stops her citing a seeded detail as something they said to her. */
export const SEED_NOTE = 'your first picture of them came from the engine you front, at install — hold it lightly, verify it naturally in conversation, and never cite it as something they told you';

/** Two themes, never more. Threading earns its patterns over weeks; seeding more than a couple
 *  would fill an empty inventory with guesses that then compete for airtime against things she
 *  actually noticed. */
export const SEED_THEMES_MAX = 2;

/** The dossier's word budget — the same ~400 words the LLM updater is told to keep to, so a seeded
 *  doc and a grown one cost the prompt the same. */
export const DOSSIER_WORD_CAP = 400;

/** How the seeded doc says where it came from. Italic and first-person-to-Irises, sitting inside
 *  "## Who they are" where she cannot miss it while reading who they are. */
const PROVENANCE_LINE = '*This first picture came from the engine you front, handed over at install — it is second-hand, not something they told you. Hold it lightly and let them confirm it naturally.*';

/** A detail that trivially reads as a running joke or a named object, which is the ONLY thing that
 *  earns the "## Running jokes" heading. Deliberately dumb: a quoted name, or them plainly saying
 *  they call the thing something. Anything cleverer would be a classifier guessing at humour. */
const JOKE_DETAIL_RE = /\bjokes?\b|\bjoking\b|\bnicknamed?\b|\bcalls (it|them|him|her|the)\b|"[^"]{2,40}"/i;

/** Details that read as something they are working toward. Only a plain verb phrase counts — this
 *  picks a PREFIX for the note grammar, and a wrong guess would file a hobby as a goal. */
const GOAL_DETAIL_RE = /\b(wants? to|trying to|training for|learning|saving (up )?for|working (on|towards?)|hopes? to|planning to|aiming to)\b/i;

/** Details that read as a standing preference or conviction. Same restraint as the goal test. */
const VALUE_DETAIL_RE = /\b(believes|values|swears by|hates|loves|refuses|insists|can'?t stand|only ever|never)\b/i;

/** Sentence split on terminal punctuation. Crude on purpose — it decides where the brief is cut in
 *  half between two headings, and a cut that lands one sentence early is invisible. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Cap the whole document at `maxWords`, cutting on a SENTENCE boundary — a dossier that stops
 * mid-clause reads as damage (dossierUpdateUsable's doctrine next door: a truncated document is not
 * a shorter one). Falls back to a line boundary when the tail holds no sentence end at all, e.g. a
 * run of bullets, and then drops any heading the cut left with nothing under it.
 */
function capWords(doc: string, maxWords: number): string {
  const re = /\S+/g;
  let count = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    count++;
    if (count === maxWords) { end = m.index + m[0].length; break; }
  }
  if (end < 0) return doc;                       // never reached the budget

  let cut = doc.slice(0, end);
  let boundary = -1;
  const term = /[.!?](?=\s|$)/g;
  while ((m = term.exec(cut))) boundary = m.index;
  cut = boundary >= 0 ? cut.slice(0, boundary + 1) : cut.slice(0, Math.max(0, cut.lastIndexOf('\n')));

  const lines = cut.split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || last.startsWith('#')) { lines.pop(); continue; }
    break;
  }
  return lines.join('\n').trim();
}

/**
 * The seeded LONG.md, or '' when there is nothing worth writing. Pure and exported so the preview
 * script and the tests can see the document without touching the store.
 *
 * The headings are the canonical ones and appear in the canonical order (DOSSIER_SYSTEM_PROMPT:
 * Who they are → How they work → How to text them → Their world → Running jokes), so the next real
 * LLM merge folds into this doc instead of fighting it. Two of the five are never written here on
 * purpose: how they WORK and how to TEXT them are things she learns by working and texting, and a
 * second-hand guess at either would shape her voice from day one.
 */
export function buildSeedDossier(profile: EngineProfile): string {
  if (profile.empty) return '';

  const said = sentences(profile.brief);
  const opening = said.slice(0, 2);
  const rest = said.slice(2);
  const jokes = profile.details.filter(d => JOKE_DETAIL_RE.test(d));
  const world = profile.details.filter(d => !jokes.includes(d));

  const who: string[] = [];
  if (profile.name) who.push(`They go by ${profile.name}.`);
  if (opening.length) who.push(opening.join(' '));
  who.push(PROVENANCE_LINE);

  const sections: string[] = [`## Who they are\n${who.join('\n')}`];

  const worldLines = [...(rest.length ? [rest.join(' ')] : []), ...world.map(d => `- ${d}`)];
  if (worldLines.length) sections.push(`## Their world\n${worldLines.join('\n')}`);
  if (jokes.length) sections.push(`## Running jokes\n${jokes.map(d => `- ${d}`).join('\n')}`);

  return capWords(sections.join('\n\n'), DOSSIER_WORD_CAP);
}

/**
 * One detail → a note the thread grammar accepts. The prefix is chosen HERE, never inherited: a
 * detail that arrived already wearing `loop:` would otherwise mint a pending question in someone's
 * life out of a hobby, and the engine's words must not get to pick the material. Unprefixed is the
 * honest default — a `pattern` theme is "she noticed a shape she cannot name more precisely",
 * which is exactly what a seeded detail is.
 */
export function seedThemeNote(detail: string): string {
  const m = THREAD_NOTE_PREFIX_RE.exec(detail);
  const bare = (m ? m[2] : detail).trim();
  if (!bare) return detail;
  if (GOAL_DETAIL_RE.test(bare)) return `goal: ${bare}`;
  if (VALUE_DETAIL_RE.test(bare)) return `value: ${bare}`;
  return bare;
}

/** LONG.md v1, and only into a vacuum. Both readers are checked because they are two stores: the
 *  legacy `dossier_md` column and the versioned long doc, dual-written by persistDossierMerge. */
async function seedDossier(handle: string, profile: EngineProfile): Promise<boolean> {
  const doc = buildSeedDossier(profile);
  if (!doc) return false;

  const memory = await getMemory(handle);
  if ((memory?.dossierMd ?? '').trim()) return false;
  const long = await getLongDoc(handle);
  if ((long?.docMd ?? '').trim()) return false;

  // The epoch is read AFTER the emptiness checks and passed into the save, exactly like the LLM
  // merge next door: a /forget landing between here and the write refuses it. The baseline doc is
  // the empty string because that is what we just proved both stores hold.
  const epoch = getForgetEpoch(handle);
  const { dossierSaved } = await persistDossierMerge(handle, doc, { epoch, dossierMd: '' });
  return dossierSaved;
}

/** Name → the profile row; details → ONE superseding fact; and the note that keeps both honest. */
async function seedMedium(handle: string, profile: EngineProfile): Promise<number> {
  let written = 0;
  if (profile.name) await setUserName(handle, profile.name);
  if (profile.details.length) {
    await upsertFact(handle, SEED_FACT_KEY, profile.details.join('; '), SEED_SOURCE);
    written++;
  }
  // Nothing was seeded, so there is nothing to hold lightly — the note would be a warning about a
  // picture that does not exist.
  if (!profile.empty) {
    await addImportantNote(handle, SEED_NOTE, SEED_SOURCE);
    written++;
  }
  return written;
}

/**
 * Up to two themes, minted through the real harvest so they are indistinguishable from noticed
 * ones. Skipped whole whenever the inventory shows ANY life — a theme already held, or a harvest
 * already run — because at that point she has her own read of this person and a seed would be
 * arguing with it.
 */
async function seedThemes(handle: string, profile: EngineProfile, now: number): Promise<number> {
  if (!threadingEnabled()) return 0;
  const notes = profile.details.slice(0, SEED_THEMES_MAX).map(seedThemeNote);
  if (!notes.length) return 0;

  const epoch = getForgetEpoch(handle);
  const inventory = await getThreadInventory(handle);
  if (inventory.themes.length > 0 || inventory.harvestCount > 0) return 0;

  let next: ThreadInventory = inventory;
  let minted = 0;
  for (const note of notes) {
    const res = applyThreadHarvest(next, note, null, now);
    next = res.next;
    if (res.report.note === 'minted') minted++;
  }
  if (!minted) return 0;

  // Put the harvest's own bookkeeping back: `harvestCount` is how many turns she has taken with
  // this person and `turnsSinceOffer` paces how soon she may bring a thread up. Both would be lies
  // — she has not said a word to them yet. `lastHarvestAt` deliberately STAYS at `now`: it is the
  // "conversation has gone quiet" clock, and reading it as fresh is what keeps the thread-ping
  // sweep from asking about a seeded theme before she has ever spoken.
  next = { ...next, harvestCount: 0, turnsSinceOffer: 0 };
  const saved = await saveThreadInventory(handle, next, { ifForgetEpoch: epoch });
  return saved ? minted : 0;
}

/**
 * Fold a sanitized engine profile into this handle's memory. Never throws — every phase stands or
 * falls alone (see the header), and the caller treats the counts as a receipt, not as a verdict.
 *
 * NOT this function's job: `ensureChatId`. The handle is only half the story of where she can text
 * someone, and the caller (firstMove.ts) is the one holding the channel — writing the chat_id from
 * in here would mean seeding could never be re-run against a handle whose channel we do not know.
 */
export async function seedFromEngineProfile(
  handle: string,
  profile: EngineProfile,
  now: number,
): Promise<SeedCounts> {
  const counts: SeedCounts = { dossier: false, facts: 0, themes: 0 };

  try {
    counts.dossier = await seedDossier(handle, profile);
  } catch (err) {
    console.error(`[memory] engine seed: dossier phase failed for ${handle}`, err);
  }

  try {
    counts.facts = await seedMedium(handle, profile);
  } catch (err) {
    console.error(`[memory] engine seed: medium phase failed for ${handle}`, err);
  }

  try {
    counts.themes = await seedThemes(handle, profile, now);
  } catch (err) {
    console.error(`[memory] engine seed: theme phase failed for ${handle}`, err);
  }

  console.log(
    `[memory] engine seed for ${handle}: dossier=${counts.dossier} facts=${counts.facts} themes=${counts.themes}`,
  );
  return counts;
}
