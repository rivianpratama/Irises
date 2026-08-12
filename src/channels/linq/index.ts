// Linq (iMessage) channel — a thin adapter over the untouched src/linq/client.ts, so all of its
// retry/caching/attachment-resign logic stays exactly where it is. This is the default channel:
// bare chatIds (no `web:`/`tg:` prefix) resolve here.
import * as linq from '../../linq/client.js';
import type { Channel } from '../types.js';

export const linqChannel: Channel = {
  kind: 'linq',
  caps: { effects: true, threading: true, reactions: true, groupOps: true, contactCard: true },

  sendMessage: (chatId, text, effect, replyTo, media) =>
    linq.sendMessage(chatId, text, effect, replyTo, media),
  startTyping: (chatId) => linq.startTyping(chatId),
  stopTyping: (chatId) => linq.stopTyping(chatId),
  markAsRead: (chatId) => linq.markAsRead(chatId),
  getChat: (chatId) => linq.getChat(chatId),
  // Linq keys reactions by messageId only; drop the chatId the interface adds.
  sendReaction: (_chatId, messageId, reaction, operation) =>
    linq.sendReaction(messageId, reaction, operation).then(() => {}),
  // Linq keys a message read by messageId only; the resolver still chat-scopes the result itself.
  getMessage: (_chatId, messageId) => linq.getMessage(messageId),

  shareContactCard: (chatId) => linq.shareContactCard(chatId),
  renameGroupChat: (chatId, displayName) => linq.renameGroupChat(chatId, displayName),
  setGroupChatIcon: (chatId, iconUrl) => linq.setGroupChatIcon(chatId, iconUrl),
  removeParticipant: (chatId, handle) => linq.removeParticipant(chatId, handle),
};
