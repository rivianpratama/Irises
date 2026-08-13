// A hard deadline for one background agent run. Without it, a hung tool HTTP call or a slow
// multi-step loop leaves the user's holding text dangling forever. Used by the orchestrator
// (runOpsAndFollowUp and its retry leg) — a standalone module so the
// orchestrator and agent clients don't import each other (which would be a cycle).

/** Thrown by withDeadline on timeout (as opposed to a real error from the work). Callers use
 *  `instanceof` to convert a timeout into a triageable result while re-throwing genuine failures. */
export class DeadlineError extends Error {}

/** Reject after `ms` if `work` hasn't settled. The abandoned work keeps running harmlessly in the
 *  background (an LLM loop can't be cancelled mid-flight); its late result is simply discarded. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms deadline`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
