import {
  type Config,
  EFFORTS,
  type Effort,
  MODELS,
  type Model,
  STYLES,
  type Style,
} from "./config.ts";
import type { PollSummary } from "./poller.ts";
import type { State } from "./state.ts";

/** Plan usage of the current 5-hour session window. */
export interface SessionUsage {
  /** Percent used, 0-100. */
  utilization: number;
  resetsAt: Date | null;
}

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

const REVIEW_MODEL = "review_model";
const REVIEW_EFFORT = "review_effort";
const REVIEW_STYLE = "review_style";

const isModel = (v: string | undefined): v is Model => MODELS.includes(v as Model);
const isEffort = (v: string | undefined): v is Effort => EFFORTS.includes(v as Effort);
const isStyle = (v: string | undefined): v is Style => STYLES.includes(v as Style);

/** Review settings for the next review: config, with the status page's picks on top. */
export function reviewSettings(
  state: Pick<State, "getSetting">,
  config: Pick<Config, "review">,
): Config["review"] {
  const model = state.getSetting(REVIEW_MODEL);
  const effort = state.getSetting(REVIEW_EFFORT);
  const style = state.getSetting(REVIEW_STYLE);
  return {
    ...config.review,
    ...(isModel(model) ? { model } : {}),
    ...(isEffort(effort) ? { effort } : {}),
    ...(isStyle(style) ? { style } : {}),
  };
}

/** Saved in the database, so the choice survives restarts. Running reviews keep theirs. */
export function setReviewChoice(
  state: Pick<State, "setSetting">,
  choice: { model?: Model | undefined; effort?: Effort | undefined; style?: Style | undefined },
): void {
  if (choice.model) state.setSetting(REVIEW_MODEL, choice.model);
  if (choice.effort) state.setSetting(REVIEW_EFFORT, choice.effort);
  if (choice.style) state.setSetting(REVIEW_STYLE, choice.style);
}

const HOLD_MIN = "hold_min";

/** Minutes a review that would request changes waits for you: config, or the page's pick. */
export function holdMinutes(
  state: Pick<State, "getSetting">,
  config: Pick<Config, "publish">,
): number {
  const picked = Number(state.getSetting(HOLD_MIN));
  return state.getSetting(HOLD_MIN) !== undefined && Number.isInteger(picked) && picked >= 0
    ? picked
    : config.publish.holdMin;
}

/** Saved in the database. Reviews already waiting keep the timer they started with. */
export function setHoldMinutes(state: Pick<State, "setSetting">, minutes: number): void {
  state.setSetting(HOLD_MIN, String(minutes));
}

const SESSION_USAGE = "session_usage";

/** The latest 5-hour usage Claude reported, saved so a restart still knows it. */
export function recordSessionUsage(state: Pick<State, "setSetting">, usage: SessionUsage): void {
  state.setSetting(SESSION_USAGE, JSON.stringify(usage));
}

/** The last recorded usage, or undefined if none yet or its window has reset since. */
export function currentSessionUsage(
  state: Pick<State, "getSetting">,
  now = new Date(),
): SessionUsage | undefined {
  const raw = state.getSetting(SESSION_USAGE);
  if (!raw) return undefined;
  try {
    const saved = JSON.parse(raw) as { utilization: number; resetsAt: string | null };
    const resetsAt = saved.resetsAt ? new Date(saved.resetsAt) : null;
    if (resetsAt && resetsAt <= now) return undefined;
    return { utilization: saved.utilization, resetsAt };
  } catch {
    return undefined;
  }
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
