// The install-time memory ask Irises sends the engine ONCE, right after doctrine onboarding
// (firstMove.ts owns the when and the parsing; this file owns the words). The engine has lived
// with this user already — its SOUL.md/USER.md/memory index are ITS OWN files, so the profile
// travels the only sanctioned way: as a chat reply the engine composes itself, never a file read
// (docs/ENGINES.md, "Memory boundary"). Engine-facing, so values only and no texting persona
// (Charter Law 10). The reply is UNTRUSTED input: firstMove.ts sanitizes every field at the door
// and nothing from it reaches a prompt or a memory tier raw.
import { hash8 } from './sessionHash.js';

export const FIRST_MOVE_ASK = `The Irises front-line assistant was just installed in front of you. Before it exchanges a first word with your user, it needs two things only you can know: what you already know about them, and where you actually talk with them. Consult your own memory (SOUL.md, USER.md, MEMORY.md, your memory index, past sessions — whatever you keep) and your connected channels, then reply with ONLY a fenced json block — no prose before or after it:

\`\`\`json
{
  "user_brief": "3-6 plain sentences: who they are, what they do, what their world looks like",
  "name": "their name, or null",
  "fun_details": ["up to 5 short LIGHT items: hobbies, tastes, running jokes, funny preferences, pets, named objects"],
  "primary_channel": {
    "platform": "the channel name exactly as your gateway uses it (imessage, whatsapp, telegram, ...)",
    "chat_id": "the raw id of your main DIRECT 1:1 chat with them, exactly as your channel adapter uses it",
    "has_history": true
  }
}
\`\`\`

Rules:
- fun_details are LIGHT only. Never include health, relationships, work stress, money problems, or private struggles anywhere in fun_details — and keep them out of user_brief too unless they are plainly public facts about their work.
- primary_channel must be a DIRECT chat with the one person who is your user, never a group.
- has_history is true ONLY if you have actually exchanged messages with them in that exact chat before. Knowing their handle from contacts is not history. When unsure, false.
- Unknown field: null. Unknown list: []. Unknown channel: null for the whole primary_channel object. Never invent or guess a value.`;

/** Content hash of the ask — firstMove.ts stores it in first-move.json so an edited ask re-pulls
 *  on the next boot while an unchanged one never asks twice (the engineOnboarding.ts version
 *  discipline, applied to the pull phase only — the send remains one-shot forever). */
export function firstMoveAskVersion(): string {
  return hash8(FIRST_MOVE_ASK);
}
