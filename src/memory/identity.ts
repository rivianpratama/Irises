// The memory-identity resolver: WHOSE memory a turn reads and writes.
//
// 1:1 chats use the sender's phone handle (unchanged). GROUP chats use a per-group
// pseudo-handle — `group:<chatId>` — so every group gets an entirely FRESH default
// identity that its members can tune with the normal tools (set_preference, directives,
// update_memory), and no member's personal 1:1 memory ever loads into, or is written
// from, a group conversation.
//
// The pseudo-handle can never collide with a real Linq handle: real handles are E.164
// phone numbers or email addresses, and ':' appears in neither. It is a MEMORY key only —
// it must never reach a send path, a Gmail/consent flow, or any per-person facility;
// callers gate those on isGroupHandle().

export const GROUP_HANDLE_PREFIX = 'group:';

/** The memory pseudo-handle owning a group chat's shared identity. */
export function groupHandle(chatId: string): string {
  return `${GROUP_HANDLE_PREFIX}${chatId}`;
}

/** True when a memory handle names a group identity rather than a person. */
export function isGroupHandle(handle: string | undefined | null): boolean {
  return typeof handle === 'string' && handle.startsWith(GROUP_HANDLE_PREFIX);
}

/**
 * Resolve the memory identity for a turn. Structural parameter (a subset of ChatContext)
 * so src/memory never imports from src/agents.
 */
export function memoryHandle(
  ctx: { isGroupChat?: boolean; senderHandle?: string } | undefined,
  chatId: string,
): string | undefined {
  if (ctx?.isGroupChat) return groupHandle(chatId);
  return ctx?.senderHandle;
}
