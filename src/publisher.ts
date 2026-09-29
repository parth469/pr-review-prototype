import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { decideFollowUp } from "./decide.ts";
import { parseCommentableLines } from "./diff.ts";
import { type PostedFile, replyMarker } from "./followup.ts";
import type { Logger } from "./log.ts";
import {
  buildFollowUpReview,
  buildReview,
  type FollowUpDraft,
  type ReviewDraft,
  reviewMarker,
} from "./publish.ts";
import type { ReviewRun } from "./reviewer.ts";
import type { Job } from "./state.ts";
import type {
  CreateReviewPayload,
  PostedReview,
  PullRequest,
  ReviewTarget,
  ReviewThread,
  ThreadRef,
} from "./types.ts";

export type PublishResult =
  | {
      kind: "posted";
      review: PostedReview;
      draft: ReviewDraft | FollowUpDraft;
      inlineDropped: boolean;
      /** Set when a follow-up was left as a draft for you to decide, with the reason. */
      needsYou?: string | null;
    }
  | { kind: "existing"; review: PostedReview }
  | { kind: "dry-run"; draft: ReviewDraft | FollowUpDraft }
  | { kind: "skipped"; reason: string }
  /**
   * Not ready yet (a pending review of yours in the way). Try again at retryAt without using
   * an attempt. `ci: false`: not a CI wait, so the CI wait clock does not start.
   */
  | { kind: "wait"; reason: string; retryAt: Date; ci?: boolean };

export interface PublishOptions {
  /** Post even if you are no longer a requested reviewer (manual --review). */
  force?: boolean;
}

export interface Publisher {
  publish(
    job: Job,
    run: ReviewRun,
    outDir: string,
    options?: PublishOptions,
  ): Promise<PublishResult>;
}

