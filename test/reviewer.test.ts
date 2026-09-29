import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  createReviewer,
  type RunReviewInput,
  resolvePluginPath,
  reviewJsonSchema,
  reviewSchema,
  sanitizedEnv,
  sessionUsageFrom,
} from "../src/reviewer.ts";
import { defaultConfig } from "./helpers.ts";

const sampleReview = {
  summary: "Token check is unsafe.",
  verdict: "request_changes",
  findings: [
    { path: "src/auth.ts", line: 58, severity: "bug", mustFix: true, body: "Use timingSafeEqual." },
  ],
};

function fakeQuery(
  messages: unknown[],
  seen: { options?: Options | undefined } = {},
): typeof query {
  return (({ options }: { options?: Options }) => {
    seen.options = options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as typeof query;
}

const init = (skills: string[]) => ({ type: "system", subtype: "init", skills });
const success = (structured_output: unknown) => ({
  type: "result",
  subtype: "success",
  structured_output,
  total_cost_usd: 1.5,
  duration_ms: 120_000,
  num_turns: 12,
  session_id: "s1",
});

function input(): RunReviewInput {
  const dir = mkdtempSync(join(tmpdir(), "proxy-reviewer-"));
  return {
    cwd: dir,
    prompt: "/caveman:caveman-review ...",
    settings: defaultConfig.review,
    pluginPath: "/plugins/caveman",
    transcriptPath: join(dir, "transcript.jsonl"),
  };
}

describe("reviewJsonSchema", () => {
  it("is plain draft-07 JSON Schema without a $schema URL (Claude Code rejects 2020-12)", () => {
    expect(reviewJsonSchema).not.toHaveProperty("$schema");
    expect(reviewJsonSchema).toMatchObject({
      type: "object",
      required: ["summary", "verdict", "findings"],
    });
  });
});

describe("reviewSchema", () => {
  it("accepts a valid review and rejects bad severities or lines", () => {
    expect(reviewSchema.safeParse(sampleReview).success).toBe(true);
    const bad = { ...sampleReview, findings: [{ ...sampleReview.findings[0], line: 0 }] };
    expect(reviewSchema.safeParse(bad).success).toBe(false);
    const badSeverity = {
      ...sampleReview,
      findings: [{ ...sampleReview.findings[0], severity: "blocker" }],
    };
    expect(reviewSchema.safeParse(badSeverity).success).toBe(false);
  });
});

describe("createReviewer", () => {
  it("runs locked down and returns the parsed review", async () => {
    const seen: { options?: Options | undefined } = {};
    const run = createReviewer(
      fakeQuery([init(["caveman:caveman-review"]), success(sampleReview)], seen),
    );
    const args = input();
    const result = await run(args);

    expect(result).toMatchObject({ costUsd: 1.5, durationMs: 120_000, numTurns: 12 });
    expect(result.review.findings).toHaveLength(1);
    expect(seen.options).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      settingSources: [],
      permissionMode: "dontAsk",
      tools: ALLOWED_TOOLS,
      allowedTools: ALLOWED_TOOLS,
      plugins: [{ type: "local", path: "/plugins/caveman" }],
      outputFormat: { type: "json_schema" },
    });
    expect(seen.options?.disallowedTools).toContain("Bash");
    expect(readFileSync(args.transcriptPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("fails when the skill did not load", async () => {
    const run = createReviewer(fakeQuery([init(["other:skill"]), success(sampleReview)]));
    await expect(run(input())).rejects.toThrow(/caveman:caveman-review did not load/);
  });

  it("fails on an error result", async () => {
    const run = createReviewer(
      fakeQuery([
        init(["caveman:caveman-review"]),
        { type: "result", subtype: "error_max_turns", errors: ["too many turns"] },
      ]),
    );
    await expect(run(input())).rejects.toThrow(/error_max_turns: too many turns/);
  });

  it("fails when the output has the wrong shape", async () => {
    const run = createReviewer(
      fakeQuery([init(["caveman:caveman-review"]), success({ summary: "x" })]),
    );
    await expect(run(input())).rejects.toThrow(/wrong shape/);
  });
});

describe("session usage", () => {
  // Shape copied from a real transcript.
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1790671200,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.43, resetsAt: 1790671200 },
        seven_day: { utilization: 0.59, resetsAt: 1790352000 },
      },
    },
  };

  it("reads the 5-hour window as a percent", () => {
    expect(sessionUsageFrom(event.rate_limit_info as never)).toEqual({
      utilization: 43,
      resetsAt: new Date(1790671200 * 1000),
    });
    expect(
      sessionUsageFrom({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1790671200 }),
    ).toMatchObject({ utilization: 100 });
    expect(sessionUsageFrom({ status: "allowed", rateLimitType: "seven_day" })).toBeUndefined();
  });

  it("reports it during a run", async () => {
    const seen: number[] = [];
    await createReviewer(
      fakeQuery([init(["caveman:caveman-review"]), event, success(sampleReview)]),
    )({ ...input(), onUsage: (u) => seen.push(u.utilization) });
    expect(seen).toEqual([43]);
  });
});

describe("sanitizedEnv", () => {
  it("drops GitHub tokens and keeps the rest", () => {
    const env = sanitizedEnv({
      PATH: "/bin",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "y",
      GIT_CONFIG_KEY_0: "z",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("resolvePluginPath", () => {
  it("reads the install path from Claude's plugin registry", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "proxy-plugins-")), "installed_plugins.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 2, plugins: { "caveman@caveman": [{ installPath: "C:\\p\\c" }] } }),
    );
    expect(await resolvePluginPath("caveman@caveman", file)).toBe("C:\\p\\c");
    await expect(resolvePluginPath("missing@x", file)).rejects.toThrow(/not installed/);
  });
});
