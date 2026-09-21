// A hard deadline for one background agent run. Without it, a hung tool HTTP call or a slow
// multi-step loop leaves the user's holding text dangling forever. Used by the orchestrator
// (runOpsAndFollowUp and its retry leg) — a standalone module so the
// orchestrator and agent clients don't import each other (which would be a cycle).

/** Thrown by withDeadline on timeout (as opposed to a real error from the work). Callers use
 *  `instanceof` to convert a timeout into a triageable result while re-throwing genuine failures. */
export class DeadlineError extends Error {}

/** Max delay for a 32-bit signed integer in Node.js setTimeout (2^31 - 1, ~24.85 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Reject after `ms` if `work` hasn't settled. The abandoned work keeps running harmlessly in the
 *  background (an LLM loop can't be cancelled mid-flight); its late result is simply discarded.
 *  Safely handles long multi-day durations without triggering Node's 32-bit signed int overflow. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const start = Date.now();

    const schedule = () => {
      const remaining = ms - (Date.now() - start);
      if (remaining <= 0) {
        reject(new DeadlineError(`${label} exceeded ${ms}ms deadline`));
        return;
      }
      const delay = Math.min(remaining, MAX_TIMEOUT_MS);
      timer = setTimeout(() => {
        if (delay < remaining) {
          schedule();
        } else {
          reject(new DeadlineError(`${label} exceeded ${ms}ms deadline`));
        }
      }, delay);
      (timer as { unref?: () => void }).unref?.();
    };

    schedule();

    work.then(
      v => {
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      e => {
        if (timer) clearTimeout(timer);
        reject(e);
      },
    );
  });
}