export interface PublisherDeps {
  github: ReviewTarget;
  config: Config;
  viewer: string;
  log: Logger;
  now?: () => Date;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const PENDING_RECHECK_MS = 15 * 60_000;
export const PENDING_REASON =
  "waiting: you have an unsubmitted pending review on this PR. Submit or delete it on GitHub";

/** GitHub allows one pending review per person per PR, e.g. a draft left for your OK. */
class PendingReviewError extends Error {}
const FINDING_MARKER = /<!-- proxy-finding:([0-9a-f]{7}):(F\d+) -->/;

function isUnprocessable(err: unknown): boolean {
  return (err as { status?: number }).status === 422;
}

/** Where each finding of this review landed: F-id -> its thread and first comment. */
export function threadMap(
  threads: ReviewThread[],
  reviewId: number,
  headSha: string,
): Record<string, ThreadRef> {
  const map: Record<string, ThreadRef> = {};
  for (const t of threads) {
    const first = t.comments[0];
    if (!first || first.reviewId !== reviewId) continue;
    const m = FINDING_MARKER.exec(first.body);
    if (m?.[2] && m[1] === headSha.slice(0, 7)) map[m[2]] = { threadId: t.id, commentId: first.id };
  }
  return map;
}

export function createPublisher({
  github,
  config,
  viewer,
  log,
  now = () => new Date(),
}: PublisherDeps): Publisher {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  /** Whether the review is still worth posting; the reason if not. */
  async function stillRelevant(job: Job, force: boolean): Promise<PullRequest | string> {
    const pr = await github.getPull(job.repo, job.pr);
    if (pr.state !== "open") return pr.merged ? "merged" : "closed";
    if (pr.headSha !== job.head_sha) return "superseded";
    if (!force && config.publish.requireStillRequested) {
      const requested = await github.listRequestedReviewers(job.repo, job.pr);
      if (!requested.some((login) => same(login, viewer))) return "review no longer requested";
    }
    return pr;
  }

  /** The thread map for posted.json. A failure only costs round two a fallback match. */
  async function savePosted(
    job: Job,
    review: PostedReview,
    outDir: string,
    threads?: ReviewThread[],
    needsYou?: string | null,
  ): Promise<void> {
    let file: PostedFile = { ...review, ...(needsYou ? { needsYou } : {}) };
    try {
      const all = threads ?? (await github.listReviewThreads(job.repo, job.pr));
      file = { ...file, threads: threadMap(all, review.id, job.head_sha) };
    } catch (err) {
      log.warn({ err, repo: job.repo, pr: job.pr }, "could not read review threads after posting");
    }
    await writeFile(join(outDir, "posted.json"), json(file));
  }

  /** Create the review; if GitHub rejects an inline comment position, post everything in the body. */
  async function create<D extends ReviewDraft | FollowUpDraft>(
    job: Job,
    build: (noInline: boolean) => D,
    toPayload: (draft: D) => CreateReviewPayload,
    outDir: string,
  ): Promise<{ review: PostedReview; draft: D; inlineDropped: boolean }> {
    let draft = build(false);
    try {
      return {
        review: await github.createReview(job.repo, job.pr, toPayload(draft)),
        draft,
        inlineDropped: false,
      };
    } catch (err) {
      if (isUnprocessable(err) && /pending review/i.test((err as Error).message)) {
        throw new PendingReviewError(PENDING_REASON);
      }
      if (!isUnprocessable(err) || draft.comments.length === 0) throw err;
      log.warn({ err, repo: job.repo, pr: job.pr }, "inline comments rejected, posting in body");
      draft = build(true);
      await writeFile(join(outDir, "review-payload.json"), json(toPayload(draft)));
      return {
        review: await github.createReview(job.repo, job.pr, toPayload(draft)),
        draft,
        inlineDropped: true,
      };
    }
  }

  async function publishFirst(
    job: Job,
    run: ReviewRun,
    outDir: string,
    pr: PullRequest,
    commentable: Map<string, Set<number>>,
  ): Promise<PublishResult> {
    const build = (noInline: boolean) =>
      buildReview({
        review: run.review,
        pr,
        viewer,
        commentable,
        noInline,
        ...(run.carried ? { carried: run.carried } : {}),
      });
    const toPayload = (draft: ReviewDraft): CreateReviewPayload => ({
      commit_id: job.head_sha,
      body: draft.body,
      comments: draft.comments,
      ...(config.publish.mode === "submit" ? { event: draft.event } : {}),
    });
    await writeFile(join(outDir, "review-payload.json"), json(toPayload(build(false))));
    if (config.publish.mode === "dry-run") return { kind: "dry-run", draft: build(false) };

    const { review, draft, inlineDropped } = await create(job, build, toPayload, outDir);
    await savePosted(job, review, outDir);
    return { kind: "posted", review, draft, inlineDropped };
  }

  async function publishFollowUp(
    job: Job,
    run: ReviewRun,
    outDir: string,
    pr: PullRequest,
    commentable: Map<string, Set<number>>,
    pending: PostedReview | undefined,
  ): Promise<PublishResult> {
    const followUp = run.followUp;
    if (!followUp) throw new Error("not a follow-up");
    const settings = config.followUp;
    const decision = decideFollowUp({
      previous: followUp.previous,
      newFindings: run.review.findings,
      ownPr: same(pr.author, viewer),
      round: followUp.round,
      settings,
    });

    const submit = decision.submit && config.publish.mode === "submit";
    const build = (noInline: boolean) =>
      buildFollowUpReview({
        review: run.review,
        followUp,
        pr,
        commentable,
        event: decision.event,
        submit,
        note: decision.note,
        resolveThreads: settings.resolveThreads,
        noInline,
      });
    // Created as a pending review first, so the thread replies join it before anyone sees it.
    const toPayload = (draft: FollowUpDraft): CreateReviewPayload => ({
      commit_id: job.head_sha,
      body: draft.body,
      comments: draft.comments,
    });
    const record = (draft: FollowUpDraft) =>
      writeFile(
        join(outDir, "review-payload.json"),
        json({
          ...toPayload(draft),
          event: draft.event,
          submit,
          decision: { reason: decision.reason, needsYou: decision.needsYou },
          replies: draft.replies,
        }),
      );
    await record(build(false));
    log.info(
      {
        job: job.id,
        repo: job.repo,
        pr: job.pr,
        event: decision.event,
        submit,
        reason: decision.reason,
      },
      "follow-up decided",
    );
    if (config.publish.mode === "dry-run") return { kind: "dry-run", draft: build(false) };

    let review: PostedReview;
    let draft: FollowUpDraft;
    let inlineDropped = false;
    if (pending) {
      // A crash after creating the review: carry on with it.
      review = pending;
      draft = build(false);
    } else {
      ({ review, draft, inlineDropped } = await create(job, build, toPayload, outDir));
      if (inlineDropped) await record(draft);
    }
    if (!review.nodeId) throw new Error(`GitHub returned review ${review.id} without a node id`);

    // Replies already there (from a run that crashed halfway) are not posted again.
    let threads = await github.listReviewThreads(job.repo, job.pr);
    let replied = 0;
    for (const reply of draft.replies) {
      const marker = replyMarker(job.head_sha, reply.id);
      const thread = threads.find((t) => t.id === reply.threadId);
      if (thread?.comments.some((c) => c.body.includes(marker))) continue;
      try {
        await github.replyInThread(review.nodeId, reply.threadId, reply.body);
        replied++;
      } catch (err) {
        // The verdict table in the body still answers this finding.
        log.warn({ err, repo: job.repo, pr: job.pr, id: reply.id }, "could not reply in thread");
      }
    }
    if (replied > 0) threads = await github.listReviewThreads(job.repo, job.pr);

    if (!submit) {
      await savePosted(job, review, outDir, threads, decision.needsYou);
      if (pending) return { kind: "existing", review };
      return {
        kind: "posted",
        review,
        draft,
        inlineDropped,
        needsYou: config.publish.mode === "submit" ? decision.needsYou : null,
      };
    }

    review = {
      ...(await github.submitReview(job.repo, job.pr, review.id, decision.event)),
      nodeId: review.nodeId,
    };
    for (const reply of draft.replies.filter((r) => r.resolve)) {
      await github
        .resolveThread(reply.threadId)
        .catch((err: unknown) =>
          log.warn({ err, repo: job.repo, pr: job.pr, id: reply.id }, "could not resolve thread"),
        );
    }
    await savePosted(job, review, outDir, threads);
    return { kind: "posted", review, draft, inlineDropped };
  }

  return {
    async publish(job, run, outDir, { force = false } = {}) {
      // 1. Already posted? Covers a crash between the POST and the database update.
      const existing = await github.findOwnReview(
        job.repo,
        job.pr,
        viewer,
        reviewMarker(job.head_sha),
      );
      // A follow-up's pending review may still need its replies and its submit.
      const resume =
        run.followUp && existing?.state === "PENDING" && config.publish.mode === "submit";
      if (existing && !resume) return { kind: "existing", review: existing };

      // 2. Still worth posting?
      const relevant = await stillRelevant(job, force);
      if (typeof relevant === "string") return { kind: "skipped", reason: relevant };

      // 3. Build the review from the saved result and the diff Claude saw, and post it.
      const commentable = parseCommentableLines(await readFile(join(outDir, "diff.patch"), "utf8"));
      try {
        return await (run.followUp
          ? publishFollowUp(job, run, outDir, relevant, commentable, resume ? existing : undefined)
          : publishFirst(job, run, outDir, relevant, commentable));
      } catch (err) {
        if (!(err instanceof PendingReviewError)) throw err;
        const retryAt = new Date(now().getTime() + PENDING_RECHECK_MS);
        return { kind: "wait", reason: err.message, retryAt, ci: false };
      }
    },
  };
}

/**
 * Approve a follow-up by hand, overriding the review that was posted. A draft of this commit
 * left for your OK is submitted as the approval; otherwise a new approving review is posted.
 */
export async function approveByHand(
  github: Pick<ReviewTarget, "createReview" | "submitReview"> & {
    findPendingReview(
      repo: string,
      number: number,
      viewer: string,
    ): Promise<{ id: number; body: string } | undefined>;
  },
  viewer: string,
  job: Job,
): Promise<PostedReview> {
  const pending = await github.findPendingReview(job.repo, job.pr, viewer);
  if (pending?.body.includes(reviewMarker(job.head_sha))) {
    return github.submitReview(job.repo, job.pr, pending.id, "APPROVE");
  }
  // GitHub allows one pending review per person per PR, and it is not ours to submit.
  if (pending) throw new Error(PENDING_REASON.replace(/^waiting: /, ""));
  return github.createReview(job.repo, job.pr, {
    commit_id: job.head_sha,
    body: "Approved.",
    event: "APPROVE",
    comments: [],
  });
}
