import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { CheckedFinding } from "../src/followup.ts";
import { reviewMarker } from "../src/publish.ts";
import { approveByHand, createPublisher } from "../src/publisher.ts";
import type { Finding, ReviewRun, Verdict } from "../src/reviewer.ts";
import type { Job } from "../src/state.ts";
import type {
  CreateReviewPayload,
  PostedReview,
  PullRequest,
  ReviewTarget,
  ReviewThread,
} from "../src/types.ts";
import { makePr, silentLog } from "./helpers.ts";

const pr = makePr({ author: "teammate", number: 128 });
const job = { id: 1, repo: pr.repo, pr: pr.number, head_sha: pr.headSha } as Job;
const run: ReviewRun = {
  review: {
    summary: "Unsafe compare.",
    verdict: "request_changes",
    findings: [
      { path: "src/a.ts", line: 2, severity: "bug", body: "Use timingSafeEqual." },
      { path: "src/a.ts", line: 40, severity: "nit", body: "Outside the diff." },
    ],
  },
  costUsd: 0.1,
  durationMs: 1000,
  numTurns: 3,
  sessionId: "s",
};
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " one",
  "+two",
  " three",
].join("\n");

interface Fake extends ReviewTarget {
  posts: CreateReviewPayload[];
  threads: ReviewThread[];
  replies: Array<{ review: string; thread: string; body: string }>;
  submitted: Array<{ id: number; event: string }>;
  resolved: string[];
}

const EVENT_STATE: Record<string, string> = {
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
  APPROVE: "APPROVED",
};

function fakeGitHub(
  opts: {
    pr?: Partial<PullRequest>;
    requested?: string[];
    existing?: PostedReview;
    failFirstPost?: { status: number };
    threads?: ReviewThread[];
    failReply?: boolean;
  } = {},
): Fake {
  const fake: Fake = {
    posts: [],
    threads: opts.threads ?? [],
    replies: [],
    submitted: [],
    resolved: [],
    getPull: async () => ({ ...pr, ...opts.pr }),
    listRequestedReviewers: async () => opts.requested ?? ["me"],
    findOwnReview: async (_r, _n, viewer, marker) =>
      opts.existing && viewer === "me" && marker === reviewMarker(pr.headSha)
        ? opts.existing
        : undefined,
    createReview: async (_r, _n, payload) => {
      fake.posts.push(payload);
      if (opts.failFirstPost && fake.posts.length === 1) {
        throw Object.assign(new Error("Unprocessable Entity"), opts.failFirstPost);
      }
      const id = 900 + fake.posts.length;
      // Each inline comment starts a thread, as on GitHub.
      payload.comments.forEach((c, i) => {
        fake.threads.push({
          id: `T${id}-${i}`,
          isResolved: false,
          path: c.path,
          line: c.line,
          originalLine: c.line,
          comments: [{ id: id * 10 + i, author: "me", body: c.body, createdAt: "t", reviewId: id }],
        });
      });
      return {
        id,
        url: "https://example/review",
        state: payload.event ? (EVENT_STATE[payload.event] ?? "COMMENTED") : "PENDING",
        nodeId: `PRR_${id}`,
      };
    },
    listReviewThreads: async () => fake.threads,
    submitReview: async (_r, _n, id, event) => {
      fake.submitted.push({ id, event });
      return { id, url: "https://example/review", state: EVENT_STATE[event] ?? event };
    },
    replyInThread: async (review, thread, body) => {
      if (opts.failReply) throw new Error("thread gone");
      fake.replies.push({ review, thread, body });
      fake.threads
        .find((t) => t.id === thread)
        ?.comments.push({ id: 1, author: "me", body, createdAt: "t", reviewId: null });
    },
    resolveThread: async (id) => {
      fake.resolved.push(id);
    },
  };
  return fake;
}

