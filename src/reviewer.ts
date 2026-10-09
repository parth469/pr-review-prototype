import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config, Style } from "./config.ts";
import type { FollowUpResult, LedgerEntry } from "./followup.ts";
import type { SessionUsage } from "./runtime.ts";
import { STYLE_SPECS } from "./styles.ts";

export const findingSchema = z.object({
  path: z.string().min(1).describe("File path relative to the repository root"),
  line: z.number().int().min(1).describe("Line number in the new version of the file"),
  endLine: z.number().int().min(1).optional().describe("Last line, for multi-line findings"),
  severity: z.enum(["bug", "risk", "nit", "question"]),
  mustFix: z
    .boolean()
    .describe(
      "true for every bug, and for a risk only when it is serious: security, data loss, a crash or broken behaviour in production. false for a minor risk, a nit or a question",
    ),
  title: z
    .string()
    .min(1)
    .describe(
      "Short headline in plain words someone new to this code understands, no code names. E.g. 'Stop button may not stop the request'",
    ),
  problem: z.string().min(1).describe("What's wrong, in one or two plain sentences, no code names"),
  impact: z
    .string()
    .min(1)
    .describe(
      "What happens if this is not fixed: what a user sees or what breaks, in plain sentences. For a nit, say plainly that nothing breaks and why it still matters. For a question, what goes wrong if the answer is no",
    ),
  fix: z
    .string()
    .min(1)
    .describe("How to fix it, with the exact file, function and variable names"),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Optional. The exact new code that replaces lines line..endLine (or line alone) of the new file, with the file's indentation, and nothing else. Give it only when the whole fix is inside those lines and applying it alone leaves the code working. Omit otherwise",
    ),
  why: z
    .string()
    .min(1)
    .describe(
      "Why you think so, as short markdown bullets: what you read or traced, with exact files, lines and names, so a person can check the claim",
    ),
});

type FindingText = "title" | "problem" | "impact" | "fix" | "suggestion" | "why";

/** The "caveman-classic" style: one free-text body per finding, as before issue #6. */
export const classicFindingSchema = findingSchema
  .pick({ path: true, line: true, endLine: true, severity: true, mustFix: true })
  .extend({ body: z.string().min(1).describe("The problem, why it matters, and the fix") });

const reviewShape = <F extends z.ZodType>(finding: F) =>
  z.object({
    summary: z.string().min(1).describe("2-4 sentence overview of the PR and the main problems"),
    verdict: z.enum(["request_changes", "no_issues"]),
    findings: z.array(finding),
  });
export const reviewSchema = reviewShape(findingSchema);
export const classicReviewSchema = reviewShape(classicFindingSchema);

// mustFix and the text parts are optional here: reviews saved before them have neither, and
// keep their findings as one free-text `body`.
export type Finding = Omit<z.infer<typeof findingSchema>, "mustFix" | FindingText> &
  Partial<Pick<z.infer<typeof findingSchema>, FindingText>> & {
    body?: string;
    mustFix?: boolean;
    /** F1, F2... given after the run, stable across rounds so a follow-up can name each finding. */
    id?: string;
  };
/**
 * Whether a finding blocks approval from round two on. A bug always does; a risk only when
 * graded serious. Findings saved before the grade existed count as minor unless a bug.
 */
export const mustFix = (f: Pick<Finding, "severity" | "mustFix">) =>
  f.severity === "bug" || (f.severity === "risk" && f.mustFix === true);

export type Review = Omit<z.infer<typeof reviewSchema>, "findings"> & { findings: Finding[] };

