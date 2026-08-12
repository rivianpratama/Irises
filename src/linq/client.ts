// Linq Blue V3 API Client
// Ref: https://apidocs.linqapp.com/models
import { reportError } from '../diagnostics/errorLog.js';

const BASE_URL = process.env.LINQ_API_BASE_URL || 'https://api.linqapp.com/api/partner/v3';
const API_TOKEN = process.env.LINQ_API_TOKEN;
// Outbound POSTs get AbortSignal timeouts: sendMessage/sendReaction run inside the per-chat send
// lock, so a single hung socket used to wedge that chat's queue forever. NOTE: a timed-out send is
// NOT retried — the POST isn't idempotent, and a duplicate visible bubble is worse than an errored
// turn (the rejection-safe sendQueue keeps the chat usable).
const SEND_TIMEOUT_MS = Number(process.env.LINQ_SEND_TIMEOUT_MS || 15000);
const TYPING_TIMEOUT_MS = 5000;    // typing pings are cosmetic + fire-and-forget; fail fast, never accumulate hung sockets
const REACTION_TIMEOUT_MS = 10000;

// Truncate error messages (especially HTML error pages)
function truncateError(text: string, maxLen = 100): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Linq backend issue]';
  }
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

/**
 * Report-then-build for every non-2xx on a throwing call. Linq is the ONE channel Irises has: a
 * failed send/reaction/rename is invisible to the user (the bubble simply never appears) and
 * invisible to us once the console line scrolls, so each one gets a durable row keyed on
 * method+endpoint — a per-endpoint 401/403/429 pattern is the shape worth catching. Returns the
 * error rather than throwing it so the call sites keep their explicit `throw`.
 * `endpoint` is the ROUTE, not the URL: ids stay out of the fingerprint (and out of the message).
 * The typing indicators deliberately don't come through here — cosmetic, and they swallow their own.
 */
function apiError(method: string, endpoint: string, status: number, errorText: string, scope?: { chatId?: string; messageId?: string }): Error {
  const body = truncateError(errorText);
  console.error(`[linq] API error ${status}: ${body}`);
  reportError({
    source: 'linq',
    category: 'send_failure',
    message: `${method} ${endpoint} failed: ${status}`,
    chatId: scope?.chatId,
    detail: { status, endpoint, method, body, ...(scope?.messageId ? { messageId: scope.messageId } : {}) },
  });
  return new Error(`Linq API error: ${status} ${body}`);
}

// Chat info cache
const chatInfoCache = new Map<string, ChatInfo>();

export interface ChatHandle {
  handle: string;
  service: string;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  service: string;
}

export async function getChat(chatId: string): Promise<ChatInfo> {
  // Check cache first
  const cached = chatInfoCache.get(chatId);
  if (cached) {
    return cached;
  }

  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Fetching chat info for ${chatId}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw apiError('GET', '/chats/{id}', response.status, await response.text(), { chatId });
  }

  const data = await response.json() as ChatInfo;

  // Cache it
  chatInfoCache.set(chatId, data);
  console.log(`[linq] Chat info cached: ${data.handles.length} participants, is_group=${data.is_group}`);

  return data;
}

