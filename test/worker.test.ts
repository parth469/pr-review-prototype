import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { Publisher, PublishResult } from "../src/publisher.ts";
import type { RunReview } from "../src/reviewer.ts";
import { openState, type State } from "../src/state.ts";
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
      pluginPath: async () => "/plugins/caveman",
      onEvent: (e) => void events.push(e),
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
    expect(readFileSync(join(out, "prompt.md"), "utf8").startsWith("/caveman:caveman-review")).toBe(
      true,
    );
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

  it("returns undefined when nothing is ready", async () => {
    const worker = make(fakeWorkspace(root), countingReview());
    await worker.processOne();
    expect(await worker.processOne()).toBeUndefined();
    expect(await worker.drain()).toBe(0);
  });
});
