// The craft modules: the pages of Convo's persona that only some turns need.
//
// Context.md is the always-on core — how the front line works, the laws that rank with the bubble
// rule — with the shared persona block ahead of it saying who is typing (persona/policy.ts, the same
// bytes all four prompt surfaces render). Beside it, under craft/, sit ten pages that teach ONE
// move each: how to pick up a thread of theirs, how to read a thread in send order, how to answer a
// burst, what to do with an attachment, how to get to know somebody new, what an idle turn may
// carry, what to do with something they handed you and asked nothing for.
// Every one of them used to be a section of Context.md, which meant every one of them was in front
// of the model on every turn — the burst tradecraft on a single message, nine thousand characters of
// onboarding craft nine months into a relationship, the send-order read on a turn with no history to
// order. Twenty-four thousand characters of the persona, most of it irrelevant to most turns.
//
// What did NOT move with the threading craft: banter. The tease frame, the four safe bends, the
// deadpan rule and "their response overrules your framing" stay in Context.md on every single turn,
// because a joke is not a thread — she can bend past literal on a turn that carries no thread at
// all, and a play frame she only reads when the thread engine happens to offer something is a play
// frame that goes missing exactly when she is being funny on her own.
//
// Each page now loads on a STRUCTURAL FACT about the turn: a section the assembler already rendered,
// a tool that is really on offer, a file that really arrived, a slot the memory stack really hasn't
// filled. Never a judgement about the turn ("she might need this"), never a model's guess — a gate
// here is a boolean somebody else already computed for a different reason, which is what makes the
// receipt (`turn:trace.prompt.craft`) worth reading and the whole thing testable.
//
// What this module does NOT do: decide, shorten, or reword anything. It renders pages it was told
// to render, in one fixed order, and the corpus those pages add up to is pinned by sha256 in
// personaModules.test.ts — so a page edited by accident, or a registry row that quietly changes what
// reaches the model, fails there rather than in production.

import { loadContext } from '../loadContext.js';
import { renderPersonaBlock } from '../../persona/policy.js';
import { SCHEDULE_AUTOMATION_TOOL } from './tools.js';

/**
 * The turn as the gates read it: facts, already decided elsewhere, that say which craft the turn
 * structurally needs. Nothing here is an opinion, and nothing here is derived from the message's
 * meaning — that is the difference between a gate that can be tested and a gate that has to be
 * trusted.
 *
 * The assembler fills the structural ones from what it is already computing (convo/shared.ts); five
 * ride in from the caller, because they are facts of reads that happened before the prompt was
 * assembled (convo/client.ts: the attachment note it folded into the turn text, the two reads the
 * memory loaders answered — memory/dossier.ts — and the two turn shapes the idle gate returned).
 */
export interface ModuleGateInput {
  /** The thread section rendered this turn: renderThreadForPrompt produced a block, i.e. the thread
   *  engine really put an offer or an outcome ask in front of her (persona/threads.ts). */
  threadSection: boolean;
  /** The reply-order read rendered this turn: renderArrivalGap or renderReplyOrder produced a
   *  section, i.e. there IS a thread whose send order this message has to be placed in. */
  replyOrderSection: boolean;
  /** describeAttachments produced a note this turn — a file, photo or memo really arrived. */
  attachmentNote: boolean;
  /** How many messages arrived in this turn's burst (1 on a normal turn). */
  burstSize: number;
  /** The tools offered to the model THIS turn, by name — the same list the request carries. */
  toolNames: readonly string[];
  /** They tapped reply on a specific earlier message (any of the four resolutions). */
  tappedReply: boolean;
  /** A flagged email is live in the short tier this turn, so a follow-up may be about it. */
  emailFlag: boolean;
  /** Their long-term picture is still thin — an identity slot is open, or the day-to-day picture is
   *  empty, or too few personal facts are banked (memory/wrappers.ts profileIsThin). */
  thinProfile: boolean;
  /** This turn asked for nothing: the idle gate read it as a stall (persona/idle.ts) before the
   *  prompt was built. Structural in the same sense as the rest of this list — three layers of
   *  script-independent reads and at most one tiny classify call, all of it decided elsewhere and
   *  handed here as a boolean. It is the ONE turn shape the hook craft has anything to say about,
   *  and on every other turn that page is nine hundred characters teaching a beat the reply is not
   *  allowed to carry. */
  idleTurn: boolean;
  /** This turn handed her something and asked for nothing: the same idle gate read it as a share
   *  (persona/idle.ts) before the prompt was built. Structural exactly as `idleTurn` is, and
   *  DISJOINT from it — one gate returns one shape, so no turn ever loads both pages, and the two
   *  facts are separate booleans rather than one enum because a gate here reads a boolean somebody
   *  else already computed and the receipt says which fact decided which page. On a task turn the
   *  share page is four thousand characters teaching a move the flat answer forbids; on an idle turn
   *  it is a page about a thing they did not send. */
  shareTurn: boolean;
}

