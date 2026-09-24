import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { reviewMarker } from "../src/publish.ts";
import { createPublisher } from "../src/publisher.ts";
import type { ReviewRun } from "../src/reviewer.ts";
import type { Job } from "../src/state.ts";
import type { CreateReviewPayload, PostedReview, PullRequest, ReviewTarget } from "../src/types.ts";
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
}

function fakeGitHub(
  opts: {
    pr?: Partial<PullRequest>;
    requested?: string[];
    existing?: PostedReview;
    failFirstPost?: { status: number };
  } = {},
): Fake {
  const fake: Fake = {
    posts: [],
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
      return {
        id: 900 + fake.posts.length,
        url: "https://example/review",
        state: "CHANGES_REQUESTED",
      };
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
});
