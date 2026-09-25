import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { reviewMarker } from "../src/publish.ts";
import type { Publisher, PublishResult } from "../src/publisher.ts";
import type { FollowUpOutput, ReviewRun, RunFollowUp, RunReview } from "../src/reviewer.ts";
import { openState, type State } from "../src/state.ts";
import type { FollowUpSource } from "../src/types.ts";
import { createWorker } from "../src/worker.ts";
import type { Workspace } from "../src/workspace.ts";
import { makePr, silentLog } from "./helpers.ts";

const pr = makePr();
const prevSha = "a".repeat(40);
const SINCE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");
const PR_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,12 @@",
  ...Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`),
].join("\n");

const firstRun: ReviewRun = {
  review: {
    summary: "Two problems.",
    verdict: "request_changes",
    findings: [
      { id: "F1", path: "src/a.ts", line: 2, severity: "bug", body: "Unsafe compare." },
      { id: "F2", path: "src/a.ts", line: 10, severity: "nit", body: "Rename x." },
    ],
  },
  costUsd: 1,
  durationMs: 60_000,
  numTurns: 5,
  sessionId: "s1",
};

const answer: FollowUpOutput = {
  summary: "The compare is fixed now.",
  previous: [
    {
      id: "F1",
      verdict: "fixed",
      fixedAt: [{ path: "src/a.ts", line: 2 }],
      evidence: "timingSafeEqual on line 2",
      reply: "Fixed, thanks.",
    },
    { id: "F2", verdict: "not_fixed", fixedAt: [], evidence: "unchanged", reply: "Optional." },
  ],
  findings: [],
};

function fakeWorkspace(root: string): Workspace {
  return {
    async prepare() {
      const dir = join(root, "work");
      mkdirSync(join(dir, ".review"), { recursive: true });
      return { dir, slug: "acme-api-128-3f9c2e1", pr, diff: PR_DIFF, files: [] };
    },
    async cleanup() {},
  };
}

function fakeSource(patch = SINCE): FollowUpSource {
  return {
    compareCommits: async () => ({ linear: true, patch }),
    getReview: async () => undefined,
    listReviewThreads: async () => [],
    listIssueComments: async () => [],
  };
}

function recordingPublisher(result: PublishResult): Publisher & { runs: ReviewRun[] } {
  const p = {
    runs: [] as ReviewRun[],
    async publish(_job: unknown, run: ReviewRun) {
      p.runs.push(run);
      return result;
    },
  };
  return p;
}

const approved: PublishResult = {
  kind: "posted",
  review: { id: 901, url: "https://example/r", state: "APPROVED" },
  draft: { event: "APPROVE", submit: true, body: "b", comments: [], outside: [], replies: [] },
  inlineDropped: false,
};

describe("worker: follow-up", () => {
  let state: State;
  let root: string;
  beforeEach(() => {
    state = openState(":memory:");
    root = mkdtempSync(join(tmpdir(), "proxy-worker-fu-"));

    // Round one of this PR, already on GitHub.
    const parentDir = join(root, "reviews", "acme-api-128-aaaaaaa");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "result.json"), JSON.stringify(firstRun));
    state.recordSeen({ ...seen(prevSha) });
    const parent = state.claimNext();
    if (!parent) throw new Error("no parent");
    state.completeReview(parent.id, {
      findings: 2,
      outputDir: parentDir,
      costUsd: 1,
      durationMs: 1,
    });
    state.claimById(parent.id);
    state.completePublish(parent.id, { reviewId: 800, url: "u", event: "CHANGES_REQUESTED" });

    // The author pushed and re-requested.
    state.recordSeen(seen(pr.headSha));
  });
  afterEach(() => state.close());

  function seen(headSha: string) {
    return {
      repo: pr.repo,
      pr: pr.number,
      headSha,
      title: pr.title,
      url: pr.url,
      decision: { action: "queue" as const },
    };
  }

  const firstReview = Object.assign(
    async () => {
      firstReview.calls++;
      return { ...firstRun, review: { ...firstRun.review, findings: [] } };
    },
    { calls: 0 },
  );
  const followUpRunner = (output = answer): RunFollowUp & { prompts: string[] } => {
    const fn = Object.assign(
      async (input: { prompt: string }) => {
        fn.prompts.push(input.prompt);
        return { output, costUsd: 0.5, durationMs: 30_000, numTurns: 3, sessionId: "s2" };
      },
      { prompts: [] as string[] },
    );
    return fn;
  };

  const make = (
    publisher: Publisher,
    runFollowUp: RunFollowUp,
    source = fakeSource(),
    runReview: RunReview = firstReview,
  ) =>
    createWorker({
      state,
      workspace: fakeWorkspace(root),
      runReview,
      publisher,
      config: parseConfig({ reviewsDir: join(root, "reviews") }),
      log: silentLog,
      pluginPath: async () => "/plugins/caveman",
      followUp: { source, run: runFollowUp, viewer: "me" },
    });

  it("checks the earlier findings with the follow-up prompt, saves the verdicts and posts", async () => {
    firstReview.calls = 0;
    const runner = followUpRunner();
    const publisher = recordingPublisher(approved);
    const job = await make(publisher, runner).processOne();

    expect(job).toMatchObject({ status: "done", round: 2, event: "APPROVED", findings: 1 });
    expect(firstReview.calls).toBe(0);
    expect(runner.prompts[0]).toContain("This is a follow-up review (round 2)");
    expect(runner.prompts[0]).toContain("You reviewed commit aaaaaaa before");
    expect(runner.prompts[0]).toContain("`.review/previous.json`: F1, F2.");

    const out = join(root, "reviews", "acme-api-128-3f9c2e1");
    for (const f of ["previous.json", "threads.json", "since-last.patch", "review.md"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const saved = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as ReviewRun;
    expect(saved.followUp?.previous.map((p) => [p.id, p.verdict])).toEqual([
      ["F1", "fixed"],
      ["F2", "not_fixed"],
    ]);
    expect(saved.costUsd).toBe(0.5);
    expect(publisher.runs[0]?.followUp?.round).toBe(2);
    expect(readFileSync(join(out, "review.md"), "utf8")).toContain("# Follow-up review");
  });

  it("does a fresh full review when too much changed since the last one", async () => {
    firstReview.calls = 0;
    const huge = `${SINCE}\n${Array.from({ length: 1001 }, () => "+x").join("\n")}`;
    const runner = followUpRunner();
    await make(recordingPublisher(approved), runner, fakeSource(huge)).processOne();
    expect(firstReview.calls).toBe(1);
    expect(runner.prompts).toHaveLength(0);
  });

  it("keeps the open bug of the earlier review when a full review replaces the follow-up", async () => {
    const huge = `${SINCE}\n${Array.from({ length: 1001 }, () => "+x").join("\n")}`;
    const review: RunReview = async () => ({
      ...firstRun,
      review: {
        summary: "s",
        verdict: "request_changes",
        findings: [{ path: "src/a.ts", line: 3, severity: "nit", body: "New nit." }],
      },
    });
    const publisher = recordingPublisher(approved);
    const job = await make(publisher, followUpRunner(), fakeSource(huge), review).processOne();
    const run = publisher.runs[0];
    expect(run?.carried?.map((e) => [e.id, e.status])).toEqual([["F1", "open"]]);
    expect(run?.review.findings.map((f) => f.id)).toEqual(["F3"]); // after F1 and F2
    expect(job?.findings).toBe(2);
  });

  it("waits instead of running Claude while a pending review of yours is on the PR", async () => {
    const runner = followUpRunner();
    const worker = createWorker({
      state,
      workspace: fakeWorkspace(root),
      runReview: firstReview,
      publisher: recordingPublisher(approved),
      config: parseConfig({ reviewsDir: join(root, "reviews") }),
      log: silentLog,
      pluginPath: async () => "/plugins/caveman",
      followUp: { source: fakeSource(), run: runner, viewer: "me" },
      findPendingReview: async () => ({ body: "my draft by hand" }),
    });
    const job = await worker.processOne();
    expect(job).toMatchObject({ status: "queued", attempts: 0, waiting_since: null });
    expect(job?.reason).toContain("unsubmitted pending review");
    expect(job?.next_attempt_at).not.toBeNull();
    expect(runner.prompts).toHaveLength(0);
  });

  it("does not wait on its own pending review of the same commit", async () => {
    const runner = followUpRunner();
    const worker = createWorker({
      state,
      workspace: fakeWorkspace(root),
      runReview: firstReview,
      publisher: recordingPublisher(approved),
      config: parseConfig({ reviewsDir: join(root, "reviews") }),
      log: silentLog,
      pluginPath: async () => "/plugins/caveman",
      followUp: { source: fakeSource(), run: runner, viewer: "me" },
      findPendingReview: async () => ({ body: `draft ${reviewMarker(pr.headSha)}` }),
    });
    expect(await worker.processOne()).toMatchObject({ status: "done" });
    expect(runner.prompts).toHaveLength(1);
  });

  it("retries when Claude leaves out an earlier finding", async () => {
    const runner = followUpRunner({ ...answer, previous: answer.previous.slice(0, 1) });
    const job = await make(recordingPublisher(approved), runner).processOne();
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(job?.error).toContain("missing F2");
  });

  it("does not start the CI clock for a wait that is not about CI", async () => {
    const wait: PublishResult = {
      kind: "wait",
      reason: "pending review",
      retryAt: new Date(Date.now() + 300_000),
      ci: false,
    };
    const job = await make(recordingPublisher(wait), followUpRunner()).processOne();
    expect(job).toMatchObject({ status: "reviewed", attempts: 0, waiting_since: null });
  });

  it("holds the job while CI runs, without using an attempt", async () => {
    const wait: PublishResult = {
      kind: "wait",
      reason: "waiting for CI",
      retryAt: new Date(Date.now() + 300_000),
    };
    const job = await make(recordingPublisher(wait), followUpRunner()).processOne();
    expect(job).toMatchObject({ status: "reviewed", reason: "waiting for CI", attempts: 0 });
    expect(job?.waiting_since).not.toBeNull();
  });

  it("marks a draft left for you in the job", async () => {
    const draft: PublishResult = {
      ...approved,
      review: { id: 902, url: "u", state: "PENDING" },
      needsYou: "explained bug F1: accept the reason?",
    };
    const job = await make(recordingPublisher(draft), followUpRunner()).processOne();
    expect(job).toMatchObject({
      status: "done",
      event: "PENDING",
      reason: "needs your OK: explained bug F1: accept the reason?",
    });
  });
});
