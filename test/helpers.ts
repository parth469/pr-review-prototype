import { pino } from "pino";
import { parseConfig } from "../src/config.ts";
import type { PullRequest } from "../src/types.ts";

export const silentLog = pino({ level: "silent" });

export const defaultConfig = parseConfig({});

export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "acme/api",
    number: 128,
    title: "Add session refresh",
    body: "Refreshes sessions before they expire.",
    url: "https://github.com/acme/api/pull/128",
    author: "teammate",
    headSha: "3f9c2e1aabbccddeeff00112233445566778899a",
    baseRef: "main",
    baseSha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
    draft: false,
    changedLines: 120,
    ...overrides,
  };
}
