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
      logLevel: "info",
      review: {
        enabled: true,
        model: "claude-opus-5-5",
        effort: "high",
        skill: "caveman:caveman-review",
        promptFile: "prompts/review.md",
        pluginPath: null,
        timeoutMin: 20,
        maxTurns: 80,
        maxAttempts: 3,
        keepWorktree: false,
      },
    });
  });

  it("keeps review defaults when only some review fields are set", () => {
    const config = parseConfig({ review: { effort: "max" } });
    expect(config.review).toMatchObject({ effort: "max", model: "claude-opus-5-5" });
  });

  it("matches the committed config.json", async () => {
    expect(await loadConfig("config.json")).toEqual(parseConfig({}));
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
