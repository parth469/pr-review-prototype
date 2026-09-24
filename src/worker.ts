import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { loadPrompt } from "./prompt.ts";
import { renderReviewMarkdown } from "./report.ts";
import type { RunReview } from "./reviewer.ts";
import type { Job, State } from "./state.ts";
import { HeadMovedError, type PreparedWorkspace, type Workspace } from "./workspace.ts";

export interface WorkerDeps {
  state: State;
  workspace: Workspace;
  runReview: RunReview;
  config: Config;
  log: Logger;
  /** Resolved lazily so a missing plugin fails the job with a clear error, not startup. */
  pluginPath: () => Promise<string>;
}

export interface Worker {
  /**
   * Review the next ready job, or the given one. Returns the job afterwards,
   * or undefined when there was nothing to claim.
   */
  processOne(signal?: AbortSignal, jobId?: number): Promise<Job | undefined>;
  /** Process ready jobs until the queue has nothing ready. */
  drain(signal?: AbortSignal): Promise<number>;
  /** Keep processing until the signal aborts. Wakes on kick() or every idleMs. */
  start(signal: AbortSignal, idleMs?: number): Promise<void>;
  kick(): void;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function createWorker(deps: WorkerDeps): Worker {
  const { state, workspace, runReview, config, log } = deps;
  let wake: (() => void) | undefined;

  async function processOne(signal?: AbortSignal, jobId?: number): Promise<Job | undefined> {
    const job = jobId === undefined ? state.claimNext() : state.claimById(jobId);
    if (!job) return undefined;
    const fields = { job: job.id, repo: job.repo, pr: job.pr, sha: job.head_sha.slice(0, 7) };
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
    } catch (err) {
      if (err instanceof HeadMovedError) {
        state.skip(job.id, "superseded");
        log.info({ ...fields, reason: err.message }, "skipped");
      } else if (signal?.aborted) {
        // Shutting down: put it back without counting an attempt.
        state.setStatus(job.id, "queued");
        log.info(fields, "review interrupted, requeued");
      } else {
        const message = (err as Error).message;
        const after = state.failAttempt(job.id, message, config.review.maxAttempts);
        if (after.status === "failed") {
          log.error({ ...fields, err, attempts: after.attempts }, "review failed, giving up");
        } else {
          log.warn(
            { ...fields, err, attempts: after.attempts, retryAt: after.next_attempt_at },
            "review failed, will retry",
          );
        }
      }
    } finally {
      if (prepared && !config.review.keepWorktree) {
        await workspace
          .cleanup(prepared)
          .catch((err: unknown) => log.warn({ ...fields, err }, "could not remove worktree"));
      }
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
      if (recovered > 0) log.info({ recovered }, "requeued jobs left over from a previous run");

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
