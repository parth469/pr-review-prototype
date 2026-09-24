import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { RunReview } from "../src/reviewer.ts";
import { openState, type State } from "../src/state.ts";
import { createWorker } from "../src/worker.ts";
import { HeadMovedError, type Workspace } from "../src/workspace.ts";
import { makePr, silentLog } from "./helpers.ts";

const pr = makePr();

function fakeWorkspace(root: string, fail?: Error): Workspace & { cleaned: number } {
  const ws = {
    cleaned: 0,
    async prepare() {
      if (fail) throw fail;
      return { dir: join(root, "work"), slug: "acme-api-128-3f9c2e1", pr, diff: "diff", files: [] };
    },
    async cleanup() {
      ws.cleaned++;
    },
  };
  return ws;
}

const okReview: RunReview = async () => ({
  review: {
    summary: "One real bug.",
    verdict: "request_changes",
    findings: [
      { path: "src/a.ts", line: 3, severity: "nit", body: "Rename x." },
      { path: "src/b.ts", line: 9, severity: "bug", body: "Null deref." },
    ],
  },
  costUsd: 2.1,
  durationMs: 300_000,
  numTurns: 20,
  sessionId: "s",
});

describe("worker", () => {
  let state: State;
  let root: string;
  beforeEach(() => {
    state = openState(":memory:");
    root = mkdtempSync(join(tmpdir(), "proxy-worker-"));
    state.recordSeen({
      repo: pr.repo,
      pr: pr.number,
      headSha: pr.headSha,
      title: pr.title,
      url: pr.url,
      decision: { action: "queue" },
    });
  });
  afterEach(() => state.close());

  const make = (workspace: Workspace, runReview: RunReview) =>
    createWorker({
      state,
      workspace,
      runReview,
      config: parseConfig({ reviewsDir: join(root, "reviews") }),
      log: silentLog,
      pluginPath: async () => "/plugins/caveman",
    });

  it("reviews a queued job and writes the outputs", async () => {
    const ws = fakeWorkspace(root);
    const job = await make(ws, okReview).processOne();

    expect(job).toMatchObject({ status: "reviewed", findings: 2, cost_usd: 2.1 });
    const out = join(root, "reviews", "acme-api-128-3f9c2e1");
    for (const f of ["prompt.md", "diff.patch", "pr.json", "result.json", "review.md"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const md = readFileSync(join(out, "review.md"), "utf8");
    expect(md.indexOf("🔴 bug")).toBeLessThan(md.indexOf("🔵 nit")); // most severe first
    expect(readFileSync(join(out, "prompt.md"), "utf8").startsWith("/caveman:caveman-review")).toBe(
      true,
    );
    expect(ws.cleaned).toBe(1);
  });

  it("retries a failed review and cleans up anyway", async () => {
    const ws = fakeWorkspace(root);
    const job = await make(ws, async () => {
      throw new Error("model overloaded");
    }).processOne();
    expect(job).toMatchObject({ status: "queued", attempts: 1, error: "model overloaded" });
    expect(ws.cleaned).toBe(1);
  });

  it("skips a job whose PR moved to a newer commit", async () => {
    const job = await make(
      fakeWorkspace(root, new HeadMovedError("aaaaaaa", "bbbbbbb")),
      okReview,
    ).processOne();
    expect(job).toMatchObject({ status: "skipped", reason: "superseded", attempts: 0 });
  });

  it("requeues without counting an attempt when shut down mid-review", async () => {
    const controller = new AbortController();
    const job = await make(fakeWorkspace(root), async () => {
      controller.abort();
      throw new Error("aborted");
    }).processOne(controller.signal);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("returns undefined when nothing is ready", async () => {
    const worker = make(fakeWorkspace(root), okReview);
    await worker.processOne();
    expect(await worker.processOne()).toBeUndefined();
    expect(await worker.drain()).toBe(0);
  });
});
