// Communication drafting. Writes a message/note/letter for the user to send — never sends it.
// Domain-neutral: the draft is shaped by the user's own instructions, plus any optional context
// the caller recalls (a prior email, a snippet of history). No deal/party/contract lookups.
// Tone is ~30% more formal than the chat persona; the draft is one block.
import { callLLM } from '../llm/callLLM.js';

export interface DraftResult {
  status: 'ok' | 'error';
  subject: string;
  body: string;
  contextUsed: string[];
}

export async function draftText(handle: string, args: {
  instructions: string;
  /** Optional grounding the caller already pulled — a recalled email, a chat snippet, notes. */
  context?: string;
  tone?: 'standard' | 'firm' | 'warm';
  // Bills the draft against the delegating task's budget and makes the ledger row attributable
  // (untraced ops-role rows are a forensics blind spot).
  chatId?: string;
  taskId?: string;
}): Promise<DraftResult> {
  const contextUsed: string[] = [];
  const contextBlock = args.context?.trim() ? `\n\nContext you may draw on (do not invent beyond it):\n${args.context.trim().slice(0, 4000)}` : '';
  if (contextBlock) contextUsed.push('recalled context');

  const system = `You are drafting a professional message or note for the user to send.
Tone: professional, about 30% more formal than a casual text — proper capitalization, full sentences, no abbreviations, signature-ready. ${args.tone ? `Lean ${args.tone}.` : ''}
Follow the user's instructions for what to say and to whom. Do not invent facts that aren't in the instructions or the supplied context.
Return the draft as: first line "Subject: <subject>" (a short subject line, or "Subject: (none)" if a subject makes no sense), then a blank line, then the body. Do not add commentary before or after.`;

  try {
    const res = await callLLM({
      role: 'ops',
      system,
      messages: [{ role: 'user', content: `Instructions from the user: ${args.instructions}${contextBlock}` }],
      trace: { handle, chatId: args.chatId, taskId: args.taskId, label: 'ops:draft_text' },
    });
    const text = res.text ?? '';
    const subjMatch = text.match(/^Subject:\s*(.+)$/im);
    const subject = subjMatch ? subjMatch[1].trim() : '(no subject)';
    const body = text.replace(/^Subject:\s*.+$/im, '').trim();
    return { status: 'ok', subject, body, contextUsed };
  } catch (err) {
    console.error('[drafting] failed', err);
    return { status: 'error', subject: '', body: '', contextUsed };
  }
}
