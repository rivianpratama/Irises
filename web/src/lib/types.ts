// Minimal view model for the thin debug client. The server owns all turn
// logic; the client only needs to render a flat thread of bubbles plus any
// reactions the server attaches to them.

export type MessageRole = "user" | "assistant";

export interface ReactionMark {
  type?: string;
  emoji?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  reactions?: ReactionMark[];
}