describe("publisher", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "proxy-pub-"));
    writeFileSync(join(outDir, "diff.patch"), PATCH);
  });

  const make = (github: ReviewTarget, publish: Record<string, unknown> = {}) =>
    createPublisher({ github, config: parseConfig({ publish }), viewer: "me", log: silentLog });

  it("submits Request changes with inline and body findings", async () => {
    const github = fakeGitHub();
    const result = await make(github).publish(job, run, outDir);

    expect(result.kind).toBe("posted");
    const payload = github.posts[0];
    expect(payload).toMatchObject({ commit_id: pr.headSha, event: "REQUEST_CHANGES" });
    expect(payload?.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**🔴 bug** Use timingSafeEqual." },
    ]);
    expect(payload?.body).toContain("`src/a.ts:40`");
    expect(JSON.parse(readFileSync(join(outDir, "posted.json"), "utf8")).id).toBe(901);
    expect(existsSync(join(outDir, "review-payload.json"))).toBe(true);
  });

  it("never posts twice when our review is already there", async () => {
    const existing = { id: 42, url: "u", state: "CHANGES_REQUESTED" };
    const github = fakeGitHub({ existing });
    expect(await make(github).publish(job, run, outDir)).toEqual({
      kind: "existing",
      review: existing,
    });
    expect(github.posts).toHaveLength(0);
  });

  it.each([
    [{ state: "closed" as const, merged: true }, "merged"],
    [{ state: "closed" as const, merged: false }, "closed"],
    [{ headSha: "f".repeat(40) }, "superseded"],
  ])("skips when the PR is %o", async (prChange, reason) => {
    const github = fakeGitHub({ pr: prChange });
    expect(await make(github).publish(job, run, outDir)).toEqual({ kind: "skipped", reason });
    expect(github.posts).toHaveLength(0);
  });

  it("skips when you are no longer requested, unless forced", async () => {
    const github = fakeGitHub({ requested: ["someone-else"] });
    expect(await make(github).publish(job, run, outDir)).toEqual({
      kind: "skipped",
      reason: "review no longer requested",
    });
    expect((await make(github).publish(job, run, outDir, { force: true })).kind).toBe("posted");
  });

  it("leaves out the event in pending mode", async () => {
    const github = fakeGitHub();
    await make(github, { mode: "pending" }).publish(job, run, outDir);
    expect(github.posts[0]).not.toHaveProperty("event");
  });

  it("posts nothing in dry-run mode but writes the payload", async () => {
    const github = fakeGitHub();
    const result = await make(github, { mode: "dry-run" }).publish(job, run, outDir);
    expect(result.kind).toBe("dry-run");
    expect(github.posts).toHaveLength(0);
    const payload = JSON.parse(readFileSync(join(outDir, "review-payload.json"), "utf8"));
    expect(payload.event).toBeUndefined();
    expect(payload.comments).toHaveLength(1);
  });

  it("retries without inline comments when GitHub rejects their positions", async () => {
    const github = fakeGitHub({ failFirstPost: { status: 422 } });
    const result = await make(github).publish(job, run, outDir);
    expect(result).toMatchObject({ kind: "posted", inlineDropped: true });
    expect(github.posts).toHaveLength(2);
    expect(github.posts[1]?.comments).toEqual([]);
    expect(github.posts[1]?.body).toContain("`src/a.ts:2`");
  });

  it("lets other errors through for the worker to retry", async () => {
    const github = fakeGitHub({ failFirstPost: { status: 502 } });
    await expect(make(github).publish(job, run, outDir)).rejects.toThrow("Unprocessable");
    expect(github.posts).toHaveLength(1);
  });

  it("waits, without using an attempt, while your own pending review is in the way", async () => {
    const github = fakeGitHub({ failFirstPost: { status: 422 } });
    github.createReview = async () => {
      throw Object.assign(
        new Error('Unprocessable Entity: "User can only have one pending review per pull request"'),
        { status: 422 },
      );
    };
    expect(await make(github).publish(job, run, outDir)).toMatchObject({
      kind: "wait",
      reason: expect.stringContaining("unsubmitted pending review"),
      ci: false,
    });
  });

  it("saves where each inline finding's thread is", async () => {
    const github = fakeGitHub();
    const numbered: ReviewRun = {
      ...run,
      review: {
        ...run.review,
        findings: run.review.findings.map((f, i) => ({ ...f, id: `F${i + 1}` })),
      },
    };
    await make(github).publish(job, numbered, outDir);
    expect(github.posts[0]?.comments[0]?.body).toContain(
      `<!-- proxy-finding:${pr.headSha.slice(0, 7)}:F1 -->`,
    );
    const saved = JSON.parse(readFileSync(join(outDir, "posted.json"), "utf8"));
    expect(saved.threads).toEqual({ F1: { threadId: "T901-0", commentId: 9010 } });
  });
});