// Weak proxy for "do I already have a thread with this number?" — Linq Blue has
// no person/network lookup. Returns the matching chat or null. Degrades to null
// (never throws) on error or unknown pagination shape.
export async function findChatByHandle(handle: string): Promise<ChatInfo | null> {
  if (!API_TOKEN) return null;
  try {
    const response = await fetch(`${BASE_URL}/chats`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_TOKEN}` },
    });
    if (!response.ok) return null;
    const data = await response.json() as { chats?: ChatInfo[] } | ChatInfo[];
    const chats: ChatInfo[] = Array.isArray(data) ? data : (data.chats ?? []);
    const norm = handle.replace(/[^\d+]/g, '');
    return chats.find(c => c.handles?.some(h => h.handle.replace(/[^\d+]/g, '').endsWith(norm.slice(-10)))) ?? null;
  } catch (error) {
    console.error('[linq] findChatByHandle failed (non-fatal):', error);
    return null;
  }
}

export type ScreenEffect = 'confetti' | 'fireworks' | 'lasers' | 'sparkles' | 'celebration' | 'hearts' | 'love' | 'balloons' | 'happy_birthday' | 'echo' | 'spotlight';
export type BubbleEffect = 'slam' | 'loud' | 'gentle' | 'invisible_ink';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };
export type ReplyTo = { message_id: string; part_index?: number };

export interface SendMessageResponse {
  chat_id: string;
  message: {
    id: string;
    parts: Array<{ type: string; value?: string }>;
    sent_at: string;
    delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
    is_read: boolean;
  };
}

export interface MediaAttachment {
  url: string;
}

export async function sendMessage(chatId: string, text: string, effect?: MessageEffect, replyTo?: ReplyTo, media?: MediaAttachment[]): Promise<SendMessageResponse> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/messages`;

  const extras: string[] = [];
  if (effect) extras.push('effect');
  if (replyTo) extras.push('reply');
  if (media?.length) extras.push(`${media.length} image(s)`);
  console.log(`[linq] Sending message to chat ${chatId}${extras.length ? ` with ${extras.join(', ')}` : ''}`);

  // Build message parts: text first, then any media
  const parts: Array<{ type: string; value?: string; url?: string }> = [];

  if (text) {
    parts.push({ type: 'text', value: text });
  }

  if (media) {
    for (const m of media) {
      parts.push({ type: 'media', url: m.url });
    }
  }

  const message: Record<string, unknown> = { parts };

  if (effect) {
    message.effect = effect;
  }

  if (replyTo) {
    message.reply_to = replyTo;
    console.log(`[linq] Replying to message: ${replyTo.message_id.slice(0, 8)}...`);
  }

  const body = { message };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw apiError('POST', '/chats/{id}/messages', response.status, await response.text(), { chatId });
  }

  const data = await response.json() as SendMessageResponse;
  console.log(`[linq] Message sent: ${data.message.id}`);

  return data;
}

export interface FetchedMessage {
  id: string;
  chatId: string;
  isFromMe: boolean;       // true when Irises sent it
  senderHandle?: string;   // the sender's handle (for own-thread group attribution)
  text: string;            // text parts joined; a placeholder when the message is media-only
  replyTo?: ReplyTo;
  sentAtMs: number;        // created_at as epoch ms (0 when unparseable)
}

/**
 * Fetch a single message by its Linq id — the LIVE fallback for tapped-reply resolution once the
 * local index (sent_messages / inbound_messages) has aged out. The message still lives on Linq's
 * servers (a mirror of the phone thread), so a reply tapped on an old bubble can still be recovered.
 * Returns null on ANY failure (no token, 404/other non-200, timeout, unparseable body) — never
 * throws; the caller treats null as "couldn't pull it up". Short timeout: this sits ahead of an LLM call.
 */
export async function getMessage(messageId: string): Promise<FetchedMessage | null> {
  if (!API_TOKEN || !messageId) return null;
  try {
    const response = await fetch(`${BASE_URL}/messages/${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      id?: string; chat_id?: string; is_from_me?: boolean;
      from_handle?: { handle?: string } | null; from?: string;
      parts?: Array<{ type?: string; value?: string }>;
      reply_to?: ReplyTo | null; created_at?: string;
    };
    if (!data?.id || !data.chat_id) return null;
    const text = (data.parts ?? [])
      .filter(p => p.type === 'text' && typeof p.value === 'string')
      .map(p => p.value as string)
      .join('\n')
      .trim();
    const sentAtMs = data.created_at ? Date.parse(data.created_at) : NaN;
    return {
      id: data.id,
      chatId: data.chat_id,
      isFromMe: !!data.is_from_me,
      senderHandle: data.from_handle?.handle ?? data.from ?? undefined,
      text: text || '[a media attachment]',
      replyTo: data.reply_to ?? undefined,
      sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : 0,
    };
  } catch {
    return null; // network error / timeout / bad JSON — degrade to "unresolved"
  }
}

export async function renameGroupChat(chatId: string, displayName: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Renaming chat ${chatId} to "${displayName}"`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: displayName,
    }),
  });

  if (!response.ok) {
    throw apiError('PUT', '/chats/{id} (display_name)', response.status, await response.text(), { chatId });
  }

  console.log(`[linq] Chat renamed to "${displayName}"`);
}

export async function setGroupChatIcon(chatId: string, iconUrl: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Setting chat ${chatId} icon to ${iconUrl.substring(0, 50)}...`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      group_chat_icon: iconUrl,
    }),
  });

  if (!response.ok) {
    throw apiError('PUT', '/chats/{id} (group_chat_icon)', response.status, await response.text(), { chatId });
  }

  console.log(`[linq] Chat icon updated`);
}

export async function removeParticipant(chatId: string, handle: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/participants/${encodeURIComponent(handle)}`;

  console.log(`[linq] Removing participant ${handle} from chat ${chatId}`);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw apiError('DELETE', '/chats/{id}/participants/{handle}', response.status, await response.text(), { chatId });
  }

  // Invalidate cache since participants changed
  chatInfoCache.delete(chatId);
  console.log(`[linq] Participant ${handle} removed from chat`);
}

