import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What was found, or what to do about it. */
  detail: string;
  /** A failed fatal check stops startup. */
  fatal: boolean;
}

export interface PreflightDeps {
  nodeVersion: string;
  gitVersion: () => Promise<string>;
  /** Returns the GitHub login, or throws with the reason. */
  githubLogin: () => Promise<string>;
  pluginPath: () => Promise<string>;
  exists?: (path: string) => boolean;
  writable?: (dir: string) => Promise<void>;
}

export class PreflightError extends Error {
  readonly results: CheckResult[];
  constructor(results: CheckResult[]) {
    const failed = results.filter((r) => r.fatal && !r.ok);
    super(failed.map((r) => `${r.name}: ${r.detail}`).join("; "));
    this.name = "PreflightError";
    this.results = results;
  }
}

export const MIN_NODE = [24, 15] as const;

async function probeWritable(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `.write-test-${process.pid}`);
  await writeFile(file, "");
  await rm(file, { force: true });
}

function nodeAtLeast(version: string, [major, minor]: readonly [number, number]): boolean {
  const [maj = 0, min = 0] = version.replace(/^v/, "").split(".").map(Number);
  return maj > major || (maj === major && min >= minor);
}

/** Check everything the server needs, so a broken setup fails at startup with a fix to run. */
export async function runPreflight(config: Config, deps: PreflightDeps): Promise<CheckResult[]> {
  const exists = deps.exists ?? existsSync;
  const writable = deps.writable ?? probeWritable;
  const results: CheckResult[] = [];
  const check = async (name: string, fatal: boolean, run: () => Promise<string>) => {
    try {
      results.push({ name, ok: true, detail: await run(), fatal });
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message, fatal });
    }
  };

  await check("node", false, async () => {
    if (!nodeAtLeast(deps.nodeVersion, MIN_NODE)) {
      throw new Error(
        `Node ${deps.nodeVersion} works but is older than ${MIN_NODE.join(".")}. ` +
          "Run `nvm install 24.21.0` then `nvm use 24.21.0`.",
      );
    }
    return deps.nodeVersion;
  });

  await check("git", true, async () => {
    try {
      return await deps.gitVersion();
    } catch {
      throw new Error("git was not found. Install Git for Windows and make sure it is on PATH.");
    }
  });

  await check("github", true, async () => `logged in as ${await deps.githubLogin()}`);

  if (config.review.enabled) {
    await check("review skill", true, async () => {
      const plugin = await deps.pluginPath();
      const skillName = config.review.skill.split(":").pop() ?? config.review.skill;
      const skillFile = join(plugin, "skills", skillName, "SKILL.md");
      if (!exists(skillFile)) {
        throw new Error(`${skillFile} is missing. Check review.skill and review.pluginPath.`);
      }
      return config.review.skill;
    });
    await check("prompt", true, async () => {
      if (!exists(config.review.promptFile)) {
        throw new Error(`${config.review.promptFile} is missing. Check review.promptFile.`);
      }
      return config.review.promptFile;
    });
  }

  for (const dir of [config.dataDir, config.logDir, config.reviewsDir, config.cacheDir]) {
    await check(`folder ${dir}`, true, async () => {
      await writable(dir);
      return "writable";
    });
  }

  if (results.some((r) => r.fatal && !r.ok)) throw new PreflightError(results);
  return results;
}