export const VERDICTS = [
  "fixed",
  "partly_fixed",
  "not_fixed",
  "explained",
  "no_longer_applies",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Round two: one verdict per earlier finding, plus new problems in the new commits. */
const followUpShape = <F extends z.ZodType>(finding: F) =>
  z.object({
    summary: z
      .string()
      .min(1)
      .describe("2-4 sentences: what changed since your last review and what is still open"),
    previous: z.array(
      z.object({
        id: z.string().describe("The earlier finding's id from .review/previous.json, e.g. F3"),
        verdict: z.enum(VERDICTS),
        fixedAt: z
          .array(z.object({ path: z.string().min(1), line: z.number().int().min(1) }))
          .describe(
            "For fixed and partly_fixed: new-file lines inside .review/since-last.patch that make the fix. Empty otherwise",
          ),
        evidence: z
          .string()
          .min(1)
          .describe("Why this verdict: the change that fixes it, or the reply and why it holds"),
        reply: z.string().min(1).describe("Short reply to the author for the finding's thread"),
      }),
    ),
    findings: z
      .array(finding)
      .describe("New problems, only on lines added or changed in .review/since-last.patch"),
  });
export const followUpSchema = followUpShape(findingSchema);
export const classicFollowUpSchema = followUpShape(classicFindingSchema);
export type FollowUpOutput = Omit<z.infer<typeof followUpSchema>, "findings"> & {
  findings: Finding[];
};

// Claude Code validates --json-schema as draft-07 and rejects the 2020-12 $schema URL zod emits by default.
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...body } = z.toJSONSchema(schema, { target: "draft-7" });
  return body as Record<string, unknown>;
}
export const reviewJsonSchema = toJsonSchema(reviewSchema);
export const followUpJsonSchema = toJsonSchema(followUpSchema);
const classicReviewJsonSchema = toJsonSchema(classicReviewSchema);
const classicFollowUpJsonSchema = toJsonSchema(classicFollowUpSchema);

// Claude may only look. Everything not allowed is denied by permissionMode "dontAsk";
// the deny list is a second fence in case a tool gets allowed by accident.
export const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];
export const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

// Claude never needs GitHub access; keep every token out of its process.
const SECRET_ENV =
  /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GIT_CONFIG_.*)$/i;

export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV.test(key)) out[key] = value;
  }
  return out;
}

/** Find an installed Claude Code plugin, e.g. "caveman@caveman", from Claude's own registry. */
export async function resolvePluginPath(
  pluginId: string,
  registry = join(homedir(), ".claude", "plugins", "installed_plugins.json"),
): Promise<string> {
  let data: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    data = JSON.parse(await readFile(registry, "utf8"));
  } catch {
    throw new Error(`Cannot read ${registry}. Is Claude Code installed?`);
  }
  const path = data.plugins?.[pluginId]?.[0]?.installPath;
  if (!path) {
    throw new Error(`Plugin ${pluginId} is not installed. Install it or set review.pluginPath.`);
  }
  return path;
}

interface RunStats {
  costUsd: number;
  durationMs: number;
  numTurns: number;
  sessionId: string;
}

export interface ReviewRun extends RunStats {
  /** For a follow-up: summary and the new findings. */
  review: Review;
  /** Set on a follow-up (round 2+): the verdicts on earlier findings. */
  followUp?: FollowUpResult;
  /** A full review that replaced a follow-up: earlier bugs and risks still open, checked next round. */
  carried?: LedgerEntry[];
  /** How the findings were written. Missing on reviews saved before styles existed. */
  style?: Style;
}

export type FollowUpRun = RunStats & { output: FollowUpOutput };

export interface RunReviewInput {
  cwd: string;
  prompt: string;
  settings: Config["review"];
  pluginPath: string;
  transcriptPath: string;
  signal?: AbortSignal;
  /** Plan usage of the 5-hour session, each time Claude reports it during the run. */
  onUsage?: (usage: SessionUsage) => void;
}

export type RunReview = (input: RunReviewInput) => Promise<ReviewRun>;
export type RunFollowUp = (input: RunReviewInput) => Promise<FollowUpRun>;

/**
 * The 5-hour session usage in a rate_limit_event. `unifiedWindows` is not in the SDK types yet,
 * but every event carries it; utilization there is 0-1.
 */
export function sessionUsageFrom(info: SDKRateLimitInfo): SessionUsage | undefined {
  const windows = (info as { unifiedWindows?: Record<string, unknown> }).unifiedWindows;
  const window = windows?.five_hour as { utilization?: number; resetsAt?: number } | undefined;
  const fiveHour = info.rateLimitType === "five_hour";
  const fraction =
    window?.utilization ??
    (fiveHour ? info.utilization : undefined) ??
    (fiveHour && info.status === "rejected" ? 1 : undefined);
  if (fraction == null) return undefined;
  const resetsAt = window?.resetsAt ?? (fiveHour ? info.resetsAt : undefined);
  return {
    utilization: Math.round(fraction * 1000) / 10,
    resetsAt: resetsAt ? new Date(resetsAt * 1000) : null,
  };
}

