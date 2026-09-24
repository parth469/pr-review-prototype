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
    url: "https://github.com/acme/api/pull/128",
    author: "teammate",
    headSha: "3f9c2e1aabbccddeeff00112233445566778899a",
    draft: false,
    changedLines: 120,
    ...overrides,
  };
}
