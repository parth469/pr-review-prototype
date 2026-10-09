import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { type PreflightDeps, PreflightError, runPreflight } from "../src/preflight.ts";

const config = parseConfig({});

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    nodeVersion: "v24.21.0",
    gitVersion: async () => "git version 2.50.0",
    githubLogin: async () => "me",
    pluginPath: async (plugin) => `/plugins/${plugin}`,
    exists: () => true,
    writable: async () => undefined,
    ...overrides,
  };
}

async function failure(overrides: Partial<PreflightDeps>): Promise<PreflightError> {
  try {
    await runPreflight(config, deps(overrides));
  } catch (err) {
    if (err instanceof PreflightError) return err;
    throw err;
  }
  throw new Error("expected a PreflightError");
}

describe("runPreflight", () => {
  it("passes a healthy setup", async () => {
    const results = await runPreflight(config, deps());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.name === "github")?.detail).toBe("logged in as me");
  });

  it("only warns about an old Node", async () => {
    const results = await runPreflight(config, deps({ nodeVersion: "v24.11.1" }));
    expect(results.find((r) => r.name === "node")).toMatchObject({ ok: false, fatal: false });
    expect(results.find((r) => r.name === "node")?.detail).toContain("nvm install 24.21.0");
  });

  it("stops when GitHub login fails, with the reason", async () => {
    const err = await failure({
      githubLogin: async () => {
        throw new Error("No GitHub login found. Run `gh auth login` and start again.");
      },
    });
    expect(err.message).toBe("github: No GitHub login found. Run `gh auth login` and start again.");
  });

  it("stops when git is missing", async () => {
    const err = await failure({
      gitVersion: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(err.message).toContain("Install Git for Windows");
  });

  it("checks the default style's skill file inside its plugin", async () => {
    const err = await failure({
      exists: (p) => !p.replace(/\\/g, "/").includes("readable-review/SKILL.md"),
    });
    expect(err.message).toMatch(
      /style readable: .*bundled.*readable-review[\\/]SKILL\.md is missing/,
    );
  });

  it("only warns about caveman when the default style does not need it", async () => {
    const noCaveman = async (plugin: string) => {
      if (plugin === "bundled") return "/plugins/bundled";
      throw new Error("Plugin caveman@caveman is not installed.");
    };
    const results = await runPreflight(config, deps({ pluginPath: noCaveman }));
    expect(
      results.filter((r) => r.name.startsWith("style ")).map((r) => [r.name, r.ok, r.fatal]),
    ).toEqual([
      ["style readable", true, true],
      ["style caveman-readable", false, false],
      ["style caveman-classic", false, false],
    ]);
    // With a caveman style as the default, a missing caveman stops startup.
    const classic = parseConfig({ review: { style: "caveman-classic" } });
    await expect(runPreflight(classic, deps({ pluginPath: noCaveman }))).rejects.toThrow(
      /style caveman-classic: Plugin caveman@caveman is not installed/,
    );
  });

  it("stops when a folder is not writable", async () => {
    const err = await failure({
      writable: async (dir) => {
        if (dir === "logs") throw new Error("EACCES: permission denied");
      },
    });
    expect(err.message).toBe("folder logs: EACCES: permission denied");
  });

  it("skips the review checks when reviews are off", async () => {
    const results = await runPreflight(
      parseConfig({ review: { enabled: false } }),
      deps({ exists: () => false }),
    );
    expect(results.map((r) => r.name)).not.toContain("style readable");
  });
});
