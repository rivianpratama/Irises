// The operator's own capability declaration, shared by both adapters (HERMES_CAPABILITIES /
// OPENCLAW_CAPABILITIES). One parser, one closed vocabulary, one canonical order — the two adapters
// used to carry byte-identical copies of this, which is exactly how a seventh CapabilityClass ends up
// honoured on one engine and dropped on the other.
import { CAP_ORDER } from './engineBackend.js';
import type { CapabilitySummary } from './engineBackend.js';

/**
 * A comma-separated operator declaration → the closed vocabulary. Filtered to known classes (anything
 * else is dropped — raw tokens NEVER reach a prompt), deduped, and rendered in canonical order.
 *
 * null when unset/empty/nothing recognized, which reads downstream as "unknown" rather than "nothing"
 * — an empty set can't be told apart from an undeclared one. A declaration that IS recognized is
 * complete by construction: the operator stated the whole set, so a missing class is a real absence.
 */
export function parseDeclaredCapabilities(raw: string | undefined): CapabilitySummary | null {
  const declared = new Set((raw ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
  const classes = CAP_ORDER.filter(c => declared.has(c));
  return classes.length ? { classes } : null;
}
