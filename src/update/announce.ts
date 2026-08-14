// The voice of the update system. Every user-facing word goes through Fallfirm (voiceOutcome) or,
// for the mid-conversation weave, through Convo — never a hardcoded string (see fallfirm/floor.ts).
//
// Two moments, two paths:
//   • availability — the checker detects a new remote build → a proactive Fallfirm note to
//     recently-active chats ("you've got an upgrade waiting, run this to apply it"), delivered on
//     the same per-chat mouth the engine-push feature uses (src/webhook/enginePush.ts).
//   • upgrade applied — the operator ran scripts/update.sh and restarted → on boot the receipt is
//     consumed and Fallfirm voices a light "got my upgrades" confirmation.
//
// A live conversation gets the availability note WOVEN in instead of a cold push: claimPendingUpdateNote()
// hands Convo a one-off prompt note for its next reply. Both paths claim through the same
// claimAnnouncement() gate, so a chat is told exactly once per version — weave OR push, never both.

import { voiceOutcome } from '../agents/fallfirm/client.js';
import type { Outcome } from '../agents/fallfirm/floor.js';
import type { SendFollowUp } from '../agents/orchestrator.js';
import { listActiveChats } from '../db/repositories/conversations.js';
import { parseChannelKind, getChannel } from '../channels/registry.js';
import { reportError } from '../diagnostics/errorLog.js';
import { getUpdateStatus } from './checker.js';
import { claimAnnouncement, unclaimAnnouncement } from './state.js';
import { consumeUpdateReceipt, shouldAnnounceReceipt, type UpdateReceipt } from './receipt.js';
import { getVersion } from './version.js';

const DEFAULT_ACTIVE_WINDOW_MS = 48 * 3600_000;
const MAX_ANNOUNCE_CHATS = 20;
const UPGRADE_ANNOUNCE_DELAY_MS = 15_000;
const APPLY_COMMAND = 'bash scripts/update.sh';

function announceEnabled(): boolean {
  return (process.env.UPDATE_ANNOUNCE_ENABLED ?? 'true') !== 'false';
}

function activeWindowMs(): number {
  return Number(process.env.UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS || DEFAULT_ACTIVE_WINDOW_MS);
}

/** Only chats a registered channel can actually reach — an unknown prefix, or an `eng:` chat on a
 *  boot where no engine is configured, is skipped silently (no phantom announces). */
function defaultRoutable(chatId: string): boolean {
  const kind = parseChannelKind(chatId);
  return !!kind && !!getChannel(kind);
}

function availabilityOutcome(shortSha: string): Outcome {
  return {
    kind: 'confirmed',
    summary:
      'a newer version of you is ready for the server you run on — mention it once, casual and brief, like you heard you have an upgrade waiting. nothing changes until your person applies it, so hand them the command and leave it with them.',
    // relayed word-for-word (the consent-URL precedent): the command must land exactly.
    facts: `to apply: run \`${APPLY_COMMAND}\` from the Irises folder, then restart the server (new build ${shortSha})`,
    nextStep: 'they can run it whenever suits — you keep working exactly as you are until then',
  };
}

function upgradedOutcome(receipt: UpdateReceipt, shortSha: string): Outcome {
  // Commit subjects are DEV copy, so they ride `summary` (voiced, never verbatim), NOT `facts`.
  const highlights = receipt.changes.slice(0, 5).join('; ');
  return {
    kind: 'confirmed',
    summary:
      'you just came back from an upgrade your person applied — you are running the new version now. say it once, light and personal (like "got my upgrades, back and good as new"), never a changelog dump. for your own awareness only, paraphrase at most one highlight or none: ' +
      (highlights || '(no notable highlights)'),
    facts: `now on build ${shortSha}`,
  };
}

export interface UpdateAnnouncer {
  /** Fired by the checker on a newly-detected remote build. */
  onUpdateDetected(remoteSha: string): void | Promise<void>;
  /** Called once at boot; voices the "got my upgrades" confirmation if a receipt is waiting. */
  announceUpgradeAppliedIfReceipt(): Promise<void>;
}

