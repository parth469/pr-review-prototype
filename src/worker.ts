import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import {
  type FollowUpContext,
  finalizeFollowUp,
  type LedgerEntry,
  type PostedFile,
  prepareFollowUp,
} from "./followup.ts";
import { dropFindings, parseDropped, type WakeWatch } from "./hold.ts";
import type { Logger } from "./log.ts";
import { loadPrompt } from "./prompt.ts";
import { reviewMarker } from "./publish.ts";
import {
  PENDING_REASON,
  PENDING_RECHECK_MS,
  type Publisher,
  type PublishOptions,
} from "./publisher.ts";
import { numberFindings, renderReviewMarkdown } from "./report.ts";
import type { ReviewRun, RunFollowUp, RunReview } from "./reviewer.ts";
import {
  currentSessionUsage,
  holdMinutes,
  recordSessionUsage,
  reviewSettings,
  type SessionUsage,
} from "./runtime.ts";
import { type Job, STOPPED_REASON, type State } from "./state.ts";
import { type PluginId, STYLE_SPECS } from "./styles.ts";
import type { FollowUpSource, PostedReview } from "./types.ts";
import { HeadMovedError, type PreparedWorkspace, type Workspace } from "./workspace.ts";

export interface WorkerDeps {
  state: State;
  workspace: Workspace;
  runReview: RunReview;
  publisher: Publisher;
  config: Config;
  log: Logger;
  /** Resolved lazily so a missing plugin fails the job with a clear error, not startup. */
  /** Folder of the plugin a review style loads. */
  pluginPath: (plugin: PluginId) => Promise<string>;
  /** Notable outcomes, e.g. for desktop notifications. Must not throw. */
  onEvent?: (event: WorkerEvent) => void;
  /** While true, reviews still run but wait as `reviewed` instead of being posted. */
  isPostingPaused?: () => boolean;
  /** Round two and later. Without it every commit gets a first review. */
  followUp?: { source: FollowUpSource; run: RunFollowUp; viewer: string };
  /**
   * Your unsubmitted pending review on the PR, if any. GitHub allows only one, so a review
   * could not be posted while it exists: the job waits instead of running Claude for nothing.
   */
  findPendingReview?: (job: Job) => Promise<{ body: string } | undefined>;
  /** Tells whether a held review's timer ran out while the PC slept; it then waits again. */
  wakeWatch?: Pick<WakeWatch, "missedWhileAway">;
  now?: () => Date;
}

export type WorkerEvent =
  | {
      type: "posted";
      job: Job;
      review: PostedReview;
      run: ReviewRun;
      /** Left as a draft for you, with the reason. */
      needsYou?: string | null;
      /** Posted because a hold ran out without you. */
      afterTimer?: boolean;
    }
  | {
      type: "held";
      job: Job;
      run: ReviewRun;
      /** When it posts by itself; null when it waits for you. */
      until: Date | null;
    }
  | { type: "failed"; job: Job; step: "review" | "posting"; error: string };

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

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
  /** Stop the review running for this job; it ends as skipped. False if it is not running. */
  stop(jobId: number): boolean;
}

/** Without a known reset time, look at the session usage again after this long. */
export const USAGE_RECHECK_MS = 30 * 60_000;
export const USAGE_REASON_PREFIX = "session usage";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Fields = Record<string, unknown>;

