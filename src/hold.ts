import type { ReviewRun } from "./reviewer.ts";

/**
 * The review without the findings you dropped while it was held. A follow-up's ledger loses
 * them too, so later rounds never check them: to the author they never existed.
 */
export function dropFindings(run: ReviewRun, ids: readonly string[]): ReviewRun {
  if (ids.length === 0) return run;
  const drop = new Set(ids);
  const keep = (f: { id?: string | undefined }) => !f.id || !drop.has(f.id);
  return {
    ...run,
    review: { ...run.review, findings: run.review.findings.filter(keep) },
    ...(run.followUp
      ? { followUp: { ...run.followUp, ledger: run.followUp.ledger.filter(keep) } }
      : {}),
  };
}

/** The F-ids saved on a job, or none. */
export function parseDropped(value: string | null): string[] {
  if (!value) return [];
  try {
    const ids = JSON.parse(value) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export interface WakeWatch {
  /** True if a timer ending at `until` ran out while the PC slept or the server was off. */
  missedWhileAway(until: string | Date): boolean;
  stop(): void;
}

/** Ticks this often; a gap of more than SLEEP_GAP_MS between ticks means the PC slept. */
const TICK_MS = 30_000;
const SLEEP_GAP_MS = 3 * 60_000;

/**
 * Knows since when the server has been awake without a break. Timers keep counting while
 * the PC sleeps, so a hold that ran out before then was never seen by you in time.
 */
export function createWakeWatch(now: () => number = Date.now, tickMs = TICK_MS): WakeWatch {
  let awakeSince = now();
  let lastTick = awakeSince;
  const timer = setInterval(() => {
    const t = now();
    if (t - lastTick > SLEEP_GAP_MS) awakeSince = t;
    lastTick = t;
  }, tickMs);
  timer.unref();
  return {
    missedWhileAway(until) {
      // A sleep the interval has not noticed yet counts as well.
      const t = now();
      if (t - lastTick > SLEEP_GAP_MS) awakeSince = t;
      lastTick = t;
      return new Date(until).getTime() < awakeSince;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
