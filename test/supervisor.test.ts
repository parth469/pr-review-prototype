import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Notification } from "../src/notify.ts";
import { decideRestart, EXIT_PREFLIGHT, supervise } from "../src/supervisor.ts";
import { silentLog } from "./helpers.ts";

describe("decideRestart", () => {
  it("stops on a clean exit", () => {
    expect(decideRestart({ failures: 0 }, 0, 1000)).toEqual({ action: "stop" });
  });

  it("backs off on repeated crashes and notifies on the third", () => {
    const state = { failures: 0 };
    const delays = [1, 2, 3, 4, 5].map(() => decideRestart(state, 1, 1000));
    expect(delays.map((d) => d.action === "restart" && d.delayMs)).toEqual([
      5_000, 15_000, 60_000, 300_000, 300_000,
    ]);
    expect(delays.map((d) => d.action === "restart" && d.notify)).toEqual([
      undefined,
      undefined,
      "crash-loop",
      undefined,
      undefined,
    ]);
  });

  it("forgets old crashes after a healthy run", () => {
    const state = { failures: 3 };
    expect(decideRestart(state, 1, 11 * 60_000)).toMatchObject({ delayMs: 5_000 });
    expect(state.failures).toBe(1);
  });

  it("waits longer on setup failures and notifies once", () => {
    const state = { failures: 0 };
    expect(decideRestart(state, EXIT_PREFLIGHT, 500)).toEqual({
      action: "restart",
      delayMs: 30_000,
      notify: "preflight",
    });
    expect(decideRestart(state, EXIT_PREFLIGHT, 500)).toEqual({
      action: "restart",
      delayMs: 120_000,
    });
  });
});

describe("supervise", () => {
  it("restarts a crashing server until it exits cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-sup-"));
    const counter = join(dir, "runs.txt");
    const script = join(dir, "child.mjs");
    writeFileSync(counter, "0");
    // Crash twice with a message on stderr, then exit cleanly.
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
       const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
       writeFileSync(${JSON.stringify(counter)}, String(n));
       if (n < 3) { console.error("boom " + n); process.exit(1); }`,
    );
    const notes: Notification[] = [];
    await supervise({
      command: process.execPath,
      args: [script],
      cwd: dir,
      log: silentLog,
      notifier: { notify: async (n) => void notes.push(n) },
      scaleDelays: 0.001,
    });
    expect(readFileSync(counter, "utf8")).toBe("3");
    expect(notes).toEqual([]); // two crashes is below the crash-loop threshold
  }, 30_000);

  it("notifies with the reason when startup checks fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-sup-"));
    const counter = join(dir, "runs.txt");
    const script = join(dir, "child.mjs");
    writeFileSync(counter, "0");
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
       const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
       writeFileSync(${JSON.stringify(counter)}, String(n));
       if (n === 1) { console.error("github: Run gh auth login"); process.exit(${EXIT_PREFLIGHT}); }`,
    );
    const notes: Notification[] = [];
    await supervise({
      command: process.execPath,
      args: [script],
      cwd: dir,
      log: silentLog,
      notifier: { notify: async (n) => void notes.push(n) },
      scaleDelays: 0.0001,
    });
    expect(notes).toEqual([
      { title: "Proxy Reviewer can't start", body: "github: Run gh auth login" },
    ]);
  }, 30_000);
});
