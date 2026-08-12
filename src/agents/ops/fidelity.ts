// Ops↔tool-output fidelity backstop (charter §10.2, previously named-but-unbuilt).
//
// The one guarantee: no hard fact (dollar amount, date, phone, email, address, person name) reaches
// the user unless it appears in that run's TOOL OUTPUTS. Ops grounding is otherwise prompt-only, and
// the Composer never sees the tool corpus, so a confident fabrication ("Richard Blanchard", "$5,000"
// for the wrong deal, a made-up phone) has nothing structural stopping it. This is that structure.
//
// Design:
//   - Layer 1 (deterministic, always on): extract atomic facts from the summary, normalize both the
//     summary facts AND the corpus per family, check membership. Format-normalized so $489k ==
//     ~$489,000 == 489000 and "July 21, 2026" == 2026-07-21, to avoid false positives.
//   - Layer 2 (bounded classify, optional): only the hard facts Layer 1 could not ground go to one
//     small LLM call ("which of these are unsupported, allowing paraphrase/relative dates?"). It can
//     only RESCUE Layer-1 false positives (move ungrounded→grounded); on error we keep Layer 1's
//     stricter verdict — the user chose zero-fabrication over completeness.
//
// The corpus is ONLY the tool outputs (never the model's own turns — else a self-consistent
// fabrication grounds itself). The task request/hints additionally ground name/address mentions
// (the user naming an address doesn't make a price real), never currency/date/phone/email.

import { callLLM } from '../../llm/callLLM.js';

export type FactFamily = 'currency' | 'date' | 'phone' | 'email' | 'address' | 'name' | 'identifier';

export interface AtomicFact {
  family: FactFamily;
  raw: string;   // as it appears in the summary
  norm: string;  // normalized key for membership
}

export interface GroundingReport {
  ok: boolean;                    // true = safe to ship as-is
  ungrounded: AtomicFact[];       // facts that suppressed the answer (hard families, per enforce mode)
  softUngrounded: AtomicFact[];   // ungrounded but non-enforced (logged only)
  checkedFamilies: Record<FactFamily, number>;
}

// Which families, when ungrounded, suppress the whole answer. 'all' includes person names (the
// user's flagship fabrication was a name); 'hard' excludes names (their extraction is the noisiest);
// 'off' disables enforcement (compute + log only). Tunable without a redeploy.
type EnforceMode = 'all' | 'hard' | 'off';
function enforceMode(): EnforceMode {
  const v = (process.env.FIDELITY_ENFORCE || 'all').toLowerCase();
  return v === 'hard' || v === 'off' ? v : 'all';
}
const HARD_FAMILIES: FactFamily[] = ['currency', 'date', 'phone', 'email', 'address', 'identifier'];

// ── extraction / normalization ─────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

// Date matcher shared by the summary extractor and the corpus set. Numeric alternatives FIRST and
// the word branch constrained to REAL month names — a generic [A-Za-z]{3,9} branch listed first
// used to swallow the word before a slash date ("closing 7/4/2026" matched as "closing 7"), so
// numeric dates were never extracted at all (fabrications unchecked AND real dates ungroundable).
// Day-first branch covers RFC-2822 email headers ("Mon, 28 Jun 2026") — without it Gmail tool
// output contributed ZERO corpus dates, so any date Ops stated was ungroundable by Layer 1.
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_RE_SRC = `\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})\\.?(?:,?\\s+\\d{4})?|(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)\\b`;

const STREET_TYPES = 'St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Way|Cir|Circle|Ter|Terrace|Hwy|Highway|Pkwy|Parkway|Trl|Trail|Loop|Pike|Row';

// Capitalized-word phrases that are NOT person names (surface as name candidates but must be ignored).
const NAME_STOPWORDS = new Set([
  'irises', 'gmail', 'dealmachine', 'zillow', 'mls', 'hoa', 'as', 'is', 'i', 'the', 'a', 'an',
  'answer', 'source', 'flags', 'note', 'result', 'no', 'yes', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'street', 'avenue', 'court', 'lane', 'drive',
  ...Object.keys(MONTHS),
]);