export function createWorker(deps: WorkerDeps): Worker {
  const { state, workspace, runReview, publisher, config, log } = deps;
  const now = deps.now ?? (() => new Date());
  let wake: (() => void) | undefined;
  /** Reviews in progress, so the status page can stop one. */
  const running = new Map<number, AbortController>();

  /**
   * For a PR you reviewed before: gather the earlier findings, replies and changes since.
   * Without a context it is a full review instead (no earlier review saved, or too much
   * changed); `carried` are the earlier bugs and risks still open, kept for the next round.
   */
  async function planFollowUp(
    job: Job,
    prepared: PreparedWorkspace,
    fields: Fields,
  ): Promise<{ context?: FollowUpContext; carried?: LedgerEntry[]; nextId?: number }> {
    const followUp = deps.followUp;
    if (!followUp || !config.followUp.enabled || !job.parent_job_id) return {};
    const parent = state.get(job.parent_job_id);
    const parentDir = parent?.output_dir;
    const parentRun = parentDir
      ? await readJson<ReviewRun>(join(parentDir, "result.json"))
      : undefined;
    if (!parent || !parentDir || !parentRun) {
      log.warn(
        { ...fields, parent: job.parent_job_id },
        "earlier review not saved, reviewing from scratch",
      );
      return {};
    }
    const posted = await readJson<PostedFile>(join(parentDir, "posted.json"));
    const plan = await prepareFollowUp(
      { source: followUp.source, viewer: followUp.viewer, log },
      {
        job,
        parent,
        parentRun,
        ...(posted ? { posted } : {}),
        prAuthor: prepared.pr.author,
        diff: prepared.diff,
        dir: prepared.dir,
        settings: config.followUp,
      },
    );
    if (plan.kind === "fresh") {
      log.info(
        { ...fields, reason: plan.reason, carried: plan.carried.map((e) => e.id) },
        "full review instead of a follow-up",
      );
      return { carried: plan.carried, nextId: plan.nextId };
    }
    return { context: plan.context };
  }

  /** Check out, run Claude, save outputs. Returns the run, or undefined if the job stopped. */
  async function review(
    queued: Job,
    fields: Fields,
    signal?: AbortSignal,
  ): Promise<{ run: ReviewRun; outDir: string } | undefined> {
    // An earlier commit may have been posted since this one was queued.
    const job = state.linkParent(queued.id) ?? queued;
    // Read now: a model, effort or style picked on the status page applies from the next review on.
    const settings = reviewSettings(state, config);
    const style = STYLE_SPECS[settings.style];
    log.info({ ...fields, round: job.round, attempt: job.attempts + 1 }, "preparing");
    let prepared: PreparedWorkspace | undefined;
    const stopper = new AbortController();
    running.set(job.id, stopper);
    const jobSignal = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
    try {
      prepared = await workspace.prepare(job);
      stopper.signal.throwIfAborted();
      state.setStatus(job.id, "reviewing");
      const { context, carried = [], nextId = 1 } = await planFollowUp(job, prepared, fields);

      const outDir = resolve(config.reviewsDir, prepared.slug);
      await mkdir(outDir, { recursive: true });
      const vars = {
        skill: style.skill,
        repo: job.repo,
        number: job.pr,
        sha: job.head_sha,
        baseRef: prepared.pr.baseRef,
      };
      const prompt = context
        ? await loadPrompt(style.followUpPrompt, {
            ...vars,
            round: job.round,
            prevSha: context.prevSha.slice(0, 7),
            ids: context.toCheck.map((e) => e.id).join(", ") || "none",
            sinceNote: context.linear
              ? ""
              : "History was rewritten since then (force-push), so `.review/since-last.patch` is the whole PR diff.",
          })
        : await loadPrompt(style.reviewPrompt, vars);
      const inputs = context ? ["previous.json", "threads.json", "since-last.patch"] : [];
      await Promise.all([
        writeFile(join(outDir, "prompt.md"), prompt),
        writeFile(join(outDir, "diff.patch"), prepared.diff),
        writeFile(join(outDir, "pr.json"), json(prepared.pr)),
        ...inputs.map(async (name) =>
          writeFile(join(outDir, name), await readFile(join(prepared?.dir ?? "", ".review", name))),
        ),
      ]);

      log.info(
        {
          ...fields,
          round: job.round,
          followUp: Boolean(context),
          model: settings.model,
          effort: settings.effort,
          style: settings.style,
        },
        "reviewing",
      );
      const input = {
        cwd: prepared.dir,
        prompt,
        settings,
        pluginPath: await deps.pluginPath(style.plugin),
        transcriptPath: join(outDir, "transcript.jsonl"),
        signal: jobSignal,
        onUsage: (usage: SessionUsage) => recordSessionUsage(state, usage),
      };
      let run: ReviewRun;
      if (context && deps.followUp) {
        const { output, ...stats } = await deps.followUp.run(input);
        run = {
          ...stats,
          ...finalizeFollowUp(context, output, prepared.diff, log),
          style: settings.style,
        };
      } else {
        const first = await runReview(input);
        // After earlier rounds, new ids continue after theirs so every F-id stays unique.
        run = {
          ...first,
          review: { ...first.review, findings: numberFindings(first.review.findings, nextId) },
          ...(carried.length > 0 ? { carried } : {}),
          style: settings.style,
        };
      }
      // Stopped just as Claude finished: still nothing gets posted.
      stopper.signal.throwIfAborted();

      await Promise.all([
        writeFile(join(outDir, "result.json"), json(run)),
        writeFile(join(outDir, "review.md"), renderReviewMarkdown(prepared.pr, run)),
        // The original kept by an earlier post with drops belongs to the earlier run.
        rm(join(outDir, "result.ai.json"), { force: true }),
      ]);
      // Open points: earlier findings not settled yet, plus anything new.
      const open =
        (run.followUp?.previous.filter(
          (p) => p.verdict === "not_fixed" || p.verdict === "partly_fixed",
        ).length ?? 0) +
        (run.carried?.length ?? 0) +
        run.review.findings.length;
      state.completeReview(job.id, {
        findings: open,
        outputDir: outDir,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
      });
      const verdicts: Record<string, number> = {};
      for (const p of run.followUp?.previous ?? [])
        verdicts[p.verdict] = (verdicts[p.verdict] ?? 0) + 1;
      log.info(
        {
          ...fields,
          verdict: run.review.verdict,
          findings: run.review.findings.length,
          ...(run.followUp ? { round: job.round, verdicts } : {}),
          costUsd: run.costUsd,
          minutes: Number((run.durationMs / 60_000).toFixed(1)),
          output: outDir,
        },
        "reviewed",
      );
      return { run, outDir };
    } catch (err) {
      if (stopper.signal.aborted) {
        state.skip(job.id, STOPPED_REASON);
        log.info(fields, "review stopped from the status page");
      } else if (err instanceof HeadMovedError) {
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
      running.delete(job.id);
      if (prepared && !config.review.keepWorktree) {
        await workspace
          .cleanup(prepared)
          .catch((err: unknown) => log.warn({ ...fields, err }, "could not remove worktree"));
      }
    }
  }

  /** Hold a review that would request changes; it posts by itself after the set minutes. */
  function holdJob(job: Job, run: ReviewRun, fields: Fields): void {
    const minutes = holdMinutes(state, config);
    const until = new Date(now().getTime() + minutes * 60_000);
    state.hold(job.id, until, now());
    log.info({ ...fields, until, minutes }, "would request changes, waiting for your OK");
    deps.onEvent?.({ type: "held", job: state.get(job.id) ?? job, run, until });
  }

  /**
   * The review as it will be posted: without the findings you dropped. The AI's original
   * stays in result.ai.json; result.json and review.md then show what was posted.
   */
  async function applyDrops(job: Job, run: ReviewRun, outDir: string): Promise<ReviewRun> {
    const dropped = parseDropped(job.dropped);
    if (dropped.length === 0) return run;
    const kept = dropFindings(run, dropped);
    try {
      await writeFile(join(outDir, "result.ai.json"), json(run), { flag: "wx" });
    } catch (err) {
      // Already saved by an earlier attempt, which also had the original.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pr = await readJson<Parameters<typeof renderReviewMarkdown>[0]>(join(outDir, "pr.json"));
    await Promise.all([
      writeFile(join(outDir, "result.json"), json(kept)),
      pr ? writeFile(join(outDir, "review.md"), renderReviewMarkdown(pr, kept)) : undefined,
    ]);
    return kept;
  }

  /** Post a saved review. The job must be in status `posting`. */
  async function publish(
    job: Job,
    saved: ReviewRun,
    outDir: string,
    fields: Fields,
    options: PublishOptions,
  ): Promise<void> {
    try {
      // Its timer ran out while you were away: you get the full wait again.
      if (
        job.released === "timer" &&
        job.hold_until &&
        holdMinutes(state, config) > 0 &&
        deps.wakeWatch?.missedWhileAway(job.hold_until)
      ) {
        log.info({ ...fields, holdUntil: job.hold_until }, "hold ran out while away");
        holdJob(job, saved, fields);
        return;
      }
      const run = await applyDrops(job, saved, outDir);
      const hold = !options.force && !job.released && holdMinutes(state, config) > 0;
      const result = await publisher.publish(job, run, outDir, { ...options, hold });
      switch (result.kind) {
        case "posted":
        case "existing": {
          const { review } = result;
          const needsYou = result.kind === "posted" ? (result.needsYou ?? null) : null;
          state.completePublish(job.id, {
            reviewId: review.id,
            url: review.url,
            event: review.state,
            ...(needsYou ? { reason: `needs your OK: ${needsYou}` } : {}),
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
                    ...("replies" in result.draft ? { replies: result.draft.replies.length } : {}),
                    ...(needsYou ? { needsYou } : {}),
                  }
                : {}),
            },
            result.kind === "posted" ? "posted" : "already posted",
          );
          if (result.kind === "posted") {
            const afterTimer = job.released === "timer";
            deps.onEvent?.({ type: "posted", job, review, run, needsYou, afterTimer });
          }
          break;
        }
        case "hold":
          holdJob(job, run, fields);
          break;
        case "wait":
          state.defer(job.id, result.retryAt, result.reason, undefined, { ci: result.ci ?? true });
          log.info({ ...fields, reason: result.reason, retryAt: result.retryAt }, "posting later");
          break;
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

  /** True if a pending review of yours would stop this one being posted; the job then waits. */
  async function blockedByPending(job: Job, fields: Fields): Promise<boolean> {
    if (!deps.findPendingReview || config.publish.mode === "dry-run") return false;
    let pending: { body: string } | undefined;
    try {
      pending = await deps.findPendingReview(job);
    } catch (err) {
      log.warn({ ...fields, err }, "could not check for a pending review, reviewing anyway");
      return false;
    }
    // Our own pending review of this commit is resumed by the publisher, not waited on.
    if (!pending || pending.body.includes(reviewMarker(job.head_sha))) return false;
    const retryAt = new Date(Date.now() + PENDING_RECHECK_MS);
    state.defer(job.id, retryAt, PENDING_REASON, undefined, { status: "queued", ci: false });
    log.info({ ...fields, retryAt }, "pending review in the way, review later");
    return true;
  }

  /**
   * True if the 5-hour session is used up to the limit; the job then waits in the queue
   * until the window resets instead of starting a review.
   */
  function overUsageLimit(job: Job, fields: Fields): boolean {
    const limit = config.review.maxSessionUsagePct;
    const usage = limit === null ? undefined : currentSessionUsage(state);
    if (limit === null || !usage || usage.utilization < limit) return false;
    const retryAt = usage.resetsAt ?? new Date(Date.now() + USAGE_RECHECK_MS);
    const reason = `${USAGE_REASON_PREFIX} ${usage.utilization}% (limit ${limit}%)`;
    state.defer(job.id, retryAt, reason, undefined, { status: "queued", ci: false });
    log.info(
      { ...fields, usage: usage.utilization, limit, retryAt },
      "session usage high, review after the reset",
    );
    return true;
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
    const paused = () => deps.isPostingPaused?.() ?? false;
    const job =
      jobId === undefined
        ? state.claimNext(now(), { skipPosting: paused() })
        : state.claimById(jobId);
    if (!job) return undefined;
    const fields = { job: job.id, repo: job.repo, pr: job.pr, sha: job.head_sha.slice(0, 7) };

    if (job.status === "posting" && paused()) {
      state.setStatus(job.id, "reviewed"); // wait for resume
      log.info(fields, "posting paused, review kept");
      return state.get(job.id);
    }
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

    // A review you start by hand (--review) runs whatever the usage.
    if (!options.force && overUsageLimit(job, fields)) return state.get(job.id);
    if (await blockedByPending(job, fields)) return state.get(job.id);
    const reviewed = await review(job, fields, signal);
    if (reviewed && paused()) {
      log.info(fields, "review saved, posting paused");
    } else if (reviewed && !signal?.aborted) {
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

    stop(jobId) {
      const stopper = running.get(jobId);
      if (!stopper) return false;
      stopper.abort(new Error("Review stopped from the status page"));
      return true;
    },
  };
}
