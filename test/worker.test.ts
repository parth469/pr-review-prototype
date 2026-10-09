import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { Publisher, PublishResult } from "../src/publisher.ts";
import type { RunReview, RunReviewInput } from "../src/reviewer.ts";
import { currentSessionUsage, recordSessionUsage, setReviewChoice } from "../src/runtime.ts";
import { openState, STOPPED_REASON, type State } from "../src/state.ts";
import { createWorker, type WorkerEvent } from "../src/worker.ts";
import { HeadMovedError, type Workspace } from "../src/workspace.ts";
import { makePr, silentLog } from "./helpers.ts";

const pr = makePr();

function fakeWorkspace(root: string, fail?: Error): Workspace & { cleaned: number } {
  const ws = {
    cleaned: 0,
    async prepare() {
      if (fail) throw fail;
      return { dir: join(root, "work"), slug: "acme-api-128-3f9c2e1", pr, diff: "diff", files: [] };
    },
    async cleanup() {
      ws.cleaned++;
    },
  };
  return ws;
}

function fakePublisher(results: Array<PublishResult | Error> = []): Publisher & { calls: number } {
  const p = {
    calls: 0,
    async publish(): Promise<PublishResult> {
      const next = results[p.calls++] ?? {
        kind: "existing" as const,
        review: { id: 1, url: "u", state: "COMMENTED" },
      };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return p;
}

const posted: PublishResult = {
  kind: "posted",
  review: {
    id: 555,
    url: "https://github.com/acme/api/pull/128#pullrequestreview-555",
    state: "CHANGES_REQUESTED",
  },
  draft: { event: "REQUEST_CHANGES", body: "b", comments: [], outside: [] },
  inlineDropped: false,
};

function countingReview(): RunReview & { calls: number } {
  const fn = Object.assign(
    async () => {
      fn.calls++;
      return {
        review: {
          summary: "One real bug.",
          verdict: "request_changes" as const,
          findings: [
            { path: "src/a.ts", line: 3, severity: "nit" as const, body: "Rename x." },
            { path: "src/b.ts", line: 9, severity: "bug" as const, body: "Null deref." },
          ],
        },
        costUsd: 2.1,
        durationMs: 300_000,
        numTurns: 20,
        sessionId: "s",
      };
    },
    { calls: 0 },
  );
  return fn;
}

describe("worker", () => {
  let state: State;
  let root: string;
  beforeEach(() => {
    state = openState(":memory:");
    root = mkdtempSync(join(tmpdir(), "proxy-worker-"));
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

  let events: WorkerEvent[] = [];
  let pausedFlag = false;
  const make = (
    workspace: Workspace,
    runReview: RunReview,
    publisher = fakePublisher([posted]),
    maxAttempts = 3,
  ) =>
    createWorker({
      state,
      workspace,
      runReview,
      publisher,
      config: parseConfig({ reviewsDir: join(root, "reviews"), review: { maxAttempts } }),
      log: silentLog,
      pluginPath: async (plugin) => `/plugins/${plugin}`,
      onEvent: (e) => void events.push(e),
      isPostingPaused: () => pausedFlag,
    });

  it("keeps the review but does not post while posting is paused, then posts on resume", async () => {
    pausedFlag = true;
    const publisher = fakePublisher([posted]);
    const review = countingReview();
    const worker = make(fakeWorkspace(root), review, publisher);

    const job = await worker.processOne();
    expect(job).toMatchObject({ status: "reviewed", findings: 2 });
    expect(publisher.calls).toBe(0);
    expect(await worker.processOne()).toBeUndefined(); // nothing else to do while paused

    pausedFlag = false;
    expect(await worker.processOne()).toMatchObject({ status: "done", review_id: 555 });
    expect(publisher.calls).toBe(1);
    expect(review.calls).toBe(1);
  });

  it("reports a posted review and a final failure, but not a retry", async () => {
    events = [];
    await make(fakeWorkspace(root), countingReview()).processOne();
    expect(events.map((e) => e.type)).toEqual(["posted"]);
    expect(events[0]).toMatchObject({ review: { id: 555 } });

    state.recordSeen({
      repo: pr.repo,
      pr: 200,
      headSha: "abc",
      title: "t",
      url: "u",
      decision: { action: "queue" },
    });
    events = [];
    const failing = async () => {
      throw new Error("overloaded");
    };
    await make(fakeWorkspace(root), failing, fakePublisher(), 1).processOne();
    expect(events).toEqual([
      expect.objectContaining({ type: "failed", step: "review", error: "overloaded" }),
    ]);
  });

  it("reviews, writes the outputs and publishes in one pass", async () => {
    const ws = fakeWorkspace(root);
    const job = await make(ws, countingReview()).processOne();

    expect(job).toMatchObject({
      status: "done",
      findings: 2,
      cost_usd: 2.1,
      review_id: 555,
      event: "CHANGES_REQUESTED",
    });
    const out = join(root, "reviews", "acme-api-128-3f9c2e1");
    for (const f of ["prompt.md", "diff.patch", "pr.json", "result.json", "review.md"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const md = readFileSync(join(out, "review.md"), "utf8");
    expect(md.indexOf("🔴 bug")).toBeLessThan(md.indexOf("🔵 nit")); // most severe first
    // Numbered most severe first, so a follow-up can name each one.
    const saved = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    expect(
      saved.review.findings.map((f: { id: string; severity: string }) => [f.id, f.severity]),
    ).toEqual([
      ["F1", "bug"],
      ["F2", "nit"],
    ]);
    // The default style: the bundled skill and the readable-format prompt.
    const prompt = readFileSync(join(out, "prompt.md"), "utf8");
    expect(prompt.startsWith("/proxy-reviewer:readable-review")).toBe(true);
    expect(prompt).toContain("`title`, `problem`, `impact`");
    expect(saved.style).toBe("readable");
    expect(ws.cleaned).toBe(1);
  });

  it("retries only the post when publishing fails, never the review", async () => {
    const review = countingReview();
    const publisher = fakePublisher([new Error("GitHub 502"), posted]);
    const worker = make(fakeWorkspace(root), review, publisher);

    const first = await worker.processOne();
    expect(first).toMatchObject({ status: "reviewed", attempts: 1, error: "GitHub 502" });
    expect(first?.next_attempt_at).not.toBeNull();

    const second = await worker.processOne(undefined, first?.id);
    expect(second).toMatchObject({ status: "done", review_id: 555 });
    expect(review.calls).toBe(1);
    expect(publisher.calls).toBe(2);
  });

  it("records a dry run without a review id", async () => {
    const dry: PublishResult = {
      kind: "dry-run",
      draft: { event: "COMMENT", body: "b", comments: [], outside: [] },
    };
    const job = await make(
      fakeWorkspace(root),
      countingReview(),
      fakePublisher([dry]),
    ).processOne();
    expect(job).toMatchObject({
      status: "done",
      review_id: null,
      reason: "dry-run",
      event: "COMMENT",
    });
  });

  it("marks a job skipped when the publisher decides not to post", async () => {
    const skipped: PublishResult = { kind: "skipped", reason: "merged" };
    const job = await make(
      fakeWorkspace(root),
      countingReview(),
      fakePublisher([skipped]),
    ).processOne();
    expect(job).toMatchObject({ status: "skipped", reason: "merged" });
  });

  it("retries a failed review and cleans up anyway", async () => {
    const ws = fakeWorkspace(root);
    const publisher = fakePublisher();
    const job = await make(
      ws,
      async () => {
        throw new Error("model overloaded");
      },
      publisher,
    ).processOne();
    expect(job).toMatchObject({ status: "queued", attempts: 1, error: "model overloaded" });
    expect(ws.cleaned).toBe(1);
    expect(publisher.calls).toBe(0);
  });

  it("skips a job whose PR moved to a newer commit", async () => {
    const job = await make(
      fakeWorkspace(root, new HeadMovedError("aaaaaaa", "bbbbbbb")),
      countingReview(),
    ).processOne();
    expect(job).toMatchObject({ status: "skipped", reason: "superseded", attempts: 0 });
  });

  it("requeues without counting an attempt when shut down mid-review", async () => {
    const controller = new AbortController();
    const job = await make(fakeWorkspace(root), async () => {
      controller.abort();
      throw new Error("aborted");
    }).processOne(controller.signal);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("stops a running review when asked: skipped, nothing posted, not requeued by the poller", async () => {
    const publisher = fakePublisher([posted]);
    let worker: ReturnType<typeof make> | undefined;
    worker = make(
      fakeWorkspace(root),
      async (input) => {
        expect(worker?.stop(1)).toBe(true);
        input.signal?.throwIfAborted();
        throw new Error("not stopped");
      },
      publisher,
    );
    const job = await worker.processOne();
    expect(job).toMatchObject({ status: "skipped", reason: STOPPED_REASON, attempts: 0 });
    expect(publisher.calls).toBe(0);
    expect(worker.stop(1)).toBe(false); // nothing running any more

    state.recordSeen({
      repo: pr.repo,
      pr: pr.number,
      headSha: pr.headSha,
      title: pr.title,
      url: pr.url,
      decision: { action: "queue" },
    });
    expect(state.get(1)).toMatchObject({ status: "skipped", reason: STOPPED_REASON });
  });

  it("reviews with the model and effort picked on the status page", async () => {
    const seen: RunReviewInput[] = [];
    const review = countingReview();
    setReviewChoice(state, { model: "claude-sonnet-5-5", effort: "low" });
    await make(fakeWorkspace(root), async (input) => {
      seen.push(input);
      return review(input);
    }).processOne();
    expect(seen[0]?.settings).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  });

  it("uses the style picked on the status page: its prompt, skill and plugin", async () => {
    const seen: RunReviewInput[] = [];
    const review = countingReview();
    setReviewChoice(state, { style: "caveman-classic" });
    await make(fakeWorkspace(root), async (input) => {
      seen.push(input);
      return review(input);
    }).processOne();
    expect(seen[0]?.settings.style).toBe("caveman-classic");
    expect(seen[0]?.pluginPath).toBe("/plugins/caveman");
    expect(seen[0]?.prompt.startsWith("/caveman:caveman-review")).toBe(true);
    // The old-format prompt asks for one free-text body, not the readable parts.
    expect(seen[0]?.prompt).toContain("Explain each problem and the fix");
    const out = join(root, "reviews", "acme-api-128-3f9c2e1");
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8")).style).toBe(
      "caveman-classic",
    );
  });

  it("holds reviews while the session usage is at the limit, until the window resets", async () => {
    const review = countingReview();
    const resetsAt = new Date(Date.now() + 3_600_000);
    recordSessionUsage(state, { utilization: 92, resetsAt });
    const worker = make(fakeWorkspace(root), review);

    const job = await worker.processOne();
    expect(job).toMatchObject({
      status: "queued",
      attempts: 0,
      reason: "session usage 92% (limit 90%)",
    });
    expect(job?.next_attempt_at).toBe(resetsAt.toISOString());
    expect(review.calls).toBe(0);

    // A by-hand review runs anyway.
    expect(await worker.processOne(undefined, 1, { force: true })).toMatchObject({
      status: "done",
    });
    expect(review.calls).toBe(1);
  });

  it("reviews under the limit, or once the usage window has reset", async () => {
    recordSessionUsage(state, { utilization: 95, resetsAt: new Date(Date.now() - 1000) });
    expect(currentSessionUsage(state)).toBeUndefined();
    const review = countingReview();
    expect(await make(fakeWorkspace(root), review).processOne()).toMatchObject({ status: "done" });
    expect(review.calls).toBe(1);
  });

  it("saves the session usage Claude reports during a run", async () => {
    const review = countingReview();
    const resetsAt = new Date(Date.now() + 60_000);
    await make(fakeWorkspace(root), async (input) => {
      input.onUsage?.({ utilization: 41.5, resetsAt });
      return review(input);
    }).processOne();
    expect(currentSessionUsage(state)).toEqual({ utilization: 41.5, resetsAt });
  });

  it("returns undefined when nothing is ready", async () => {
    const worker = make(fakeWorkspace(root), countingReview());
    await worker.processOne();
    expect(await worker.processOne()).toBeUndefined();
    expect(await worker.drain()).toBe(0);
  });
});
