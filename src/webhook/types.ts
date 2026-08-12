// Linq Blue V3 Webhook Types
// Ref: https://apidocs.linqapp.com/webhook-events

export interface WebhookEvent {
  api_version: 'v3';
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
}

export interface MessageReceivedEvent extends WebhookEvent {
  event_type: 'message.received';
  data: MessageReceivedData;
}

export interface MessageReceivedData {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_from_me: boolean;
  service: 'iMessage' | 'SMS' | 'RCS';
  message: IncomingMessage;
}

export interface IncomingMessage {
  id: string;
  parts: MessagePart[];
  effect?: MessageEffect;
  reply_to?: ReplyTo;
}

export interface TextPart {
  type: 'text';
  value: string;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export type MessagePart = TextPart | MediaPart;

export interface MessageEffect {
  type: 'screen' | 'bubble';
  name: string;
}

export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export function isMessageReceivedEvent(event: WebhookEvent): event is MessageReceivedEvent {
  return event.event_type === 'message.received';
}

export interface TypingIndicatorStartedEvent extends WebhookEvent {
  event_type: 'chat.typing_indicator.started';
  data: {
    chat_id: string;
  };
}

export interface TypingIndicatorStoppedEvent extends WebhookEvent {
  event_type: 'chat.typing_indicator.stopped';
  data: {
    chat_id: string;
  };
}

export function isTypingIndicatorStartedEvent(event: WebhookEvent): event is TypingIndicatorStartedEvent {
  return event.event_type === 'chat.typing_indicator.started';
}

export function isTypingIndicatorStoppedEvent(event: WebhookEvent): event is TypingIndicatorStoppedEvent {
  return event.event_type === 'chat.typing_indicator.stopped';
}

export function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.value)
    .join('\n');
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
  attachmentId?: string;   // Linq attachment id — enables the re-sign retry (GET /v3/attachments/{id})
  filename?: string;       // for honest "couldn't load 'Inspection.pdf'" messaging
}

/** All non-text media on one inbound turn, grouped by kind. Threaded from the webhook to the agents. */
export interface IncomingMedia {
  images: ExtractedMedia[];
  audio: ExtractedMedia[];
  video: ExtractedMedia[];
  docs: ExtractedMedia[];
}

/** A fresh, empty media bag (new arrays each call — safe to pass where none was received). */
export function emptyMedia(): IncomingMedia {
  return { images: [], audio: [], video: [], docs: [] };
}

/** True when a turn carries any non-text content (drives routing + the group-chat classifier skip). */
export function hasMedia(m: IncomingMedia): boolean {
  return m.images.length > 0 || m.audio.length > 0 || m.video.length > 0 || m.docs.length > 0;
}

export function extractImageUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('image/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type!, attachmentId: part.attachment_id, filename: part.filename }));
}

export function extractAudioUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('audio/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type!, attachmentId: part.attachment_id, filename: part.filename }));
}

export function extractVideoUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('video/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type!, attachmentId: part.attachment_id, filename: part.filename }));
}

// Everything with a fetchable URL that ISN'T image/audio/video — PDFs, docs, and other attachments.
// A missing mime defaults to application/octet-stream so nothing with a URL is silently dropped.
// (PDFs are the reliably-readable case; other types are routed but may not be model-readable.)
export function extractDocUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart => {
      if (part.type !== 'media' || !part.url) return false;
      const mime = part.mime_type || '';
      return !mime.startsWith('image/') && !mime.startsWith('audio/') && !mime.startsWith('video/');
    })
    .map(part => ({ url: part.url!, mimeType: part.mime_type || 'application/octet-stream', attachmentId: part.attachment_id, filename: part.filename }));
}
