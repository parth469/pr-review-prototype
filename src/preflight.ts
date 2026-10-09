import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, STYLES } from "./config.ts";
import { type PluginId, STYLE_SPECS } from "./styles.ts";

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
  pluginPath: (plugin: PluginId) => Promise<string>;
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
    // Every style can be picked on the status page, but only the default one must work to start.
    for (const style of STYLES) {
      const spec = STYLE_SPECS[style];
      await check(`style ${style}`, style === config.review.style, async () => {
        const skillName = spec.skill.split(":").pop() ?? spec.skill;
        const skillFile = join(await deps.pluginPath(spec.plugin), "skills", skillName, "SKILL.md");
        if (!exists(skillFile)) {
          const hint =
            spec.plugin === "caveman" ? " Install caveman or set review.pluginPath." : "";
          throw new Error(`${skillFile} is missing.${hint}`);
        }
        for (const prompt of [spec.reviewPrompt, spec.followUpPrompt]) {
          if (!exists(prompt)) throw new Error(`${prompt} is missing.`);
        }
        return spec.label;
      });
    }
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
