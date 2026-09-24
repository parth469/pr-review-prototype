import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "./config.ts";

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

export type Finding = z.infer<typeof findingSchema>;
export type Review = z.infer<typeof reviewSchema>;

// Claude Code validates --json-schema as draft-07 and rejects the 2020-12 $schema URL zod emits by default.
const { $schema: _dialect, ...reviewJsonSchemaBody } = z.toJSONSchema(reviewSchema, {
  target: "draft-7",
});
export const reviewJsonSchema = reviewJsonSchemaBody as Record<string, unknown>;

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

export interface ReviewRun {
  review: Review;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  sessionId: string;
}

export interface RunReviewInput {
  cwd: string;
  prompt: string;
  settings: Config["review"];
  pluginPath: string;
  transcriptPath: string;
  signal?: AbortSignal;
}

export type RunReview = (input: RunReviewInput) => Promise<ReviewRun>;

export function buildOptions(input: RunReviewInput, abortController: AbortController): Options {
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
    outputFormat: { type: "json_schema", schema: reviewJsonSchema },
    maxTurns: settings.maxTurns,
    persistSession: false,
    env: sanitizedEnv(),
    abortController,
  };
}

/** Run one review. `queryFn` is swappable so tests never start Claude. */
export function createReviewer(queryFn: typeof query = query): RunReview {
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
      const run = queryFn({ prompt: input.prompt, options: buildOptions(input, controller) });
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

    const parsed = reviewSchema.safeParse(result.structured_output);
    if (!parsed.success) {
      throw new Error(
        `Claude returned findings in the wrong shape:\n${z.prettifyError(parsed.error)}`,
      );
    }
    return {
      review: parsed.data,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
      sessionId: result.session_id,
    };
  };
}
