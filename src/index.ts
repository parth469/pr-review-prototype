import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { createGitHub, getGhToken } from "./github.ts";
import { createLogger } from "./log.ts";
import { pollOnce, startPolling } from "./poller.ts";
import { openState } from "./state.ts";

const { values: args } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    config: { type: "string", default: "config.json" },
  },
});

const config = await loadConfig(args.config);
const log = createLogger(config.logLevel);

try {
  const github = createGitHub(await getGhToken(), log);
  const viewer = await github.getViewerLogin();
  const state = openState(join(config.dataDir, "state.db"));
  const deps = { github, state, config, viewer, log };

  log.info({ viewer, intervalSec: config.pollIntervalSec }, "proxy reviewer started");

  if (args.once) {
    const summary = await pollOnce(deps);
    log.info(summary, "poll finished");
    state.close();
  } else {
    const controller = new AbortController();
    const stop = (signal: string) => {
      log.info({ signal }, "shutting down");
      controller.abort();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));

    await startPolling(deps, controller.signal);
    state.close();
  }
} catch (err) {
  log.fatal({ err }, (err as Error).message);
  process.exitCode = 1;
}
