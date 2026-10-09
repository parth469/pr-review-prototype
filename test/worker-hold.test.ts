import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { Publisher, PublishOptions, PublishResult } from "../src/publisher.ts";
import type { ReviewRun, RunReview } from "../src/reviewer.ts";
import { setHoldMinutes } from "../src/runtime.ts";
import { openState, type State } from "../src/state.ts";
import { createWorker, type WorkerEvent } from "../src/worker.ts";
import type { Workspace } from "../src/workspace.ts";
import { makePr, silentLog } from "./helpers.ts";

const pr = makePr();
const t0 = new Date("2026-10-09T10:00:00Z");
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

function fakeWorkspace(root: string): Workspace {
  return {
    async prepare() {
      return { dir: join(root, "work"), slug: "acme-api-128-3f9c2e1", pr, diff: "diff", files: [] };
    },
    async cleanup() {},
  };
}

const review: RunReview = async () => ({
  review: {
    summary: "Two bugs and a nit.",
    verdict: "request_changes" as const,
    findings: [
      { path: "src/a.ts", line: 1, severity: "bug" as const, body: "Null deref." },
      { path: "src/b.ts", line: 2, severity: "bug" as const, body: "Off by one." },
      { path: "src/c.ts", line: 3, severity: "nit" as const, body: "Rename x." },
    ],
  },
  costUsd: 1,
  durationMs: 1000,
  numTurns: 5,
  sessionId: "s",
});

/** Holds when asked to and the review still has a bug, like the real publisher. */
function holdingPublisher(): Publisher & {
  calls: Array<{ run: ReviewRun; options: PublishOptions }>;
} {
  const p = {
    calls: [] as Array<{ run: ReviewRun; options: PublishOptions }>,
    async publish(_job: unknown, run: ReviewRun, _out: string, options: PublishOptions = {}) {
      p.calls.push({ run, options });
      const blocks = run.review.findings.some((f) => f.severity === "bug");
      if (options.hold && blocks) return { kind: "hold", event: "REQUEST_CHANGES" } as const;
      const state = blocks ? "CHANGES_REQUESTED" : "APPROVED";
      return {
        kind: "posted",
        review: { id: 555, url: "https://r", state },
        draft: {
          event: blocks ? "REQUEST_CHANGES" : "APPROVE",
          body: "b",
          comments: [],
          outside: [],
        },
        inlineDropped: false,
      } satisfies PublishResult;
    },
  };
  return p;
}

describe("worker: hold for your OK", () => {
  let state: State;
  let root: string;
  let clock: Date;
  let events: WorkerEvent[];
  let away: boolean;
  beforeEach(() => {
    state = openState(":memory:");
    root = mkdtempSync(join(tmpdir(), "proxy-hold-"));
    clock = t0;
    events = [];
    away = false;
    state.recordSeen({
      repo: pr.repo,
      pr: pr.number,
      headSha: pr.headSha,
      title: pr.title,
      url: pr.url,
      decision: { action: "queue" },
    });
  });
  afterEach(() => state.close());

  const make = (publisher: Publisher, raw: Record<string, unknown> = {}) =>
    createWorker({
      state,
      workspace: fakeWorkspace(root),
      runReview: review,
      publisher,
      config: parseConfig({ reviewsDir: join(root, "reviews"), ...raw }),
      log: silentLog,
      pluginPath: async (plugin) => `/plugins/${plugin}`,
      onEvent: (e) => void events.push(e),
      wakeWatch: { missedWhileAway: () => away },
      now: () => clock,
    });
  const out = () => join(root, "reviews", "acme-api-128-3f9c2e1");

  it("holds a review that would request changes for the set minutes, and says so", async () => {
    const publisher = holdingPublisher();
    const job = await make(publisher).processOne();
    expect(job).toMatchObject({ status: "held", hold_until: later(30).toISOString() });
    expect(publisher.calls[0]?.options.hold).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: "held",
        until: later(30),
        job: expect.objectContaining({ status: "held" }),
      }),
    ]);
  });

  it("posts at once when the wait is off", async () => {
    setHoldMinutes(state, 0);
    const publisher = holdingPublisher();
    expect(await make(publisher).processOne()).toMatchObject({ status: "done" });
    expect(publisher.calls[0]?.options.hold).toBe(false);
  });

  it("posts as it is when the timer runs out, and says it was after the wait", async () => {
    const publisher = holdingPublisher();
    const worker = make(publisher);
    await worker.processOne();
    clock = later(29);
    expect(await worker.processOne()).toBeUndefined();

    clock = later(30);
    events = [];
    expect(await worker.processOne()).toMatchObject({ status: "done", event: "CHANGES_REQUESTED" });
    expect(publisher.calls[1]?.options.hold).toBe(false);
    expect(events).toEqual([expect.objectContaining({ type: "posted", afterTimer: true })]);
  });

  it("waits again with a fresh timer when it ran out while you were away", async () => {
    const worker = make(holdingPublisher());
    await worker.processOne();
    clock = later(600); // the next morning
    away = true;
    expect(await worker.processOne()).toMatchObject({
      status: "held",
      hold_until: later(630).toISOString(),
      released: null,
    });
    expect(events.map((e) => e.type)).toEqual(["held", "held"]);
  });

  it("posts your choices: dropped findings gone, the event worked out again", async () => {
    const publisher = holdingPublisher();
    const worker = make(publisher);
    const held = await worker.processOne();
    const id = held?.id as number;
    state.setDropped(id, ["F1", "F2"]); // both bugs
    state.release(id);

    expect(await worker.processOne()).toMatchObject({ status: "done", event: "APPROVED" });
    const posted = publisher.calls[1]?.run.review.findings.map((f) => f.id);
    expect(posted).toEqual(["F3"]);
    expect(events.at(-1)).toMatchObject({ type: "posted", afterTimer: false });
    // What was posted is saved; the AI's original is kept next to it.
    const saved = JSON.parse(readFileSync(join(out(), "result.json"), "utf8"));
    expect(saved.review.findings.map((f: { id: string }) => f.id)).toEqual(["F3"]);
    const original = JSON.parse(readFileSync(join(out(), "result.ai.json"), "utf8"));
    expect(original.review.findings).toHaveLength(3);
    expect(readFileSync(join(out(), "review.md"), "utf8")).not.toContain("Null deref");
  });

  it("posts with the drops you made so far when the timer runs out", async () => {
    const publisher = holdingPublisher();
    const worker = make(publisher);
    const held = await worker.processOne();
    state.setDropped(held?.id as number, ["F2"]);
    clock = later(30);
    expect(await worker.processOne()).toMatchObject({ status: "done", event: "CHANGES_REQUESTED" });
    expect(publisher.calls[1]?.run.review.findings.map((f) => f.id)).toEqual(["F1", "F3"]);
  });

  it("never holds a review you started by hand", async () => {
    const publisher = holdingPublisher();
    const job = state.listByStatus("queued")[0];
    const after = await make(publisher).processOne(undefined, job?.id, { force: true });
    expect(after).toMatchObject({ status: "done" });
    expect(publisher.calls[0]?.options.hold).toBe(false);
    expect(existsSync(join(out(), "result.ai.json"))).toBe(false);
  });
});
