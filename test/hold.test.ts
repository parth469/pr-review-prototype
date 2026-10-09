import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../src/followup.ts";
import { createWakeWatch, dropFindings, parseDropped } from "../src/hold.ts";
import type { ReviewRun } from "../src/reviewer.ts";

const finding = (id: string) => ({ id, path: "a.ts", line: 1, severity: "bug" as const, body: id });
const ledger = (id: string): LedgerEntry => ({
  ...finding(id),
  sha: "abc",
  round: 2,
  status: "open",
  thread: null,
});
const run = (followUp = false): ReviewRun => ({
  review: { summary: "s", verdict: "request_changes", findings: [finding("F3"), finding("F4")] },
  ...(followUp
    ? {
        followUp: {
          round: 2,
          parentJobId: 1,
          prevSha: "abc",
          linear: true,
          sinceLastLines: 3,
          previous: [],
          ledger: [ledger("F1"), ledger("F3"), ledger("F4")],
        },
      }
    : {}),
  costUsd: 0,
  durationMs: 0,
  numTurns: 0,
  sessionId: "s",
});

describe("dropFindings", () => {
  it("removes the dropped findings from a first review", () => {
    expect(dropFindings(run(), ["F3"]).review.findings.map((f) => f.id)).toEqual(["F4"]);
  });

  it("removes them from a follow-up's ledger too, so later rounds never check them", () => {
    const after = dropFindings(run(true), ["F4"]);
    expect(after.review.findings.map((f) => f.id)).toEqual(["F3"]);
    expect(after.followUp?.ledger.map((e) => e.id)).toEqual(["F1", "F3"]);
  });

  it("leaves the run alone with nothing dropped", () => {
    const r = run();
    expect(dropFindings(r, [])).toBe(r);
  });
});

describe("parseDropped", () => {
  it.each([
    [null, []],
    ['["F1","F2"]', ["F1", "F2"]],
    ["not json", []],
    ['{"F1":1}', []],
  ])("reads %s", (value, ids) => {
    expect(parseDropped(value)).toEqual(ids);
  });
});

describe("createWakeWatch", () => {
  afterEach(() => vi.useRealTimers());

  it("knows a timer that ran out while the PC slept was missed", () => {
    vi.useFakeTimers();
    let t = Date.parse("2026-10-09T10:00:00Z");
    const watch = createWakeWatch(() => t, 30_000);
    const holdUntil = new Date(t + 10 * 60_000);

    // Awake and ticking: the timer runs out in front of you.
    for (let i = 0; i < 40; i++) {
      t += 30_000;
      vi.advanceTimersByTime(30_000);
    }
    expect(watch.missedWhileAway(holdUntil)).toBe(false);

    // Asleep overnight: no ticks, then the PC wakes.
    t += 12 * 60 * 60_000;
    vi.advanceTimersByTime(30_000);
    expect(watch.missedWhileAway(holdUntil)).toBe(true);
    watch.stop();
  });

  it("counts a timer that ran out before the server started as missed", () => {
    const start = Date.parse("2026-10-09T10:00:00Z");
    const watch = createWakeWatch(() => start);
    expect(watch.missedWhileAway(new Date(start - 60_000))).toBe(true);
    expect(watch.missedWhileAway(new Date(start + 60_000))).toBe(false);
    watch.stop();
  });

  it("notices a sleep before the next tick", () => {
    let t = Date.parse("2026-10-09T10:00:00Z");
    const watch = createWakeWatch(() => t, 60 * 60_000);
    const holdUntil = new Date(t + 60_000);
    t += 8 * 60 * 60_000;
    expect(watch.missedWhileAway(holdUntil)).toBe(true);
    watch.stop();
  });
});
