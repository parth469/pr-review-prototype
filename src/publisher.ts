import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { parseCommentableLines } from "./diff.ts";
import type { Logger } from "./log.ts";
import { buildReview, type ReviewDraft, reviewMarker } from "./publish.ts";
import type { ReviewRun } from "./reviewer.ts";
import type { Job } from "./state.ts";
import type { CreateReviewPayload, PostedReview, ReviewTarget } from "./types.ts";

export type PublishResult =
  | { kind: "posted"; review: PostedReview; draft: ReviewDraft; inlineDropped: boolean }
  | { kind: "existing"; review: PostedReview }
  | { kind: "dry-run"; draft: ReviewDraft }
  | { kind: "skipped"; reason: string };

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
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function isUnprocessable(err: unknown): boolean {
  return (err as { status?: number }).status === 422;
}

export function createPublisher({ github, config, viewer, log }: PublisherDeps): Publisher {
  return {
    async publish(job, run, outDir, { force = false } = {}) {
      // 1. Already posted? Covers a crash between the POST and the database update.
      const existing = await github.findOwnReview(
        job.repo,
        job.pr,
        viewer,
        reviewMarker(job.head_sha),
      );
      if (existing) return { kind: "existing", review: existing };

      // 2. Still worth posting?
      const pr = await github.getPull(job.repo, job.pr);
      if (pr.state !== "open") return { kind: "skipped", reason: pr.merged ? "merged" : "closed" };
      if (pr.headSha !== job.head_sha) return { kind: "skipped", reason: "superseded" };
      if (!force && config.publish.requireStillRequested) {
        const requested = await github.listRequestedReviewers(job.repo, job.pr);
        if (!requested.some((login) => login.toLowerCase() === viewer.toLowerCase())) {
          return { kind: "skipped", reason: "review no longer requested" };
        }
      }

      // 3. Build the review from the saved result and the diff Claude saw.
      const commentable = parseCommentableLines(await readFile(join(outDir, "diff.patch"), "utf8"));
      const build = (noInline: boolean) =>
        buildReview({ review: run.review, pr, viewer, commentable, noInline });
      const toPayload = (draft: ReviewDraft): CreateReviewPayload => ({
        commit_id: job.head_sha,
        body: draft.body,
        comments: draft.comments,
        ...(config.publish.mode === "submit" ? { event: draft.event } : {}),
      });

      let draft = build(false);
      await writeFile(join(outDir, "review-payload.json"), json(toPayload(draft)));
      if (config.publish.mode === "dry-run") return { kind: "dry-run", draft };

      // 4. Post. If GitHub rejects an inline comment position, post everything in the body.
      let review: PostedReview;
      let inlineDropped = false;
      try {
        review = await github.createReview(job.repo, job.pr, toPayload(draft));
      } catch (err) {
        if (!isUnprocessable(err) || draft.comments.length === 0) throw err;
        log.warn({ err, repo: job.repo, pr: job.pr }, "inline comments rejected, posting in body");
        draft = build(true);
        inlineDropped = true;
        await writeFile(join(outDir, "review-payload.json"), json(toPayload(draft)));
        review = await github.createReview(job.repo, job.pr, toPayload(draft));
      }
      await writeFile(join(outDir, "posted.json"), json(review));
      return { kind: "posted", review, draft, inlineDropped };
    },
  };
}
