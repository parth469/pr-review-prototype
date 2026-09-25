import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { FollowUpResult, LedgerEntry } from "./followup.ts";

export const findingSchema = z.object({
  path: z.string().min(1).describe("File path relative to the repository root"),
  line: z.number().int().min(1).describe("Line number in the new version of the file"),
  endLine: z.number().int().min(1).optional().describe("Last line, for multi-line findings"),
  severity: z.enum(["bug", "risk", "nit", "question"]),
  body: z.string().min(1).describe("The problem, why it matters, and the fix"),
});

export const reviewSchema = z.object({
  summary: z.string().min(1).describe("2-4 sentence overview of the PR and the main problems"),
  verdict: z.enum(["request_changes", "no_issues"]),
  findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema> & {
  /** F1, F2... given after the run, stable across rounds so a follow-up can name each finding. */
  id?: string;
};
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
export const followUpSchema = z.object({
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
    .array(findingSchema)
    .describe("New problems, only on lines added or changed in .review/since-last.patch"),
});
export type FollowUpOutput = z.infer<typeof followUpSchema>;

// Claude Code validates --json-schema as draft-07 and rejects the 2020-12 $schema URL zod emits by default.
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...body } = z.toJSONSchema(schema, { target: "draft-7" });
  return body as Record<string, unknown>;
}
export const reviewJsonSchema = toJsonSchema(reviewSchema);
export const followUpJsonSchema = toJsonSchema(followUpSchema);

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
}

export type FollowUpRun = RunStats & { output: FollowUpOutput };

export interface RunReviewInput {
  cwd: string;
  prompt: string;
  settings: Config["review"];
  pluginPath: string;
  transcriptPath: string;
  signal?: AbortSignal;
}

export type RunReview = (input: RunReviewInput) => Promise<ReviewRun>;
export type RunFollowUp = (input: RunReviewInput) => Promise<FollowUpRun>;

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
          if (!message.skills.includes(input.settings.skill)) {
            failure = new Error(
              `Skill ${input.settings.skill} did not load. Loaded: ${message.skills.join(", ") || "none"}`,
            );
            controller.abort(failure);
            break;
          }
        } else if (message.type === "result") {
          result = message;
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
  const run = createRunner(queryFn, reviewSchema, reviewJsonSchema);
  return async (input) => {
    const { output, ...stats } = await run(input);
    return { review: output, ...stats };
  };
}

/** Run one follow-up review (round 2+), with the verdict schema. */
export function createFollowUpReviewer(queryFn: typeof query = query): RunFollowUp {
  return createRunner(queryFn, followUpSchema, followUpJsonSchema);
}
