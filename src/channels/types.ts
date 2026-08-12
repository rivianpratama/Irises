// Channel abstraction — the seam that lets Irises's one brain speak over multiple transports.
//
// The whole outbound path in src/index.ts (live replies, the mouth's async Ops follow-ups, the
// Autonome sweeper) is keyed by chatId and was hard-wired to the Linq (iMessage) client. This
// interface generalizes that surface so the same pipeline can also voice to the web debug channel
// (SSE) and Telegram. The concrete transport is resolved per-chat from the chatId prefix — see
// registry.ts (`web:*` → web, `tg:*` → telegram, bare → linq). The brain never imports a channel
// directly; it only ever calls resolveChannel(chatId).
import type { ChatInfo, FetchedMessage, MediaAttachment, Reaction, SendMessageResponse } from '../linq/client.js';
import type { MessageEffect, ReplyTo } from '../webhook/types.js';

export type { MediaAttachment, Reaction, ChatInfo, FetchedMessage };

export type ChannelKind = 'linq' | 'web' | 'telegram';

// What a given transport can do. Optional Channel methods are called only when the matching cap is
// true, so a channel that can't (say) render iMessage effects or do group ops simply advertises false
// and the send path skips that decoration instead of throwing.
export interface ChannelCaps {
  effects: boolean;      // iMessage screen/bubble effects
  threading: boolean;    // native reply-to quoting
  reactions: boolean;    // tapback / message reactions
  groupOps: boolean;     // rename / icon / remove participant
  contactCard: boolean;  // shareContactCard
}

export interface Channel {
  readonly kind: ChannelKind;
  readonly caps: ChannelCaps;

  // Core outbound — keyed by chatId. Returns a shape mirroring Linq's SendMessageResponse so the
  // send path can keep reading `sent?.message?.id` for recordSentBubble() across every channel.
  sendMessage(
    chatId: string,
    text: string,
    effect?: MessageEffect,
    replyTo?: ReplyTo,
    media?: MediaAttachment[],
  ): Promise<Partial<SendMessageResponse>>;

  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  markAsRead(chatId: string): Promise<void>;
  getChat(chatId: string): Promise<ChatInfo>;

  // NOTE: chatId added vs. Linq's messageId-only signature, so resolveChannel(chatId) works and each
  // channel can target the right conversation.
  sendReaction(
    chatId: string,
    messageId: string,
    reaction: Reaction,
    operation?: 'add' | 'remove',
  ): Promise<void>;

  // Optional live single-message fetch by transport message id — the fallback for thread-aware
  // tapped-reply resolution (state/replyResolution.ts) once the local sent/inbound index has aged
  // out. Only meaningful on a channel with `caps.threading` (a transport with no native reply-to
  // never produces a tapped reply to resolve), and only on one whose API can serve a message by id:
  // linq implements it, web/telegram don't. Absent → resolution degrades to an honest 'unresolved'.
  // Must never throw — return null for "couldn't pull it up".
  getMessage?(chatId: string, messageId: string): Promise<FetchedMessage | null>;

  // Optional — invoked only when the matching cap is true.
  shareContactCard?(chatId: string): Promise<void>;
  renameGroupChat?(chatId: string, displayName: string): Promise<void>;
  setGroupChatIcon?(chatId: string, iconUrl: string): Promise<void>;
  removeParticipant?(chatId: string, handle: string): Promise<void>;
}
