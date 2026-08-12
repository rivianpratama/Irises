// The user's own messages that landed AFTER the holding line (i.e. while Ops was running), so the
// composer's late reply can nod to them. holdingAt and m.at are produced by the same backend's
// addMessage, so the comparison stays on a SINGLE clock (never app-clock vs DB-clock). A message
// with no timestamp is treated as before the boundary (excluded), so we never mis-attribute it.
export function selectInterveningUserMessages(
  history: { role: string; content: string; at?: number }[],
  holdingAt: number | undefined,
): string[] {
  if (holdingAt == null) return [];
  return history
    .filter(m => m.role === 'user' && (m.at ?? 0) > holdingAt)
    .map(m => m.content.trim())
    .filter(Boolean);
}
