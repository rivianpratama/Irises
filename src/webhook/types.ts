// Shared inbound message + media types.
//
// Transport-neutral shapes the pipeline threads from any inbound door (the web/CLI channel, the
// OpenClaw/Hermes bridge) through batching, the agents, and the send path. Not tied to any one
// engine platform.

export interface ReplyTo {
  message_id: string;
  part_index?: number;
  // The quoted message's text, when the bridge/transport forwarded it. INTERNAL-only: the provider
  // APIs reject unknown fields on content blocks, so this never rides the wire to the model as a
  // structured field — it's folded inline by annotateTappedReply. Lets Irises show the model WHAT was
  // replied to even when the local sent/inbound index can't resolve the id to stored content.
  content?: string;
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
  attachmentId?: string;   // opaque per-attachment id, when the inbound source provides one
  filename?: string;       // for honest "couldn't load 'Inspection.pdf'" messaging
}

/** All non-text media on one inbound turn, grouped by kind. Threaded from the inbound door to the agents. */
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
