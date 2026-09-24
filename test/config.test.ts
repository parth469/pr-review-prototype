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
      logLevel: "info",
    });
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
