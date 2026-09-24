import { readFile } from "node:fs/promises";
import { z } from "zod";

const repoPattern = z
  .string()
  .regex(/^(\*|[\w.-]+\/(\*|[\w.-]+))$/, 'Use "*", "owner/*" or "owner/name"');

export const configSchema = z.object({
  pollIntervalSec: z.number().int().min(30).default(60),
  repos: z
    .object({
      allow: z.array(repoPattern).default(["*"]),
      deny: z.array(repoPattern).default([]),
    })
    .prefault({}),
  skipDrafts: z.boolean().default(true),
  skipOwnPrs: z.boolean().default(true),
  maxChangedLines: z.number().int().positive().default(3000),
  dataDir: z.string().min(1).default("data"),
  cacheDir: z.string().min(1).default("cache"),
  workDir: z.string().min(1).default("work"),
  reviewsDir: z.string().min(1).default("reviews"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  review: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      skill: z.string().min(1).default("caveman:caveman-review"),
      promptFile: z.string().min(1).default("prompts/review.md"),
      // Plugin that provides the skill. null = look up the installed "caveman@caveman" plugin.
      pluginPath: z.string().min(1).nullable().default(null),
      timeoutMin: z.number().positive().default(20),
      maxTurns: z.number().int().positive().default(80),
      maxAttempts: z.number().int().positive().default(3),
      keepWorktree: z.boolean().default(false),
    })
    .prefault({}),
  publish: z
    .object({
      // submit: post now · pending: draft only you can see · dry-run: write the payload only
      mode: z.enum(["submit", "pending", "dry-run"]).default("submit"),
      // Skip posting if you are no longer a requested reviewer (e.g. you reviewed by hand).
      requireStillRequested: z.boolean().default(true),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return parseConfig({});
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