export function createUpdateAnnouncer(deps: { sendFollowUp: SendFollowUp; isRoutable?: (chatId: string) => boolean }): UpdateAnnouncer {
  const isRoutable = deps.isRoutable ?? defaultRoutable;

  async function audience(): Promise<string[]> {
    const chats = await listActiveChats(Date.now() - activeWindowMs(), MAX_ANNOUNCE_CHATS);
    return chats.map(c => c.chatId).filter(isRoutable);
  }

  // Thunk-voiced and mouth-locked (via sendFollowUp), so Fallfirm reads the thread AS it will look
  // when the note lands — that is what lets even a cold push read as woven-in. Returns whether the
  // send succeeded so the caller can release its claim on failure.
  async function deliver(chatId: string, makeOutcome: () => Outcome, label: string): Promise<boolean> {
    try {
      await deps.sendFollowUp(chatId, () => voiceOutcome(makeOutcome(), chatId, ''), {});
      return true;
    } catch (err) {
      reportError({ source: 'process', category: 'update_announce', severity: 'warn', err, chatId, message: `update ${label} announce failed`, trace: false });
      return false;
    }
  }

  async function onUpdateDetected(remoteSha: string): Promise<void> {
    if (!announceEnabled()) return;
    const short = remoteSha.slice(0, 7);
    for (const chatId of await audience()) {
      // Claim gate: at-most-once, and shared with the weave path so a chat mid-conversation gets the
      // woven note instead of this cold push (whichever fires first wins). Claim BEFORE sending so the
      // weave can't double-fire during the await; on a delivery failure, release the claim so the note
      // can still recover on the chat's next turn (the checker won't re-fire for the same sha).
      if (!claimAnnouncement(remoteSha, chatId)) continue;
      const ok = await deliver(chatId, () => availabilityOutcome(short), 'availability');
      if (!ok) unclaimAnnouncement(remoteSha, chatId);
    }
  }

  async function announceUpgradeAppliedIfReceipt(): Promise<void> {
    const receipt = consumeUpdateReceipt();
    if (!receipt) return;
    const running = getVersion().sha;
    if (!shouldAnnounceReceipt(receipt, running)) {
      reportError({
        source: 'process',
        category: 'update_receipt',
        severity: 'warn',
        message: `update receipt targets ${receipt.newSha.slice(0, 7)} but running build is ${running?.slice(0, 7) ?? 'unknown'} — upgrade may not have taken; skipping the confirmation`,
        trace: false,
      });
      return;
    }
    if (!announceEnabled()) return;
    const short = (running ?? receipt.newSha).slice(0, 7);
    // Let the server settle (and update.sh's own health poll finish) before spending LLM calls.
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, UPGRADE_ANNOUNCE_DELAY_MS);
      (t as { unref?: () => void }).unref?.();
    });
    // The consume-rename above is the once-guard across boots, so this sweep needs no per-chat claim;
    // it visits each active chat once.
    for (const chatId of await audience()) {
      await deliver(chatId, () => upgradedOutcome(receipt, short), 'upgraded');
    }
  }

  return { onUpdateDetected, announceUpgradeAppliedIfReceipt };
}

/** Test seam: the outcome builders (kept private to the module otherwise). */
export const _internal = { availabilityOutcome, upgradedOutcome };

/**
 * The weave seam Convo calls on every turn. Returns a one-off prompt note (system-authored guidance,
 * NOT user copy — Convo writes the actual words) exactly once per chat per version when an update is
 * pending, else null. Claiming here is what suppresses the cold push for this chat.
 */
export function claimPendingUpdateNote(chatId: string): string | null {
  if (!announceEnabled()) return null;
  const status = getUpdateStatus();
  if (!status.updateAvailable || !status.remoteSha) return null;
  if (!defaultRoutable(chatId)) return null;
  if (!claimAnnouncement(status.remoteSha, chatId)) return null;
  const short = status.remoteSha.slice(0, 7);
  return `## Passing note — you have an upgrade waiting\nA new version of you (build ${short}) is ready for the server you run on. Somewhere natural in THIS reply, mention it once — your own words, one short bubble at most: you've got an upgrade ready, and they can apply it by running \`${APPLY_COMMAND}\` in your install folder and then restarting you (relay that command exactly, in backticks). Never frame it as a system announcement or read it like a changelog. If this exact moment is the wrong time — they're mid-crisis or asking something urgent — skip it; this note won't come back.`;
}