export async function shareContactCard(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/share_contact_card`;

  console.log(`[linq] Sharing contact card with chat ${chatId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw apiError('POST', '/chats/{id}/share_contact_card', response.status, await response.text(), { chatId });
  }

  console.log(`[linq] Contact card shared`);
}

export async function markAsRead(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/read`;

  console.log(`[linq] Marking chat ${chatId} as read`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw apiError('POST', '/chats/{id}/read', response.status, await response.text(), { chatId });
  }

  console.log(`[linq] Chat marked as read`);
}

// Typing indicators are cosmetic — a failure (e.g. 403 in group chats, where
// the Linq API doesn't support them yet) must never block message handling.
export async function startTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    console.error('[linq] LINQ_API_TOKEN not configured, skipping typing indicator');
    return;
  }

  const url = `${BASE_URL}/chats/${chatId}/typing`;

  console.log(`[linq] Starting typing indicator for chat ${chatId}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      signal: AbortSignal.timeout(TYPING_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[linq] startTyping failed (non-fatal) ${response.status}: ${truncateError(errorText)}`);
      return;
    }

    console.log(`[linq] Typing indicator started`);
  } catch (error) {
    console.error('[linq] startTyping failed (non-fatal):', error);
  }
}

export async function stopTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    console.error('[linq] LINQ_API_TOKEN not configured, skipping typing indicator');
    return;
  }

  const url = `${BASE_URL}/chats/${chatId}/typing`;

  console.log(`[linq] Stopping typing indicator for chat ${chatId}`);

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      signal: AbortSignal.timeout(TYPING_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[linq] stopTyping failed (non-fatal) ${response.status}: ${truncateError(errorText)}`);
      return;
    }

    console.log(`[linq] Typing indicator stopped`);
  } catch (error) {
    console.error('[linq] stopTyping failed (non-fatal):', error);
  }
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface SendReactionResponse {
  is_me: boolean;
  handle: string;
  type: ReactionType;
}

// GET /v3/attachments/{attachmentId} — a freshly-signed CDN URL for an ephemeral-tier attachment
// (signed URLs last ~15 min; the file itself is purged after ~1 day). Feeds a best-effort re-sign
// retry when the URL the webhook delivered has gone stale, so it NEVER throws: any failure degrades
// to null and the caller reports the loss honestly. DEFENSIVE: the response schema is not confirmed,
// so we accept the common shapes and warn loudly (logging the keys) if none matches.
export async function getFreshAttachmentUrl(attachmentId: string): Promise<string | null> {
  if (!API_TOKEN) return null;                       // no token → skip the retry gracefully
  try {
    const response = await fetch(`${BASE_URL}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_TOKEN}` },
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[linq] getFreshAttachmentUrl ${response.status}: ${truncateError(errorText)}`);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    // {url} | {attachment:{url}} | {data:{url}} | {media_url} | {signed_url}
    const nested = (v: unknown): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>).url : undefined);
    const candidates = [data.url, nested(data.attachment), nested(data.data), data.media_url, data.signed_url];
    const url = candidates.find(u => typeof u === 'string' && /^https?:\/\//.test(u)) as string | undefined;
    if (!url) console.warn(`[linq] getFreshAttachmentUrl: unrecognized response shape (keys: ${Object.keys(data).join(',')})`);
    return url ?? null;
  } catch (err) {
    console.warn('[linq] getFreshAttachmentUrl failed (non-fatal):', err);
    return null;
  }
}

export async function sendReaction(
  messageId: string,
  reaction: Reaction,
  operation: 'add' | 'remove' = 'add'
): Promise<SendReactionResponse> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/messages/${messageId}/reactions`;

  const isCustom = reaction.type === 'custom';
  const displayName = isCustom ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
  console.log(`[linq] Sending ${displayName} reaction to message ${messageId}`);

  const body: Record<string, string> = {
    operation,
    type: reaction.type,
  };

  if (isCustom) {
    body.custom_emoji = (reaction as { type: 'custom'; emoji: string }).emoji;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REACTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw apiError('POST', '/messages/{id}/reactions', response.status, await response.text(), { messageId });
  }

  const data = await response.json() as SendReactionResponse;
  console.log(`[linq] Reaction sent: ${displayName}`);

  return data;
}