/**
 * The five facts the prompt assembler cannot see for itself, handed in by the caller that already
 * knows them (convo/client.ts). Absent reads as false — which is what every non-Convo caller of the
 * assembler gets, and the honest answer for a lane that never did those reads.
 *
 * This is the ONE route a craft gate's fact may arrive by. A gate read off a RENDERING input instead
 * would tie which pages load to whether some other section is switched on, and a rendering flag that
 * changes the page set is no longer byte-inert.
 */
export interface CraftTurnFacts {
  attachmentNote?: boolean;
  emailFlag?: boolean;
  thinProfile?: boolean;
  idleTurn?: boolean;
  shareTurn?: boolean;
}

/** One page of craft, its file, and the structural fact it loads on. */
interface CraftModule {
  id: string;
  /** Relative to the convo agent folder, so loadContext caches it per file. */
  file: string;
  /** The fact `gate` reads, named for the receipt. Disjoint across the registry: a row on the trace
   *  says which fact decided this page, and `rendered` says which way that fact went. */
  gateName: string;
  gate: (ctx: ModuleGateInput) => boolean;
}

/**
 * The registry, in CANONICAL order — the order these sections stood in inside Context.md, which is
 * also the order they render in and the order the off path concatenates them in. One list, so the id
 * type, the receipt, the render order and the golden all read the same source.
 */
export const CRAFT_MODULES = [
  {
    id: 'threading',
    file: 'craft/threading.md',
    // The thread engine's own output is the fact: the block renders exactly when a theme, a loop or
    // an outcome ask was really selected for this turn (persona/threads.ts renderThreadForPrompt),
    // and it renders '' on the great majority of turns — which are precisely the turns where nine
    // thousand characters of how-to-tag craft had nothing to tag.
    gateName: 'thread_section',
    gate: (ctx: ModuleGateInput) => ctx.threadSection,
  },
  {
    id: 'tapped_reply',
    file: 'craft/tapped-reply.md',
    gateName: 'tapped_reply',
    gate: (ctx: ModuleGateInput) => ctx.tappedReply,
  },
  {
    id: 'send_order',
    file: 'craft/send-order.md',
    // The assembler's own reply-order read is the fact: it renders exactly when there is a stored
    // thread plus an incoming message to place in it, and it is suppressed on a tapped reply — which
    // is precisely when the send-order craft has nothing to do.
    gateName: 'reply_order_section',
    gate: (ctx: ModuleGateInput) => ctx.replyOrderSection,
  },
  {
    id: 'burst_re',
    file: 'craft/burst-re.md',
    // The `re` tag it teaches only exists on a real burst — the assembler numbers the incoming
    // messages under the same condition (convo/shared.ts).
    gateName: 'burst',
    gate: (ctx: ModuleGateInput) => ctx.burstSize > 1,
  },
  {
    id: 'reminders',
    file: 'craft/reminders.md',
    // Follows the TOOL rather than the deployment: the three reminder tools are gated out on the
    // openclaw lane because they throw there (convo/client.ts), so teaching their craft anyway is
    // how a model promises a reminder that can never fire.
    gateName: 'reminder_tool_offered',
    gate: (ctx: ModuleGateInput) => ctx.toolNames.includes(SCHEDULE_AUTOMATION_TOOL.name),
  },
  {
    id: 'email_flag',
    file: 'craft/email-flag.md',
    gateName: 'email_flag_held',
    gate: (ctx: ModuleGateInput) => ctx.emailFlag,
  },
  {
    id: 'onboarding',
    file: 'craft/onboarding.md',
    gateName: 'thin_profile',
    gate: (ctx: ModuleGateInput) => ctx.thinProfile,
  },
  {
    id: 'attachments',
    file: 'craft/attachments.md',
    gateName: 'attachment_note',
    gate: (ctx: ModuleGateInput) => ctx.attachmentNote,
  },
  {
    id: 'hooks',
    file: 'craft/hooks.md',
    // The first of the pages written FOR the prompt rather than moved into it, and appended for that
    // reason — the canonical order above is the order those sections stood in before P4a, and every
    // page with no place in that order goes on the end in the order it was written, which keeps the
    // reading true. The gate is the idle turn itself: the hook craft is instructions for a turn that
    // asked for nothing, and a task turn that read it would be a task turn tempted to add a beat.
    gateName: 'idle_turn',
    gate: (ctx: ModuleGateInput) => ctx.idleTurn,
  },
  {
    id: 'share',
    file: 'craft/share.md',
    // The second page written for the prompt, behind the hook page it is the sibling of: the same
    // gate returns both shapes and returns exactly one, so these two rows can never fire together
    // and the order between them is a reading convention rather than a precedence. The gate is the
    // share turn itself, and the page is unusable off it in both directions — a task turn that read
    // it would answer the ask and then turn toward it as well, and an idle turn has nothing to turn
    // toward, which is why the idle shape stays statement-only and keeps its own page.
    gateName: 'share_turn',
    gate: (ctx: ModuleGateInput) => ctx.shareTurn,
  },
] as const satisfies readonly CraftModule[];