describe("publisher: follow-up", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "proxy-pub-fu-"));
    writeFileSync(join(outDir, "diff.patch"), PATCH);
  });

  const prevSha = "a".repeat(40);
  const checked = (
    id: string,
    severity: Finding["severity"],
    verdict: Verdict,
    threadId: string | null = `T-${id}`,
  ): CheckedFinding => ({
    id,
    severity,
    path: "src/a.ts",
    line: 2,
    body: `Problem ${id}. More detail.`,
    sha: prevSha,
    round: 1,
    status: verdict,
    verdict,
    evidence: "evidence",
    reply: `Reply for ${id}.`,
    fixedAt: [],
    thread: threadId ? { threadId, commentId: 5 } : null,
    threadResolved: false,
  });
  const followUpRun = (previous: CheckedFinding[], findings: Finding[] = []): ReviewRun => ({
    review: { summary: "Round two summary.", verdict: "no_issues", findings },
    followUp: {
      round: 2,
      parentJobId: 1,
      prevSha,
      linear: true,
      sinceLastLines: 12,
      previous,
      ledger: [],
    },
    costUsd: 0.2,
    durationMs: 1000,
    numTurns: 4,
    sessionId: "s2",
  });
  const threadsFor = (ids: string[]): ReviewThread[] =>
    ids.map((id) => ({
      id: `T-${id}`,
      isResolved: false,
      path: "src/a.ts",
      line: 2,
      originalLine: 2,
      comments: [{ id: 5, author: "me", body: "finding", createdAt: "t", reviewId: 800 }],
    }));
  const make = (github: ReviewTarget, raw: Record<string, unknown> = {}) =>
    createPublisher({
      github,
      config: parseConfig(raw),
      viewer: "me",
      log: silentLog,
      now: () => new Date("2026-09-25T12:00:00Z"),
    });
  const fuJob = { ...job, round: 2, waiting_since: null } as Job;

  it("approves when every point is handled, replying in and resolving each thread", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1", "F2"]) });
    const result = await make(github).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed"), checked("F2", "risk", "no_longer_applies")]),
      outDir,
    );

    expect(result).toMatchObject({ kind: "posted", review: { state: "APPROVED" } });
    expect(github.posts[0]).not.toHaveProperty("event"); // created pending, then submitted
    expect(github.submitted).toEqual([{ id: 901, event: "APPROVE" }]);
    expect(github.replies.map((r) => [r.review, r.thread])).toEqual([
      ["PRR_901", "T-F1"],
      ["PRR_901", "T-F2"],
    ]);
    expect(github.replies[0]?.body).toContain(`<!-- proxy-reply:${pr.headSha.slice(0, 7)}:F1 -->`);
    expect(github.resolved).toEqual(["T-F1", "T-F2"]);
    const body = github.posts[0]?.body ?? "";
    expect(body).toContain("**Follow-up review** · round 2 · changes since `aaaaaaa`");
    expect(body).toContain("| F1 | 🔴 bug `src/a.ts:2` Problem F1. | ✅ fixed |");
    expect(body).toContain(reviewMarker(pr.headSha));
    const payload = JSON.parse(readFileSync(join(outDir, "review-payload.json"), "utf8"));
    expect(payload).toMatchObject({ event: "APPROVE", submit: true });
  });

  it("requests changes for an open bug and leaves its thread unresolved", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1", "F2"]) });
    await make(github).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "not_fixed"), checked("F2", "bug", "fixed")]),
      outDir,
    );
    expect(github.submitted).toEqual([{ id: 901, event: "REQUEST_CHANGES" }]);
    expect(github.replies).toHaveLength(2);
    expect(github.resolved).toEqual(["T-F2"]);
  });

  it("does not answer a skipped nit in its thread, only in the table", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1", "F2"]) });
    await make(github).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed"), checked("F2", "nit", "not_fixed")]),
      outDir,
    );
    expect(github.submitted[0]?.event).toBe("APPROVE");
    expect(github.replies.map((r) => r.thread)).toEqual(["T-F1"]);
    expect(github.posts[0]?.body).toContain("❌ not fixed (non-blocking)");
  });

  it("answers findings without a thread in the body", async () => {
    const github = fakeGitHub();
    await make(github).publish(fuJob, followUpRun([checked("F1", "bug", "fixed", null)]), outDir);
    expect(github.replies).toEqual([]);
    expect(github.posts[0]?.body).toContain("- **F1** ✅ fixed: Reply for F1.");
  });

  it("leaves an approval with an explained bug as a draft for you, when set to", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1"]) });
    const result = await make(github, { followUp: { explainedBugNeedsYou: true } }).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "explained")]),
      outDir,
    );
    expect(result).toMatchObject({
      kind: "posted",
      review: { state: "PENDING" },
      needsYou: "explained bug F1: accept the reason?",
    });
    expect(github.submitted).toEqual([]);
    expect(github.resolved).toEqual([]);
    expect(github.replies).toHaveLength(1); // part of the draft, only you see it
    // Round three reads this to tell whether you accepted the explanation.
    const saved = JSON.parse(readFileSync(join(outDir, "posted.json"), "utf8"));
    expect(saved.needsYou).toBe("explained bug F1: accept the reason?");
  });

  it("finishes a follow-up that crashed after creating its pending review", async () => {
    const threads = threadsFor(["F1", "F2"]);
    threads[0]?.comments.push({
      id: 7,
      author: "me",
      body: `Already replied <!-- proxy-reply:${pr.headSha.slice(0, 7)}:F1 -->`,
      createdAt: "t",
      reviewId: 950,
    });
    const existing = { id: 950, url: "u", state: "PENDING", nodeId: "PRR_950" };
    const github = fakeGitHub({ existing, threads });
    const result = await make(github).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed"), checked("F2", "bug", "fixed")]),
      outDir,
    );
    expect(result.kind).toBe("posted");
    expect(github.posts).toHaveLength(0);
    expect(github.replies.map((r) => r.thread)).toEqual(["T-F2"]);
    expect(github.submitted).toEqual([{ id: 950, event: "APPROVE" }]);
  });

  it("keeps everything a draft in pending mode", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1"]) });
    const result = await make(github, { publish: { mode: "pending" } }).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed")]),
      outDir,
    );
    expect(result).toMatchObject({ kind: "posted", needsYou: null });
    expect(github.submitted).toEqual([]);
    expect(github.resolved).toEqual([]);
  });

  it("still submits when a thread reply fails", async () => {
    const github = fakeGitHub({ threads: threadsFor(["F1"]), failReply: true });
    const result = await make(github).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed")]),
      outDir,
    );
    expect(result.kind).toBe("posted");
    expect(github.submitted[0]?.event).toBe("APPROVE");
  });

  it("posts new findings as inline comments with their own markers", async () => {
    const github = fakeGitHub();
    await make(github).publish(
      fuJob,
      followUpRun(
        [checked("F1", "bug", "fixed", null)],
        [
          {
            id: "F2",
            path: "src/a.ts",
            line: 2,
            severity: "risk",
            mustFix: true,
            body: "New risk.",
          },
        ],
      ),
      outDir,
    );
    expect(github.submitted[0]?.event).toBe("REQUEST_CHANGES");
    expect(github.posts[0]?.comments[0]?.body).toContain(
      `**F2 · 🟡 risk** New risk.\n\n<!-- proxy-finding:${pr.headSha.slice(0, 7)}:F2 -->`,
    );
    expect(github.posts[0]?.body).toContain("**New since the last review: 1 risk**");
  });

  it("writes the decision but posts nothing in dry-run mode", async () => {
    const github = fakeGitHub();
    const result = await make(github, { publish: { mode: "dry-run" } }).publish(
      fuJob,
      followUpRun([checked("F1", "bug", "fixed", null)]),
      outDir,
    );
    expect(result).toMatchObject({ kind: "dry-run", draft: { event: "APPROVE" } });
    expect(github.posts).toHaveLength(0);
  });
});

