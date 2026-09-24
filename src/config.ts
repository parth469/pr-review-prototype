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
    .default({ allow: ["*"], deny: [] }),
  skipDrafts: z.boolean().default(true),
  skipOwnPrs: z.boolean().default(true),
  maxChangedLines: z.number().int().positive().default(3000),
  dataDir: z.string().min(1).default("data"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
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