export type CraftModuleId = typeof CRAFT_MODULES[number]['id'];

/** One row of the per-turn receipt: what a page cost this turn, which fact decided it, and which way
 *  that fact went. `chars` is 0 on a page that stayed out — it put nothing in front of the model,
 *  which is the number this receipt is about. */
export interface CraftModuleTrace {
  id: CraftModuleId;
  chars: number;
  gate: string;
  rendered: boolean;
}

/** The craft section, plus the receipt for every page in the registry — the ones that loaded and the
 *  ones that did not, each with the fact it read. `text` is '' when nothing loaded, and then no
 *  section is pushed at all. */
export interface CraftModuleRender {
  text: string;
  modules: CraftModuleTrace[];
}

/** One page's text, as the model gets it (loadContext trims and caches per file; in dev it
 *  hot-reloads on mtime, same as Context.md). */
export function craftModuleText(id: CraftModuleId): string {
  const module = CRAFT_MODULES.find(m => m.id === id);
  if (!module) throw new Error(`[personaModules] no craft module "${id}"`);
  return loadContext('convo', module.file);
}

/**
 * Which craft this turn needs, rendered — and a disjoint-bucket receipt for the rest.
 *
 * PURE: every gate reads a fact off `ctx`, in registry order, and a page that stays out is never
 * read off disk. The joined text is one prompt section (`craft_modules`), pushed right after the
 * tool docs so the pages sit in the stable-within-a-chat slot ahead of the genuinely per-turn data.
 */
export function renderCraftModules(ctx: ModuleGateInput): CraftModuleRender {
  const loaded: string[] = [];
  const modules: CraftModuleTrace[] = [];
  for (const m of CRAFT_MODULES) {
    const rendered = m.gate(ctx);
    const text = rendered ? craftModuleText(m.id) : '';
    if (text) loaded.push(text);
    modules.push({ id: m.id, chars: text.length, gate: m.gateName, rendered });
  }
  return { text: loaded.join('\n\n'), modules };
}

/**
 * The flag. Default ON.
 *
 * OFF puts every page back in the cached prefix instead: `convoPersonaWithCraft()` is what the
 * assembler uses as the persona head, no `craft_modules` section is pushed, and the model reads the
 * same bytes it read before P4a — in the concatenation's canonical order rather than interleaved
 * where each section used to sit, which is this flag's one honest relaxation of byte-identity.
 *
 * Read at call time (never at module load) so a live install can flip it without a restart — the
 * same parse shape as every sibling flag (threadingEnabled in db/repositories/threadInventory.ts).
 */
export function personaModulesEnabled(): boolean {
  const v = (process.env.CONVO_PERSONA_MODULES || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The shared persona block, then Context.md, then every craft page, joined in canonical order: the
 * whole persona corpus, which is the off path's cached prefix and the thing "exactly once" is now
 * measured over (promptPolicy.ts — a rule anchored in a craft page is still a rule the model reads).
 *
 * The block LEADS, and that position is the point. It is the one description of who is typing that
 * all four prompt surfaces share (persona/policy.ts), so on this surface it has to sit where a
 * reader — and the attention pattern — takes it as the frame everything after is read inside: the
 * precedence list first, then identity, then the lane's own Context.md saying how THIS lane works.
 * Put it after Context.md and the personality reads as an addendum to the function file, which is
 * the ordering the whole module exists to undo.
 */
export function convoPersonaWithCraft(): string {
  return [
    renderPersonaBlock('convo'), loadContext('convo'), ...CRAFT_MODULES.map(m => craftModuleText(m.id)),
  ].join('\n\n');
}

/** The persona head the assembler puts in front of `<prompt>`: the shared block plus the core alone
 *  with the flag on (the pages ride inside the block), the whole corpus with it off.
 *
 *  The shared block is on BOTH paths, and it is inside the head on both — it is stable for the life
 *  of the deployment, so it belongs in the first Anthropic cache breakpoint rather than in a dyn
 *  section that would be cache-written on every turn (promptSections.ts promptCacheBreakpoints). */
export function convoPersona(): string {
  return personaModulesEnabled()
    ? `${renderPersonaBlock('convo')}\n\n${loadContext('convo')}`
    : convoPersonaWithCraft();
}