describe("approveByHand", () => {
  const job = { repo: "acme/api", pr: 7, head_sha: "abc1234def" } as Job;
  const posted = { id: 5, url: "u", state: "APPROVED", nodeId: "n" };

  function fake(pending?: { id: number; body: string }) {
    const calls: unknown[] = [];
    return {
      calls,
      findPendingReview: async () => pending,
      submitReview: async (_r: string, _n: number, id: number, event: string) => {
        calls.push(["submit", id, event]);
        return posted;
      },
      createReview: async (_r: string, _n: number, payload: unknown) => {
        calls.push(["create", payload]);
        return posted;
      },
    };
  }

  it("submits this commit's draft as the approval", async () => {
    const github = fake({
      id: 3,
      body: `draft

${reviewMarker(job.head_sha)}`,
    });
    await approveByHand(github, "me", job);
    expect(github.calls).toEqual([["submit", 3, "APPROVE"]]);
  });

  it("posts a new approval when there is no draft", async () => {
    const github = fake();
    await approveByHand(github, "me", job);
    expect(github.calls).toEqual([
      ["create", { commit_id: job.head_sha, body: "Approved.", event: "APPROVE", comments: [] }],
    ]);
  });

  it("refuses while another pending review of yours is in the way", async () => {
    const github = fake({ id: 3, body: "something else" });
    await expect(approveByHand(github, "me", job)).rejects.toThrow("unsubmitted pending review");
    expect(github.calls).toEqual([]);
  });
});
