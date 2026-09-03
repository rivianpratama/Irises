// The single, shared "what we durably know about the user" block: who they are + how to address
// them + structured preferences + dossier facts + free-form directives. Built once here and injected
// into EVERY user-facing agent (Convo via buildContextBlock, plus Composer / Autonome / Judge /
// Fallfirm), so a preference saved anywhere is honored everywhere — not just by the front line.
//
// Ops and MM are intentionally NOT consumers: they work from the brief Convo distills for them
// (the dossier "lives in Convo" by design), so they never read this block directly.
//
// Everything here is DATA, never INSTRUCTIONS — same charter rule as preferences/dossier: it can
// retune voice/tone/behavior and how we address the user, but never override honesty, fidelity,
// safety, or scope. Directives keep flowing through their existing guarded renderer.
//
// Stage-1 memory revamp: facts/notes/directives now live in memory_medium rows. Callers pass the
// loaded bundle via opts.medium; the legacy prefs-blob reads remain as the soak-window fallback
// (both sources agree while dual-writing) and go away in the cleanup commit.
import { getMemory, type AgentMemory } from '../db/repositories/memory.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { renderDirectiveBlock, renderPreferenceBlock } from './preferences.js';
import { loadMediumBundle, renderKnownFacts, renderNotesBlock, type MediumBundle } from './mediumTerm.js';
import type { UserProfile } from '../db/types.js';

// Defense-in-depth: a dossier must never dictate the assistant's scope. Drop any markdown section
// whose heading is about scope/capabilities/out-of-scope so a legacy/poisoned dossier (written
// before updateDossier was hardened) can't make Irises refuse in-scope work. (Moved here from
// dossier.ts so the shared renderer can reuse it without a circular import; re-exported there.)
const SCOPE_HEADING = /scope|capabilit|out of scope|in scope|what (i|she|irises) can/i;
export function stripScopeSections(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6}|\*\*)\s*(.+?)\s*\**\s*$/);
    const isHeading = /^#{1,6}\s/.test(line) || /^\*\*.+\*\*$/.test(line.trim());
    if (isHeading) skipping = SCOPE_HEADING.test(heading?.[2] ?? line);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// NOTE: confidence_level is deliberately NOT rendered here — it's a per-turn signal that fluctuates
// text to text, so any stored copy is stale on arrival. It travels in-flight on the OpsTask
// (originConfidence → Composer's brief) instead of through memory.

/** Structured facts the user told us about themselves (not operational flags). Plain context. */
function renderStructuredPrefs(prefs: Record<string, unknown>): string {
  const lines: string[] = [];
  if (prefs.comms_style) lines.push(`comms style: ${prefs.comms_style}`);
  return lines.join('\n');
}

/**
 * Identity + the one rule for how to address the user. Always present — the "boss" fallback needs
 * no stored data. Precedence: an explicit `address_as` preference > their known name > "boss".
 * A free-form addressing directive in USER PREFERENCES also wins (it sits below this block).
 */
function renderAddressing(profile: UserProfile | null, prefs: Record<string, unknown>): string {
  const name = profile?.name?.trim() || '';
  const addressAs = typeof prefs.address_as === 'string' ? prefs.address_as.trim() : '';

  const lines: string[] = ['## Who they are and how to address them'];
  lines.push(`Name: ${name || "unknown — you haven't learned it yet"}`);
  const known = renderKnownFacts(profile?.facts ?? []);
  if (known) lines.push(known);
  if (addressAs) lines.push(`They asked to be addressed as: "${addressAs}"`);

  let rule: string;
  if (addressAs) rule = `call them "${addressAs}" — that's how they asked to be addressed, and it overrides everything else`;
  else if (name) rule = `use their name, "${name}"`;
  else rule = `you don't know their name yet, so call them "boss"`;
  lines.push(
    `How to address them: ${rule}. Do it occasionally, the way a real person texting drops a name in — ` +
    `not in every bubble. If a preference below says how they want to be addressed, that wins. ` +
    `In a group chat, address people by name as usual.`,
  );
  return lines.join('\n');
}

/**
 * @deprecated Stage-2 revamp: live injection paths moved to wrappers.ts (renderUserMemory /
 * buildUserMemory — the rigid-wrapped tier renderers). This flat renderer is kept as a
 * transition shim; stripScopeSections (below) remains the canonical export of this module.
 *
 * Pure renderer. Pass includeDirectives:false when the caller appends the directive block
 * itself in a later (recency) position. Pass opts.medium (the loaded memory_medium bundle) to
 * render facts/notes/directives from the tier rows; the legacy prefs blob remains the fallback.
 */
export function renderUserContextBlock(
  memory: AgentMemory | null,
  profile: UserProfile | null,
  opts: { includeDirectives?: boolean; medium?: MediumBundle } = {},
): string {
  const prefs = memory?.prefs ?? {};
  // Fact view: medium rows + legacy prefs, prefs-wins while both are dual-written (the prefs
  // copy is the soak-window authority — a rare failed medium write must not mask a newer
  // value). The Stage-1 cleanup commit flips this to medium-only when the prefs writes stop.
  const factView: Record<string, unknown> = { ...(opts.medium?.facts ?? {}), ...prefs };
  const parts: string[] = [renderAddressing(profile, factView)];

  const structured = renderStructuredPrefs(factView);
  if (structured) parts.push(`## What you know about them\n${structured}`);

  // Facts the user explicitly asked Irises to remember. Rendered verbatim, above the dossier,
  // and never folded into a summary — this ledger is the focused slice of long-term memory.
  const noteTexts = opts.medium?.notes.length
    ? opts.medium.notes
    : (Array.isArray(prefs.important_notes)
        ? (prefs.important_notes as Array<{ note?: unknown }>)
            .filter(n => n && typeof n.note === 'string')
            .map(n => String(n.note))
        : []);
  const notesBlock = renderNotesBlock(noteTexts);
  if (notesBlock) parts.push(notesBlock);

  const dossierBody = memory?.dossierMd ? stripScopeSections(memory.dossierMd) : '';
  if (dossierBody) parts.push(dossierBody);

  if (opts.includeDirectives !== false) {
    const directiveBlock = opts.medium?.directives.length
      ? renderDirectiveBlock(opts.medium.directives)
      : renderPreferenceBlock(prefs);
    if (directiveBlock) parts.push(directiveBlock);
  }
  return parts.join('\n\n');
}

/**
 * @deprecated Stage-2 revamp: use buildUserMemory(agent, handle) from wrappers.ts. Kept as a
 * transition shim only.
 */
export async function buildUserContextBlock(handle: string | undefined): Promise<string> {
  if (!handle) return '';
  try {
    const [memory, profile, medium] = await Promise.all([
      getMemory(handle),
      getUserProfile(handle),
      loadMediumBundle(handle),
    ]);
    return renderUserContextBlock(memory, profile, { medium });
  } catch (err) {
    console.error('[userContext] buildUserContextBlock failed', err);
    return '';
  }
}
