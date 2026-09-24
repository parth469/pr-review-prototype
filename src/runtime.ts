import type { PollSummary } from "./poller.ts";
import type { State } from "./state.ts";

/** Live facts about the running server that are not in the database, for the status page. */
export interface Runtime {
  viewer: string;
  pid: number;
  startedAt: string;
  lastPollAt: string | null;
  lastPoll: PollSummary | null;
  lastPollError: string | null;
}

export function createRuntime(viewer: string): Runtime {
  return {
    viewer,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    lastPoll: null,
    lastPollError: null,
  };
}

const POSTING_PAUSED = "posting_paused";

/** Saved in the database so a pause survives restarts. */
export function isPostingPaused(state: Pick<State, "getSetting">): boolean {
  return state.getSetting(POSTING_PAUSED) === "true";
}

export function setPostingPaused(state: Pick<State, "setSetting">, paused: boolean): void {
  state.setSetting(POSTING_PAUSED, String(paused));
}

export function recordPoll(runtime: Runtime, result: PollSummary | Error): void {
  runtime.lastPollAt = new Date().toISOString();
  if (result instanceof Error) {
    runtime.lastPollError = result.message;
  } else {
    runtime.lastPoll = result;
    runtime.lastPollError = null;
  }
}
