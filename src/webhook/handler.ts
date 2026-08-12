import { Request, Response } from 'express';
import {
  WebhookEvent,
  isMessageReceivedEvent,
  isTypingIndicatorStartedEvent,
  isTypingIndicatorStoppedEvent,
  extractTextContent,
  extractImageUrls,
  extractAudioUrls,
  extractVideoUrls,
  extractDocUrls,
  hasMedia,
  IncomingMedia,
  MessageEffect,
  ReplyTo,
} from './types.js';

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface MessageHandler {
  (chatId: string, from: string, text: string, messageId: string, media: IncomingMedia, incomingEffect?: MessageEffect, incomingReplyTo?: ReplyTo, service?: MessageService): Promise<void>;
}

export type TypingHandler = (chatId: string) => Promise<void>;

// Drop duplicate webhook deliveries (Linq may retry). Bounded FIFO of seen ids.
const seenEvents = new Set<string>();
const seenOrder: string[] = [];
const SEEN_CAP = 2000;
function alreadySeen(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.add(eventId);
  seenOrder.push(eventId);
  if (seenOrder.length > SEEN_CAP) {
    const old = seenOrder.shift();
    if (old) seenEvents.delete(old);
  }
  return false;
}

export function createWebhookHandler(onMessage: MessageHandler, onTypingStarted?: TypingHandler, onTypingStopped?: TypingHandler) {
  // Bot numbers this agent runs on (comma-separated, supports multiple)
  // If not set, responds to messages to any number
  const botNumbers = process.env.LINQ_AGENT_BOT_NUMBERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  // Sender numbers to ignore (comma-separated)
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  // If set, ONLY respond to these sender numbers (for local dev)
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

  return async (req: Request, res: Response) => {
    const event = req.body as WebhookEvent;

    const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    console.log(`[webhook] ${pstTime} PST | ${event.event_type} (${event.event_id})`);

    // Acknowledge receipt immediately
    res.status(200).json({ received: true });

    // Drop duplicate deliveries (idempotency on event_id).
    if (alreadySeen(event.event_id)) {
      console.log(`[webhook] Skipping duplicate event ${event.event_id}`);
      return;
    }

    // Process chat.typing_indicator.started events
    if (isTypingIndicatorStartedEvent(event) && onTypingStarted) {
      const payload = event.data as any;
      const chat_id = payload?.chat_id || payload?.chat?.id;
      
      console.log(`[webhook] typing started payload:`, JSON.stringify(payload));
      
      if (chat_id) {
        try {
          await onTypingStarted(chat_id);
        } catch (error) {
          console.error(`[webhook] Error handling typing started:`, error);
        }
      }
      return;
    }

    // Process chat.typing_indicator.stopped events
    if (isTypingIndicatorStoppedEvent(event) && onTypingStopped) {
      const payload = event.data as any;
      const chat_id = payload?.chat_id || payload?.chat?.id;
      
      console.log(`[webhook] typing stopped payload:`, JSON.stringify(payload));
      
      if (chat_id) {
        try {
          await onTypingStopped(chat_id);
        } catch (error) {
          console.error(`[webhook] Error handling typing stopped:`, error);
        }
      }
      return;
    }

    // Process message.received events
    if (isMessageReceivedEvent(event)) {
      // Debug: log full webhook payload (only in development)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
      }

      // Safely extract properties from the actual Linq V3 payload structure
      const payload = event.data as any;
      const chat_id = payload?.chat?.id;
      const recipient_phone = payload?.chat?.owner_handle?.handle;
      const from = payload?.sender_handle?.handle;
      const is_from_me = payload?.sender_handle?.is_me;
      const message_id = payload?.id;
      const parts = payload?.parts || [];
      const service = payload?.service;
      const incomingEffect = payload?.effect;
      const incomingReplyTo = payload?.reply_to;

      if (!chat_id || !from) {
        console.log(`[webhook] Missing critical fields (chat_id or from). Payload format mismatch.`);
        return;
      }

      // Only process messages sent to this bot's phone numbers
      if (botNumbers.length > 0 && !botNumbers.includes(recipient_phone)) {
        console.log(`[webhook] Skipping message to ${recipient_phone} (not this bot's number)`);
        return;
      }

      // Skip messages from ourselves
      if (is_from_me) {
        console.log(`[webhook] Skipping own message`);
        return;
      }

      // If ALLOWED_SENDERS is set, only respond to those numbers
      if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
        console.log(`[webhook] Skipping ${from} (not in allowed senders)`);
        return;
      }

      // Skip messages from ignored senders
      if (ignoredSenders.includes(from)) {
        console.log(`[webhook] Skipping ${from} (ignored sender)`);
        return;
      }

      const text = extractTextContent(parts);
      const media: IncomingMedia = {
        images: extractImageUrls(parts),
        audio: extractAudioUrls(parts),
        video: extractVideoUrls(parts),
        docs: extractDocUrls(parts),
      };

      if (!text.trim() && !hasMedia(media)) {
        console.log(`[webhook] Skipping empty message`);
        return;
      }

      const effectInfo = incomingEffect ? ` [effect: ${incomingEffect.type}/${incomingEffect.name}]` : '';
      const replyInfo = incomingReplyTo ? ` [reply to: ${incomingReplyTo.message_id.slice(0, 8)}...]` : '';
      const mediaInfo = [
        media.images.length > 0 ? `${media.images.length} image(s)` : '',
        media.audio.length > 0 ? `${media.audio.length} audio` : '',
        media.video.length > 0 ? `${media.video.length} video` : '',
        media.docs.length > 0 ? `${media.docs.length} doc(s)` : '',
      ].filter(Boolean).join(', ');
      console.log(`[webhook] Message from ${from}: "${text.substring(0, 50)}..."${mediaInfo ? ` [${mediaInfo}]` : ''}${effectInfo}${replyInfo}`);

      try {
        await onMessage(chat_id, from, text, message_id, media, incomingEffect, incomingReplyTo, service);
      } catch (error) {
        console.error(`[webhook] Error handling message:`, error);
      }
    }
  };
}