function scaleNum(numStr: string, suffix?: string): string | null {
  let n = parseFloat(numStr.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suf = (suffix || '').toLowerCase();
  if (suf === 'k' || suf === 'thousand') n *= 1e3;
  if (suf === 'm' || suf === 'million') n *= 1e6;
  return String(Math.round(n));
}

/** Normalize a currency token to an integer-dollar string, or null. Requires a `$`. */
function normCurrency(raw: string): string | null {
  const m = raw.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|m|thousand|million)?/i);
  return m ? scaleNum(m[1], m[2]) : null;
}

// Currency words that mark a bare number as a monetary value (so tool JSON like
// "earnest_money_amount":7500 grounds, but "5000 sqft" / a street number does NOT).
const CURRENCY_CONTEXT = /(price|amount|earnest|deposit|fee|cost|commission|credit|money|loan|payoff|balance|net|list|sale|sales|purchase|rent|escrow|down\s*payment|closing\s*cost)/i;

/**
 * Corpus currency values: integer-dollar strings that appear AS MONEY in the tool output — either
 * $-prefixed, or a >=3-digit bare number sitting right after a currency word (captures the
 * dollar-signs-stripped JSON the extraction tools return). Crucially it does NOT pool every bare
 * number, so a square footage or street number can't ground a fabricated dollar amount.
 */
function corpusCurrencySet(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?/gi)) {
    const v = scaleNum(m[1], m[2]); if (v) set.add(v);
  }
  // (?:\b|_) so a snake_case JSON key like "earnest_money_amount":7500 matches on "money"/"amount",
  // while "net" inside "internet" (letter-adjacent) does not. The separator class is DELIBERATELY
  // narrow (quotes/space/colon/equals/$/~ only, no commas or letters): a permissive [^\d]{0,14} let
  // a currency word reach across `","other_field":` into an UNRELATED number, re-opening the
  // "fabricated $ grounds off a stray corpus number" hole this set exists to close.
  for (const m of text.matchAll(new RegExp(`(?:\\b|_)${CURRENCY_CONTEXT.source}[a-z_]{0,12}["'\\s]{0,3}[:=]?["'\\s$~]{0,4}(\\d[\\d,]{2,}(?:\\.\\d+)?)\\s*(k|m|thousand|million)?`, 'gi'))) {
    const v = scaleNum(m[2], m[3]); if (v) set.add(v);
  }
  return set;
}

/** Corpus phone numbers as a set of normalized 10-digit strings — a TOKENIZED set, so a fabricated
 *  number can't ground by spanning the digit boundary between two real numbers / an id / a timestamp. */
function corpusPhoneSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g)) {
    const n = normPhone(m[0]); if (n) set.add(n);
  }
  return set;
}

