import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { AlreadyRunningError, acquireLock } from "./lock.ts";
import { createLogger, type Logger } from "./log.ts";
import { createNotifier, type Notifier } from "./notify.ts";

/** index.ts exits with this code when preflight checks fail (not logged in, no network yet...). */
export const EXIT_PREFLIGHT = 2;

const CRASH_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];
const PREFLIGHT_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000];
const HEALTHY_UPTIME_MS = 10 * 60_000;
const NOTIFY_AFTER_CRASHES = 3;

export interface SupervisorState {
  failures: number;
}

export type Decision =
  | { action: "stop" }
  | { action: "restart"; delayMs: number; notify?: "preflight" | "crash-loop" };

/** What to do after the server exited. Mutates `state.failures`. */
export function decideRestart(
  state: SupervisorState,
  exitCode: number | null,
  uptimeMs: number,
): Decision {
  if (exitCode === 0) return { action: "stop" };
  if (uptimeMs >= HEALTHY_UPTIME_MS) state.failures = 0; // it ran fine for a while
  state.failures++;
  const pick = (delays: number[]) =>
    delays[Math.min(state.failures, delays.length) - 1] ?? (delays.at(-1) as number);

  if (exitCode === EXIT_PREFLIGHT) {
    return {
      action: "restart",
      delayMs: pick(PREFLIGHT_DELAYS_MS),
      ...(state.failures === 1 ? { notify: "preflight" as const } : {}),
    };
  }
  return {
    action: "restart",
    delayMs: pick(CRASH_DELAYS_MS),
    ...(state.failures === NOTIFY_AFTER_CRASHES ? { notify: "crash-loop" as const } : {}),
  };
}

export interface SupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  log: Logger;
  notifier: Notifier;
  signal?: AbortSignal;
  /** Tests shrink the delays. */
  scaleDelays?: number;
}

/** Run the server, restarting it with backoff until it exits cleanly or the signal aborts. */
export async function supervise(options: SupervisorOptions): Promise<void> {
  const { command, args, cwd, log, notifier, signal, scaleDelays = 1 } = options;
  const state: SupervisorState = { failures: 0 };

  while (!signal?.aborted) {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    log.info({ pid: child.pid }, "server started");

    // Keep the tail of stderr: it holds the reason when startup checks fail.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number | null>((done) => {
      child.once("exit", (code) => done(code));
      child.once("error", (err) => {
        log.error({ err }, "could not start server");
        done(1);
      });
    });
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) break;

    const uptimeMs = Date.now() - started;
    const decision = decideRestart(state, exitCode, uptimeMs);
    if (decision.action === "stop") {
      log.info("server exited cleanly, supervisor stopping");
      return;
    }
    const reason = stderrTail.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
    log.warn(
      {
        exitCode,
        uptimeSec: Math.round(uptimeMs / 1000),
        failures: state.failures,
        retryInSec: decision.delayMs / 1000,
        reason,
      },
      "server exited, restarting",
    );
    if (decision.notify === "preflight") {
      await notifier.notify({
        title: "Proxy Reviewer can't start",
        body: reason || "Startup checks failed. See the log.",
      });
    } else if (decision.notify === "crash-loop") {
      await notifier.notify({
        title: "Proxy Reviewer keeps crashing",
        body: reason || `Exit code ${exitCode}. See the log.`,
      });
    }
    try {
      await sleep(decision.delayMs * scaleDelays, undefined, signal ? { signal } : {});
    } catch {
      break; // aborted while waiting
    }
  }
  log.info("supervisor stopped");
}

export const SUPERVISOR_LOCK = "supervisor.lock";

if (import.meta.main) {
  const config = await loadConfig("config.json");
  const log = createLogger(config.logLevel, { logDir: config.logDir, fileName: "supervisor.log" });

  // Task Scheduler may start us again while an older supervisor still runs: leave quietly.
  let release: () => void;
  try {
    release = acquireLock(join(config.dataDir, SUPERVISOR_LOCK));
  } catch (err) {
    if (!(err instanceof AlreadyRunningError)) throw err;
    log.info({ pid: err.pid }, "supervisor already running, exiting");
    log.flush(() => process.exit(0));
    await sleep(2000);
    process.exit(0);
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    await supervise({
      command: process.execPath,
      args: [fileURLToPath(new URL("./index.ts", import.meta.url)), ...process.argv.slice(2)],
      cwd: process.cwd(),
      log,
      notifier: createNotifier(config.notify, log),
      signal: controller.signal,
    });
  } finally {
    release();
  }
}
