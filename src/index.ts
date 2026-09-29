import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { git } from "./git.ts";
import { createGitHub, type GitHub, getGhToken, parsePrRef } from "./github.ts";
import { acquireLock } from "./lock.ts";
import { createLogger } from "./log.ts";
import { createNotifier, notificationFor } from "./notify.ts";
import { pollOnce, startPolling } from "./poller.ts";
import { PreflightError, runPreflight } from "./preflight.ts";
import { approveByHand, createPublisher } from "./publisher.ts";
import { createFollowUpReviewer, createReviewer, resolvePluginPath } from "./reviewer.ts";
import { createRuntime, isPostingPaused, recordPoll } from "./runtime.ts";
import { openState } from "./state.ts";
import { EXIT_PREFLIGHT } from "./supervisor.ts";
import { startStatusServer } from "./web/server.ts";
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
const log = createLogger(config.logLevel, { logDir: config.logDir });
const notifier = createNotifier(config.notify, log);

// Log a crash before dying, so the supervisor's restart has a reason in the log.
const die = (err: unknown, code = 1) => {
  log.fatal({ err }, (err as Error)?.message ?? String(err));
  log.flush(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
};
process.on("uncaughtException", (err) => die(err));
process.on("unhandledRejection", (err) => die(err));

const controller = new AbortController();
const stop = (signal: string) => {
  log.info({ signal }, "shutting down");
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

let pluginPath: Promise<string> | undefined;
const getPluginPath = () => {
  pluginPath ??= config.review.pluginPath
    ? Promise.resolve(config.review.pluginPath)
    : resolvePluginPath("caveman@caveman");
  return pluginPath;
};

let releaseLock: (() => void) | undefined;
try {
  // 1. Everything the server needs, checked up front with a fix for each problem.
  let token = "";
  let github: GitHub | undefined;
  let viewer = "";
  const checks = await runPreflight(config, {
    nodeVersion: process.version,
    gitVersion: () => git(["--version"], { timeoutMs: 15_000 }),
    githubLogin: async () => {
      token = await getGhToken();
      github = createGitHub(token, log);
      viewer = await github.getViewerLogin();
      return viewer;
    },
    pluginPath: getPluginPath,
  });
  for (const c of checks.filter((c) => !c.ok)) log.warn({ check: c.name }, c.detail);
  if (!github) throw new Error("GitHub client missing after preflight");

  // 2. One server at a time.
  releaseLock = acquireLock(join(config.dataDir, "server.lock"));

  const state = openState(join(config.dataDir, "state.db"));
  const worker = createWorker({
    state,
    workspace: createWorkspace({
      cacheDir: config.cacheDir,
      workDir: config.workDir,
      source: github,
      token,
      gitTimeoutMs: config.gitTimeoutSec * 1000,
    }),
    runReview: createReviewer(),
    publisher: createPublisher({ github, config, viewer, log }),
    config,
    log,
    pluginPath: getPluginPath,
    isPostingPaused: () => isPostingPaused(state),
    followUp: { source: github, run: createFollowUpReviewer(), viewer },
    findPendingReview: (job) => (github as GitHub).findPendingReview(job.repo, job.pr, viewer),
    onEvent: (event) => {
      const wanted = event.type === "posted" ? config.notify.onPosted : config.notify.onFailed;
      if (wanted) void notifier.notify(notificationFor(event));
    },
  });
  const runtime = createRuntime(viewer);
  const deps = {
    github,
    state,
    config,
    viewer,
    log,
    onQueued: () => worker.kick(),
    onPolled: (result: Parameters<typeof recordPoll>[1]) => recordPoll(runtime, result),
  };
  const { signal } = controller;

  log.info(
    {
      viewer,
      pid: process.pid,
      intervalSec: config.pollIntervalSec,
      reviews: config.review.enabled,
      publish: config.publish.mode,
      followUp: config.followUp.enabled,
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
    const page = config.statusPage.enabled
      ? await startStatusServer({
          state,
          config,
          runtime,
          worker,
          log,
          approve: (job) => approveByHand(github as GitHub, viewer, job),
        })
      : undefined;
    await Promise.all([
      startPolling(deps, signal),
      config.review.enabled ? worker.start(signal) : Promise.resolve(),
    ]);
    await page?.close();
  }
  state.close();
} catch (err) {
  // Setup problems (not logged in, already running...) get the supervisor's slow retry.
  const setup = err instanceof PreflightError || (err as Error).name === "AlreadyRunningError";
  log.fatal({ err }, (err as Error).message);
  // The supervisor reads the last stderr line as the reason for its notification.
  console.error((err as Error).message);
  process.exitCode = setup ? EXIT_PREFLIGHT : 1;
} finally {
  releaseLock?.();
}