/** Parse a date token to { iso: 'YYYY-MM-DD'|null, md: 'MM-DD'|null }. Handles month-name and numeric. */
function parseDate(raw: string): { iso: string | null; md: string | null } | null {
  // Day-first form: "28 Jun 2026" / "1 July" (RFC-2822 email headers). MUST run before the
  // month-first branch: on "28 Jun 2026" that branch matches at "Jun 2026" and reads June 20.
  let m = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const mm = MONTHS[m[2].toLowerCase()];
    const dd = m[1].padStart(2, '0');
    return { iso: m[3] ? `${m[3]}-${mm}-${dd}` : null, md: `${mm}-${dd}` };
  }
  // Month-name form: "July 21, 2026" / "Jul 21 2026" / "July 21"
  m = raw.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const mm = MONTHS[m[1].toLowerCase()];
    const dd = m[2].padStart(2, '0');
    return { iso: m[3] ? `${m[3]}-${mm}-${dd}` : null, md: `${mm}-${dd}` };
  }
  // Numeric form: MM/DD/YYYY, M/D/YY, YYYY-MM-DD
  m = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return { iso: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, md: `${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` };
  m = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return { iso: `${yyyy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, md: `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` };
  }
  return null;
}

/** All dates found in text → { isos, mds } sets. */
function corpusDateSets(text: string): { isos: Set<string>; mds: Set<string> } {
  const isos = new Set<string>();
  const mds = new Set<string>();
  const re = new RegExp(DATE_RE_SRC, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = parseDate(m[0]);
    if (!d) continue;
    if (d.iso) isos.add(d.iso);
    if (d.md) mds.add(d.md);
  }
  return { isos, mds };
}

function normPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

function normAddress(raw: string): string {
  return raw.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extract atomic facts from the summary text. */
export function extractAtomicFacts(summary: string): AtomicFact[] {
  const facts: AtomicFact[] = [];
  const seen = new Set<string>();
  const add = (family: FactFamily, raw: string, norm: string | null) => {
    if (!norm) return;
    const key = `${family}:${norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ family, raw: raw.trim(), norm });
  };

  // currency (must have $). Range-aware: "$450-475k" carries the trailing scale for BOTH endpoints
  // (the naive single matcher extracted "$450" → norm 450, falsely ungroundable against a corpus
  // stating 450,000). Emits one fact per endpoint at the shared magnitude.
  for (const m of summary.matchAll(/~?\s*\$\s*([\d,]+(?:\.\d{1,2})?)(?:\s*[-–—]\s*\$?\s*([\d,]+(?:\.\d{1,2})?))?\s*(k|m|thousand|million)?/gi)) {
    add('currency', m[0], scaleNum(m[1], m[3]));
    if (m[2]) add('currency', m[0], scaleNum(m[2], m[3]));
  }
  // email
  for (const m of summary.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    add('email', m[0], m[0].toLowerCase());
  }
  // phone
  for (const m of summary.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g)) {
    add('phone', m[0], normPhone(m[0]));
  }
  // address (number + words + street type)
  for (const m of summary.matchAll(new RegExp(`\\b\\d+\\s+[A-Za-z0-9]+(?:\\s+[A-Za-z0-9]+)*?\\s+(?:${STREET_TYPES})\\b`, 'gi'))) {
    add('address', m[0], normAddress(m[0]));
  }
  // dates (numeric-first, month-name-constrained — see DATE_RE_SRC)
  for (const m of summary.matchAll(new RegExp(DATE_RE_SRC, 'gi'))) {
    const d = parseDate(m[0]);
    if (d && (d.iso || d.md)) add('date', m[0], d.iso ?? d.md!);
  }
  // labeled identifiers: NMLS/MLS/license/file/escrow/APN numbers etc. A test run caught a
  // FABRICATED "NMLS #2123456" shipping because a bare 6-7 digit id fits no other family. Only
  // LABELED ids are extracted (label word + number token) so ordinary counts don't false-positive.
  for (const m of summary.matchAll(/\b(?:nmls|mls|license|lic|file|escrow|loan|case|apn|policy|permit)\s*(?:number|no\.?|#|:)?\s*#?\s*([A-Za-z]{0,3}-?\d[\d-]{2,})\b/gi)) {
    add('identifier', m[0], m[1].toUpperCase());
  }
  // person names: 2-3 capitalized alpha tokens, none a stopword, not ALLCAPS acronyms
  for (const m of summary.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)) {
    const tokens = m[1].split(/\s+/);
    if (tokens.some(t => NAME_STOPWORDS.has(t.toLowerCase()))) continue;
    add('name', m[1], m[1].toLowerCase());
  }
  return facts;
}

// ── Layer 1: deterministic grounding check ──────────────────────────────────

/**
 * @param summary       the Ops answer text
 * @param corpus        concatenated TOOL RESULT outputs (the authoritative grounding source)
 * @param softGround    request + hints text — grounds name/address only, never currency/date/phone
 */