export function buildOptions(
  input: RunReviewInput,
  abortController: AbortController,
  outputSchema: Record<string, unknown> = reviewJsonSchema,
): Options {
  const { settings } = input;
  return {
    model: settings.model,
    effort: settings.effort,
    cwd: input.cwd,
    // No user/project/local settings: a PR could ship .claude/ hooks or instructions.
    settingSources: [],
    plugins: [{ type: "local", path: input.pluginPath }],
    // Only these built-in tools exist in the session at all (no Task, Cron, RemoteTrigger...).
    tools: ALLOWED_TOOLS,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DENIED_TOOLS,
    permissionMode: "dontAsk",
    outputFormat: { type: "json_schema", schema: outputSchema },
    maxTurns: settings.maxTurns,
    persistSession: false,
    env: sanitizedEnv(),
    abortController,
  };
}

/** One locked-down Claude run whose structured output must match `schema`. */
function createRunner<T>(
  queryFn: typeof query,
  schema: z.ZodType<T>,
  jsonSchema: Record<string, unknown>,
): (input: RunReviewInput) => Promise<RunStats & { output: T }> {
  return async (input) => {
    const controller = new AbortController();
    const timeoutMs = input.settings.timeoutMin * 60_000;
    const timer = setTimeout(
      () => controller.abort(new Error(`Review timed out after ${input.settings.timeoutMin} min`)),
      timeoutMs,
    );
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const transcript = createWriteStream(input.transcriptPath, { flags: "w" });
    let result: Extract<SDKMessage, { type: "result" }> | undefined;
    let failure: Error | undefined;

    try {
      const run = queryFn({
        prompt: input.prompt,
        options: buildOptions(input, controller, jsonSchema),
      });
      for await (const message of run) {
        transcript.write(`${JSON.stringify(message)}\n`);
        if (message.type === "system" && message.subtype === "init") {
          const { skill } = STYLE_SPECS[input.settings.style];
          if (!message.skills.includes(skill)) {
            failure = new Error(
              `Skill ${skill} did not load. Loaded: ${message.skills.join(", ") || "none"}`,
            );
            controller.abort(failure);
            break;
          }
        } else if (message.type === "result") {
          result = message;
        } else if (message.type === "rate_limit_event" && input.onUsage) {
          const usage = sessionUsageFrom(message.rate_limit_info);
          if (usage) input.onUsage(usage);
        }
      }
    } catch (err) {
      failure ??= controller.signal.aborted ? (controller.signal.reason as Error) : (err as Error);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      await new Promise<void>((done) => transcript.end(done));
    }

    if (failure) throw failure;
    if (!result) throw new Error("Claude finished without a result");
    if (result.subtype !== "success") {
      throw new Error(`Claude run ended with ${result.subtype}: ${result.errors.join("; ")}`);
    }

    const parsed = schema.safeParse(result.structured_output);
    if (!parsed.success) {
      throw new Error(
        `Claude returned findings in the wrong shape:\n${z.prettifyError(parsed.error)}`,
      );
    }
    return {
      output: parsed.data,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
      sessionId: result.session_id,
    };
  };
}

/** Run one review. `queryFn` is swappable so tests never start Claude. */
export function createReviewer(queryFn: typeof query = query): RunReview {
  const readable = createRunner<Review>(queryFn, reviewSchema, reviewJsonSchema);
  const classic = createRunner<Review>(queryFn, classicReviewSchema, classicReviewJsonSchema);
  return async (input) => {
    const { style } = input.settings;
    const run = STYLE_SPECS[style].structured ? readable : classic;
    const { output, ...stats } = await run(input);
    return { review: output, ...stats, style };
  };
}

/** Run one follow-up review (round 2+), with the verdict schema. */
export function createFollowUpReviewer(queryFn: typeof query = query): RunFollowUp {
  const readable = createRunner<FollowUpOutput>(queryFn, followUpSchema, followUpJsonSchema);
  const classic = createRunner<FollowUpOutput>(
    queryFn,
    classicFollowUpSchema,
    classicFollowUpJsonSchema,
  );
  return (input) => (STYLE_SPECS[input.settings.style].structured ? readable : classic)(input);
}
