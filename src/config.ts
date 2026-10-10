import { readFile } from "node:fs/promises";
import { z } from "zod";

/** The models and effort levels you can pick on the status page. */
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];
/** How findings are written; also pickable on the status page. See docs/review-styles.html. */
export const STYLES = ["readable", "caveman-readable", "caveman-classic"] as const;
export type Style = (typeof STYLES)[number];
/** Minutes a review that would request changes waits for you, as offered on the status page. */
export const HOLD_CHOICES = [0, 15, 30, 60, 120] as const;

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
  logDir: z.string().min(1).default("logs"),
  // Longest a single git command (clone, fetch, checkout) may run before it is killed.
  gitTimeoutSec: z.number().int().min(10).default(300),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  review: z
    .object({
      enabled: z.boolean().default(true),
      // Defaults only: a choice made on the status page wins until you change it there.
      model: z.enum(MODELS).default("claude-opus-5-5"),
      effort: z.enum(EFFORTS).default("high"),
      // Hold reviews while the 5-hour session usage is at or above this percent. null = never.
      maxSessionUsagePct: z.number().min(1).max(100).nullable().default(90),
      style: z.enum(STYLES).default("readable"),
      // Folder of the caveman plugin, for the caveman styles. null = the installed "caveman@caveman".
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
      // A review that would request changes waits this many minutes for your OK on the status
      // page, then posts as it is. 0 = post at once. Default only: a pick on the page wins.
      holdMin: z.number().int().min(0).default(30),
    })
    .prefault({}),
  followUp: z
    .object({
      // Re-requested review on a PR you reviewed before: check the earlier findings, then decide.
      enabled: z.boolean().default(true),
      // submit: approve at once · pending: leave every approval as a draft for you to submit
      approve: z.enum(["submit", "pending"]).default("submit"),
      // true: an "explained" bug is not accepted without you, the approval waits as a draft.
      explainedBugNeedsYou: z.boolean().default(false),
      // Same for an "explained" risk.
      explainedRiskNeedsYou: z.boolean().default(false),
      // Rounds after this one are only posted as a draft for you, to stop endless back and forth.
      maxAutoRounds: z.number().int().min(2).default(3),
      // A push this big since the last review gets a fresh full review instead.
      freshReviewOverLines: z.number().int().positive().default(1000),
      resolveThreads: z.boolean().default(true),
    })
    .prefault({}),
  statusPage: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(1).max(65535).default(4777),
    })
    .prefault({}),
  notify: z
    .object({
      enabled: z.boolean().default(true),
      onPosted: z.boolean().default(true),
      onFailed: z.boolean().default(true),
      // A review waits for your OK (see publish.holdMin).
      onHeld: z.boolean().default(true),
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