export function checkGrounding(summary: string, corpus: string, softGround: string): GroundingReport {
  const facts = extractAtomicFacts(summary);
  const mode = enforceMode();

  const corpusLower = corpus.toLowerCase();
  const softLower = softGround.toLowerCase();
  const currencySet = corpusCurrencySet(corpus);
  const phoneSet = corpusPhoneSet(corpus);
  const { isos, mds } = corpusDateSets(corpus);

  const checkedFamilies: Record<FactFamily, number> = { currency: 0, date: 0, phone: 0, email: 0, address: 0, name: 0, identifier: 0 };
  const ungrounded: AtomicFact[] = [];
  const softUngrounded: AtomicFact[] = [];

  for (const f of facts) {
    checkedFamilies[f.family]++;
    let grounded: boolean;
    switch (f.family) {
      case 'currency':
        grounded = currencySet.has(f.norm);
        break;
      case 'date':
        grounded = f.norm.length === 10 ? isos.has(f.norm) : mds.has(f.norm);
        break;
      case 'phone':
        grounded = phoneSet.has(f.norm);
        break;
      case 'email':
        grounded = corpusLower.includes(f.norm);
        break;
      case 'address':
        grounded = corpusLower.replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').includes(f.norm)
          || softLower.replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').includes(f.norm);
        break;
      case 'identifier': {
        // Grounded if the exact id token appears (word-bounded) in corpus or the request/hints.
        const idRe = new RegExp(`\\b${f.norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        grounded = idRe.test(corpus) || idRe.test(softGround);
        break;
      }
      case 'name': {
        // Grounded if ANY token of the name appears as a word in corpus OR request/hints. Multi-token
        // "names" are often really company names ("Bright Lending") — requiring the LAST token only
        // falsely suppressed those; any-token keeps a fully-fabricated name (no token anywhere)
        // flagged while letting partially-stated real names/companies through.
        const tokens = f.norm.split(/\s+/).filter(t => t.length > 2);
        grounded = tokens.some(t => {
          const wordRe = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRe.test(corpusLower) || wordRe.test(softLower);
        });
        break;
      }
      default:
        grounded = true;
    }
    if (grounded) continue;

    const enforced = mode !== 'off' && (HARD_FAMILIES.includes(f.family) || (mode === 'all' && f.family === 'name'));
    (enforced ? ungrounded : softUngrounded).push(f);
  }

  return { ok: ungrounded.length === 0, ungrounded, softUngrounded, checkedFamilies };
}

// ── Layer 2: bounded LLM rescue for Layer-1 false positives ──────────────────

/**
 * Head + tail window of the corpus for the bounded Layer-2 rescue call. A fact grounded near the
 * END of a long multi-step run (a late tool read / web-search result) is invisible to a head-only
 * slice, which silently turns a real fact into a false suppression. 12k head + 8k tail keeps the
 * call bounded while covering both ends; short corpora pass through whole.
 */
export function corpusWindow(corpus: string): string {
  return corpus.length > 20_000 ? `${corpus.slice(0, 12_000)}\n…\n${corpus.slice(-8_000)}` : corpus;
}

async function rescueWithClassify(ungrounded: AtomicFact[], corpus: string): Promise<Set<string>> {
  // Returns the norms Layer 2 judges as actually supported (to remove from the ungrounded set).
  if (!ungrounded.length) return new Set();
  const list = ungrounded.map((f, i) => `${i}. [${f.family}] ${f.raw}`).join('\n');
  const system = 'You verify whether specific facts are supported by SOURCE text. A fact is SUPPORTED if the SOURCE states it, even paraphrased or in a different format (e.g. "$489k" vs "489,000", "July 21 2026" vs "2026-07-21", "in 6 days" vs an explicit date the source implies). Reply with ONLY a JSON array of the numbers of facts that ARE supported. If none, reply [].';
  const user = `SOURCE:\n${corpusWindow(corpus)}\n\nFACTS:\n${list}\n\nWhich are supported by the SOURCE? JSON array of numbers only.`;
  try {
    const res = await callLLM({ role: 'classify', system, maxTokens: 100, messages: [{ role: 'user', content: user }] });
    const m = (res.text || '').match(/\[[\d,\s]*\]/);
    if (!m) return new Set();
    const idxs = JSON.parse(m[0]) as number[];
    const supported = new Set<string>();
    for (const i of idxs) if (ungrounded[i]) supported.add(ungrounded[i].norm);
    return supported;
  } catch (err) {
    // Fail toward suppression: keep Layer 1's stricter verdict (the user chose zero-fabrication).
    console.warn('[fidelity] Layer 2 classify failed; keeping Layer 1 verdict', err);
    return new Set();
  }
}

export interface GroundResult {
  summary: string;       // possibly NO RESULT:-prefixed
  downgraded: boolean;
  report: GroundingReport;
}

/** The ANSWER section of an Ops summary — everything before the first SOURCE:/FLAGS: line.
 *  Hard grounding gates only what the Composer is asked to relay; SOURCE/FLAGS are Ops's own
 *  citation metadata (stripped on the send path by stripOpsScaffolding), and a citation date the
 *  corpus states in another format must not veto a fully grounded answer. */
function answerSection(summary: string): string {
  const head = summary.split(/^\s*(?:SOURCE|FLAGS)\s*:/im)[0];
  return head.trim().length >= 3 ? head : summary;
}

/**
 * Verify the summary against the tool corpus and, if an enforced fact is ungrounded, downgrade the
 * whole answer to a NO RESULT: (classifyResult in the orchestrator routes that to the honest miss
 * beat, so nothing fabricated ships). Already-empty / already-NO RESULT summaries pass through.
 *
 * @param enforce  false for web-search-enabled kinds (their facts come from server-side web results
 *                 not captured in the corpus) — compute + log only, never suppress.
 */
export async function groundOrDowngrade(
  summary: string,
  corpus: string,
  softGround: string,
  opts: { enforce: boolean; useLayer2?: boolean; label?: string },
): Promise<GroundResult> {
  const trimmed = (summary ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length < 3 || lower.startsWith('no result') || lower.startsWith('answer: no result')) {
    return { summary, downgraded: false, report: { ok: true, ungrounded: [], softUngrounded: [], checkedFamilies: { currency: 0, date: 0, phone: 0, email: 0, address: 0, name: 0, identifier: 0 } } };
  }

  // Enforce on the ANSWER section only; SOURCE/FLAGS facts are checked but can never suppress.
  const answer = answerSection(trimmed);
  const report = checkGrounding(answer, corpus, softGround);
  if (answer !== trimmed) {
    const meta = checkGrounding(trimmed.slice(answer.length), corpus, softGround);
    const metaMisses = [...meta.ungrounded, ...meta.softUngrounded];
    if (metaMisses.length) {
      console.warn(`[fidelity]${opts.label ? ` ${opts.label}` : ''} citation-ungrounded (SOURCE/FLAGS, logged only): ${metaMisses.map(f => `${f.family}:${f.raw}`).join(', ')}`);
    }
  }

  // Log soft (non-enforced) misses always — telemetry for tuning the name family especially.
  if (report.softUngrounded.length) {
    console.warn(`[fidelity]${opts.label ? ` ${opts.label}` : ''} soft-ungrounded (logged, not suppressed): ${report.softUngrounded.map(f => `${f.family}:${f.raw}`).join(', ')}`);
  }

  if (!report.ungrounded.length) return { summary, downgraded: false, report };

  // Layer 2 rescue for the enforced misses (paraphrase/relative-date/format Layer 1 couldn't parse).
  let stillUngrounded = report.ungrounded;
  if (opts.useLayer2 !== false && process.env.FIDELITY_LAYER2 !== 'off') {
    const supported = await rescueWithClassify(report.ungrounded, corpus);
    stillUngrounded = report.ungrounded.filter(f => !supported.has(f.norm));
  }

  if (!stillUngrounded.length) return { summary, downgraded: false, report: { ...report, ok: true, ungrounded: [] } };

  console.warn(`[fidelity]${opts.label ? ` ${opts.label}` : ''} SUPPRESSED — ungrounded facts: ${stillUngrounded.map(f => `${f.family}:${f.raw}`).join(', ')}`);
  if (!opts.enforce) {
    // Web-search kind: the corpus can't include server-side results, so don't suppress — just flag.
    return { summary, downgraded: false, report: { ...report, ungrounded: stillUngrounded } };
  }
  const reason = stillUngrounded.map(f => `${f.family} "${f.raw}"`).join(', ');
  return {
    summary: `NO RESULT: an internal check couldn't confirm ${reason} against the sources found, so this answer was withheld rather than risk stating something wrong.`,
    downgraded: true,
    report: { ...report, ungrounded: stillUngrounded },
  };
}
