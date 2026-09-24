import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { decide } from "./filters.ts";
import type { Logger } from "./log.ts";
import type { State } from "./state.ts";
import type { GitHubClient } from "./types.ts";

export interface PollDeps {
  github: GitHubClient;
  state: State;
  config: Config;
  viewer: string;
  log: Logger;
}

export interface PollSummary {
  found: number;
  queued: number;
  skipped: number;
  known: number;
  errors: number;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export async function pollOnce({
  github,
  state,
  config,
  viewer,
  log,
}: PollDeps): Promise<PollSummary> {
  const requests = await github.searchReviewRequests();
  const summary: PollSummary = {
    found: requests.length,
    queued: 0,
    skipped: 0,
    known: 0,
    errors: 0,
  };

  for (const { repo, number } of requests) {
    try {
      const pr = await github.getPull(repo, number);
      const decision = decide(pr, config, viewer);
      const result = state.recordSeen({
        repo,
        pr: number,
        headSha: pr.headSha,
        title: pr.title,
        url: pr.url,
        decision,
      });
      const fields = {
        repo,
        pr: number,
        sha: pr.headSha.slice(0, 7),
        title: pr.title,
        url: pr.url,
      };

      if (result === "known") {
        summary.known++;
        log.debug(fields, "already seen");
      } else if (decision.action === "queue") {
        summary.queued++;
        log.info(fields, result === "requeued" ? "requeued" : "queued");
      } else {
        summary.skipped++;
        log.info({ ...fields, reason: decision.reason }, "skipped");
      }
    } catch (err) {
      // One broken PR should not stop the others from being picked up.
      summary.errors++;
      log.error({ err, repo, pr: number }, "failed to process PR");
    }
  }
  return summary;
}

/** Poll until the signal aborts. Runs never overlap; failures back off up to 5 minutes. */
export async function startPolling(deps: PollDeps, signal: AbortSignal): Promise<void> {
  const intervalMs = deps.config.pollIntervalSec * 1000;
  let failures = 0;

  while (!signal.aborted) {
    try {
      const summary = await pollOnce(deps);
      failures = 0;
      deps.log.debug(summary, "poll finished");
    } catch (err) {
      failures++;
      deps.log.error({ err, failures }, "poll failed");
    }

    const delay =
      failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    try {
      await sleep(delay, undefined, { signal });
    } catch {
      break; // aborted during the wait
    }
  }
}
