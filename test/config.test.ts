import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.ts";

describe("config", () => {
  it("fills defaults for an empty object", () => {
    expect(parseConfig({})).toEqual({
      pollIntervalSec: 60,
      repos: { allow: ["*"], deny: [] },
      skipDrafts: true,
      skipOwnPrs: true,
      maxChangedLines: 3000,
      dataDir: "data",
      cacheDir: "cache",
      workDir: "work",
      reviewsDir: "reviews",
      logDir: "logs",
      gitTimeoutSec: 300,
      logLevel: "info",
      review: {
        enabled: true,
        model: "claude-opus-5-5",
        effort: "high",
        maxSessionUsagePct: 90,
        style: "readable",
        pluginPath: null,
        timeoutMin: 20,
        maxTurns: 80,
        maxAttempts: 3,
        keepWorktree: false,
      },
      publish: { mode: "submit", requireStillRequested: true, holdMin: 30 },
      followUp: {
        enabled: true,
        approve: "submit",
        explainedBugNeedsYou: false,
        explainedRiskNeedsYou: false,
        maxAutoRounds: 3,
        freshReviewOverLines: 1000,
        resolveThreads: true,
      },
      statusPage: { enabled: true, port: 4777 },
      notify: { enabled: true, onPosted: true, onFailed: true, onHeld: true },
    });
  });

  it("keeps review defaults when only some review fields are set", () => {
    const config = parseConfig({ review: { effort: "low" } });
    expect(config.review).toMatchObject({ effort: "low", model: "claude-opus-5-5" });
  });

  it("rejects a model or effort the status page does not offer", () => {
    expect(() => parseConfig({ review: { model: "claude-haiku-4-5" } })).toThrow(/model/);
    expect(() => parseConfig({ review: { effort: "max" } })).toThrow(/effort/);
  });

  it("matches the committed config.json: defaults, limited to Axy-K-Git, drafts and big PRs in", async () => {
    expect(await loadConfig("config.json")).toEqual(
      parseConfig({
        repos: { allow: ["Axy-Science/Axy-K-Git"], deny: [] },
        skipDrafts: false,
        maxChangedLines: 10000,
      }),
    );
  });

  it("offers three review styles and still loads a config from before them", () => {
    expect(() => parseConfig({ review: { style: "terse" } })).toThrow(/style/);
    const old = parseConfig({ review: { skill: "caveman:caveman-review", promptFile: "x.md" } });
    expect(old.review.style).toBe("readable");
    expect(old.review).not.toHaveProperty("skill");
  });

  it("rejects bad repo patterns and short intervals", () => {
    expect(() => parseConfig({ repos: { allow: ["acme"] } })).toThrow(/owner\/name/);
    expect(() => parseConfig({ pollIntervalSec: 5 })).toThrow(/Invalid config/);
  });

  it("uses defaults when the file is missing", async () => {
    const config = await loadConfig(join(tmpdir(), "does-not-exist-proxy-reviewer.json"));
    expect(config.pollIntervalSec).toBe(60);
  });

  it("reports invalid JSON with the file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-reviewer-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ nope");
    await expect(loadConfig(path)).rejects.toThrow(/config\.json is not valid JSON/);
  });
});
