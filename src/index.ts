import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { createGitHub, getGhToken, parsePrRef } from "./github.ts";
import { createLogger } from "./log.ts";
import { pollOnce, startPolling } from "./poller.ts";
import { createPublisher } from "./publisher.ts";
import { createReviewer, resolvePluginPath } from "./reviewer.ts";
import { openState } from "./state.ts";
import { createWorker } from "./worker.ts";
import { createWorkspace } from "./workspace.ts";

const { values: args } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    review: { type: "string" },
    "publish-only": { type: "string" },
    config: { type: "string", default: "config.json" },
  },
});

const config = await loadConfig(args.config);
const log = createLogger(config.logLevel);

const controller = new AbortController();
const stop = (signal: string) => {
  log.info({ signal }, "shutting down");
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  const token = await getGhToken();
  const github = createGitHub(token, log);
  const viewer = await github.getViewerLogin();
  const state = openState(join(config.dataDir, "state.db"));

  let pluginPath: Promise<string> | undefined;
  const worker = createWorker({
    state,
    workspace: createWorkspace({
      cacheDir: config.cacheDir,
      workDir: config.workDir,
      source: github,
      token,
    }),
    runReview: createReviewer(),
    publisher: createPublisher({ github, config, viewer, log }),
    config,
    log,
    pluginPath: () => {
      pluginPath ??= config.review.pluginPath
        ? Promise.resolve(config.review.pluginPath)
        : resolvePluginPath("caveman@caveman");
      return pluginPath;
    },
  });
  const deps = { github, state, config, viewer, log, onQueued: () => worker.kick() };
  const { signal } = controller;

  log.info(
    {
      viewer,
      intervalSec: config.pollIntervalSec,
      reviews: config.review.enabled,
      publish: config.publish.mode,
    },
    "proxy reviewer started",
  );

  // A manual run succeeded only if the review ended up on GitHub (or in a dry-run payload).
  const ok = (job: { status: string } | undefined) => job?.status === "done";

  if (args.review) {
    // Review and publish one PR by hand, whatever the skip rules say.
    const { repo, number } = parsePrRef(args.review);
    const pr = await github.getPull(repo, number);
    const job = state.enqueue({
      repo,
      pr: number,
      headSha: pr.headSha,
      title: pr.title,
      url: pr.url,
    });
    const after = await worker.processOne(signal, job.id, { force: true });
    if (!ok(after)) process.exitCode = 1;
  } else if (args["publish-only"]) {
    // Post a saved review again without re-running Claude. Duplicates are still detected.
    const id = Number(args["publish-only"]);
    const job = state.get(id);
    if (!job?.output_dir) throw new Error(`Job ${id} has no saved review`);
    state.setStatus(id, "reviewed");
    const after = await worker.processOne(signal, id, { force: true });
    if (!ok(after)) process.exitCode = 1;
  } else if (args.once) {
    log.info(await pollOnce(deps), "poll finished");
    if (config.review.enabled) {
      state.recoverStale();
      log.info({ processed: await worker.drain(signal) }, "queue drained");
    }
  } else {
    await Promise.all([
      startPolling(deps, signal),
      config.review.enabled ? worker.start(signal) : Promise.resolve(),
    ]);
  }
  state.close();
} catch (err) {
  log.fatal({ err }, (err as Error).message);
  process.exitCode = 1;
}
