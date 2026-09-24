import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { loadPrompt } from "./prompt.ts";
import type { Publisher, PublishOptions } from "./publisher.ts";
import { renderReviewMarkdown } from "./report.ts";
import type { ReviewRun, RunReview } from "./reviewer.ts";
import type { Job, State } from "./state.ts";
import type { PostedReview } from "./types.ts";
import { HeadMovedError, type PreparedWorkspace, type Workspace } from "./workspace.ts";

export interface WorkerDeps {
  state: State;
  workspace: Workspace;
  runReview: RunReview;
  publisher: Publisher;
  config: Config;
  log: Logger;
  /** Resolved lazily so a missing plugin fails the job with a clear error, not startup. */
  pluginPath: () => Promise<string>;
  /** Notable outcomes, e.g. for desktop notifications. Must not throw. */
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { type: "posted"; job: Job; review: PostedReview; run: ReviewRun }
  | { type: "failed"; job: Job; step: "review" | "posting"; error: string };

export interface Worker {
  /**
   * Take the next ready job, or the given one, one step further: review it and publish it,
   * or only publish it if the review is already saved. Returns the job afterwards,
   * or undefined when there was nothing to claim.
   */
  processOne(
    signal?: AbortSignal,
    jobId?: number,
    options?: PublishOptions,
  ): Promise<Job | undefined>;
  /** Process ready jobs until the queue has nothing ready. */
  drain(signal?: AbortSignal): Promise<number>;
  /** Keep processing until the signal aborts. Wakes on kick() or every idleMs. */
  start(signal: AbortSignal, idleMs?: number): Promise<void>;
  kick(): void;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Fields = Record<string, unknown>;

export function createWorker(deps: WorkerDeps): Worker {
  const { state, workspace, runReview, publisher, config, log } = deps;
  let wake: (() => void) | undefined;

  /** Check out, run Claude, save outputs. Returns the run, or undefined if the job stopped. */
  async function review(
    job: Job,
    fields: Fields,
    signal?: AbortSignal,
  ): Promise<{ run: ReviewRun; outDir: string } | undefined> {
    log.info({ ...fields, attempt: job.attempts + 1 }, "preparing");
    let prepared: PreparedWorkspace | undefined;
    try {
      prepared = await workspace.prepare(job);
      state.setStatus(job.id, "reviewing");

      const outDir = resolve(config.reviewsDir, prepared.slug);
      await mkdir(outDir, { recursive: true });
      const prompt = await loadPrompt(config.review.promptFile, {
        skill: config.review.skill,
        repo: job.repo,
        number: job.pr,
        sha: job.head_sha,
        baseRef: prepared.pr.baseRef,
      });
      await Promise.all([
        writeFile(join(outDir, "prompt.md"), prompt),
        writeFile(join(outDir, "diff.patch"), prepared.diff),
        writeFile(join(outDir, "pr.json"), json(prepared.pr)),
      ]);

      log.info(
        { ...fields, model: config.review.model, effort: config.review.effort },
        "reviewing",
      );
      const run = await runReview({
        cwd: prepared.dir,
        prompt,
        settings: config.review,
        pluginPath: await deps.pluginPath(),
        transcriptPath: join(outDir, "transcript.jsonl"),
        ...(signal ? { signal } : {}),
      });

      await Promise.all([
        writeFile(join(outDir, "result.json"), json(run)),
        writeFile(join(outDir, "review.md"), renderReviewMarkdown(prepared.pr, run)),
      ]);
      state.completeReview(job.id, {
        findings: run.review.findings.length,
        outputDir: outDir,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
      });
      log.info(
        {
          ...fields,
          verdict: run.review.verdict,
          findings: run.review.findings.length,
          costUsd: run.costUsd,
          minutes: Number((run.durationMs / 60_000).toFixed(1)),
          output: outDir,
        },
        "reviewed",
      );
      return { run, outDir };
    } catch (err) {
      if (err instanceof HeadMovedError) {
        state.skip(job.id, "superseded");
        log.info({ ...fields, reason: err.message }, "skipped");
      } else if (signal?.aborted) {
        // Shutting down: put it back without counting an attempt.
        state.setStatus(job.id, "queued");
        log.info(fields, "review interrupted, requeued");
      } else {
        const after = state.failAttempt(job.id, (err as Error).message, config.review.maxAttempts);
        logFailure(after, err, fields, "review");
      }
      return undefined;
    } finally {
      if (prepared && !config.review.keepWorktree) {
        await workspace
          .cleanup(prepared)
          .catch((err: unknown) => log.warn({ ...fields, err }, "could not remove worktree"));
      }
    }
  }

  /** Post a saved review. The job must be in status `posting`. */
  async function publish(
    job: Job,
    run: ReviewRun,
    outDir: string,
    fields: Fields,
    options: PublishOptions,
  ): Promise<void> {
    try {
      const result = await publisher.publish(job, run, outDir, options);
      switch (result.kind) {
        case "posted":
        case "existing": {
          const { review } = result;
          state.completePublish(job.id, {
            reviewId: review.id,
            url: review.url,
            event: review.state,
          });
          log.info(
            {
              ...fields,
              state: review.state,
              url: review.url,
              ...(result.kind === "posted"
                ? {
                    inline: result.draft.comments.length,
                    inBody: result.draft.outside.length,
                    inlineDropped: result.inlineDropped,
                  }
                : {}),
            },
            result.kind === "posted" ? "posted" : "already posted",
          );
          if (result.kind === "posted") deps.onEvent?.({ type: "posted", job, review, run });
          break;
        }
        case "dry-run":
          state.completePublish(job.id, {
            reviewId: null,
            url: null,
            event: result.draft.event,
            reason: "dry-run",
          });
          log.info(
            { ...fields, event: result.draft.event, payload: join(outDir, "review-payload.json") },
            "dry run, nothing posted",
          );
          break;
        case "skipped":
          state.skip(job.id, result.reason);
          log.info({ ...fields, reason: result.reason }, "not posted");
          break;
      }
    } catch (err) {
      const after = state.failAttempt(job.id, (err as Error).message, config.review.maxAttempts, {
        retryStatus: "reviewed",
      });
      logFailure(after, err, fields, "posting");
    }
  }

  function logFailure(after: Job, err: unknown, fields: Fields, step: "review" | "posting"): void {
    if (after.status === "failed") {
      log.error({ ...fields, err, attempts: after.attempts }, `${step} failed, giving up`);
      deps.onEvent?.({ type: "failed", job: after, step, error: (err as Error).message });
    } else {
      log.warn(
        { ...fields, err, attempts: after.attempts, retryAt: after.next_attempt_at },
        `${step} failed, will retry`,
      );
    }
  }

  async function processOne(
    signal?: AbortSignal,
    jobId?: number,
    options: PublishOptions = {},
  ): Promise<Job | undefined> {
    const job = jobId === undefined ? state.claimNext() : state.claimById(jobId);
    if (!job) return undefined;
    const fields = { job: job.id, repo: job.repo, pr: job.pr, sha: job.head_sha.slice(0, 7) };

    if (job.status === "posting") {
      // Review already saved by an earlier pass; only the post is left.
      try {
        const outDir = job.output_dir ?? "";
        const run = JSON.parse(await readFile(join(outDir, "result.json"), "utf8")) as ReviewRun;
        await publish(job, run, outDir, fields, options);
      } catch (err) {
        // The saved review is unreadable, so review again from scratch.
        log.warn({ ...fields, err }, "saved review missing, reviewing again");
        state.setStatus(job.id, "queued");
      }
      return state.get(job.id);
    }

    const reviewed = await review(job, fields, signal);
    if (reviewed && !signal?.aborted) {
      const posting = state.claimById(job.id); // reviewed -> posting
      if (posting) await publish(posting, reviewed.run, reviewed.outDir, fields, options);
    }
    return state.get(job.id);
  }

  return {
    processOne,

    async drain(signal) {
      let count = 0;
      while (!signal?.aborted && (await processOne(signal))) count++;
      return count;
    },

    async start(signal, idleMs = 60_000) {
      const recovered = state.recoverStale();
      if (recovered > 0) log.info({ recovered }, "resumed jobs left over from a previous run");

      while (!signal.aborted) {
        if (await processOne(signal)) continue;
        await new Promise<void>((done) => {
          const timer = setTimeout(done, idleMs);
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            wake = undefined;
            done();
          };
          wake = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    },

    kick() {
      wake?.();
    },
  };
}
