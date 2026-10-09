import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { type Config, EFFORTS, MODELS, STYLES } from "../config.ts";
import type { Logger } from "../log.ts";
import {
  currentSessionUsage,
  isPostingPaused,
  type Runtime,
  reviewSettings,
  setPostingPaused,
  setReviewChoice,
} from "../runtime.ts";
import { APPROVED_BY_YOU, type Job, type JobStatus, type State } from "../state.ts";
import { STYLE_SPECS } from "../styles.ts";
import type { PostedReview } from "../types.ts";
import { renderPage } from "./page.ts";

export interface StatusServerDeps {
  state: State;
  config: Config;
  runtime: Runtime;
  worker: { kick(): void; stop(jobId: number): boolean };
  log: Logger;
  /** Approve the job's PR on GitHub, overriding the posted review. Off when not given. */
  approve?: (job: Job) => Promise<PostedReview>;
  /** Tests pass 0 for a free port. */
  port?: number;
}

export interface StatusServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "reviewing",
  "reviewed",
  "posting",
  "done",
  "failed",
  "skipped",
];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: string, type: string, extra = {}): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

const reviewChoiceSchema = z.strictObject({
  model: z.enum(MODELS).optional(),
  effort: z.enum(EFFORTS).optional(),
  style: z.enum(STYLES).optional(),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new HttpError(413, "Body too large");
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
}

async function readSavedReview(job: Job): Promise<unknown> {
  if (!job.output_dir) return null;
  try {
    return JSON.parse(await readFile(join(job.output_dir, "result.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The local status page. Listens on 127.0.0.1 only. Button calls need the per-start token
 * that is only in the page itself, so other websites open in your browser cannot press them.
 */
export async function startStatusServer(deps: StatusServerDeps): Promise<StatusServer | undefined> {
  const { state, config, runtime, worker, log, approve } = deps;
  const token = randomBytes(24).toString("base64url");
  let port = deps.port ?? config.statusPage.port;

  const allowedHosts = () => new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  function jobOr404(id: string): Job {
    const job = /^\d+$/.test(id) ? state.get(Number(id)) : undefined;
    if (!job) throw new HttpError(404, `No job ${id}`);
    return job;
  }

  function act(job: Job, action: string): Job {
    let after: Job | undefined;
    switch (action) {
      case "retry": {
        // A saved review only needs posting again; otherwise review from scratch.
        const saved = job.output_dir && existsSync(join(job.output_dir, "result.json"));
        after = state.resetJob(job.id, saved ? "reviewed" : "queued", ["failed"]);
        break;
      }
      case "rereview":
        after = state.resetJob(job.id, "queued", ["done", "reviewed", "skipped", "failed"]);
        break;
      case "review-now":
        after = state.resetJob(job.id, "queued", ["skipped"]);
        break;
      case "stop":
        // The worker skips the job once Claude has stopped, a moment later.
        if (!worker.stop(job.id)) throw new HttpError(409, "That review is not running any more");
        log.info({ job: job.id, repo: job.repo, pr: job.pr, action }, "status page action");
        return job;
      default:
        throw new HttpError(404, `Unknown action ${action}`);
    }
    if (!after) throw new HttpError(409, `Can't ${action} a job that is ${job.status}`);
    log.info({ job: job.id, repo: job.repo, pr: job.pr, action }, "status page action");
    worker.kick();
    return after;
  }

  /** Only a re-requested review (a follow-up) that is posted and not yet an approval. */
  async function approveJob(job: Job): Promise<Job> {
    if (!approve) throw new HttpError(404, "Approving is not available");
    if (job.round < 2) throw new HttpError(409, "Approve is only for re-requested reviews");
    if (job.status !== "done" || job.event === "APPROVED" || job.reason === "dry-run") {
      throw new HttpError(409, `Can't approve a job that is ${job.status}`);
    }
    let posted: PostedReview;
    try {
      posted = await approve(job);
    } catch (err) {
      throw new HttpError(502, `GitHub: ${(err as Error).message}`);
    }
    state.completePublish(job.id, {
      reviewId: posted.id,
      url: posted.url,
      event: posted.state,
      reason: APPROVED_BY_YOU,
    });
    log.info({ job: job.id, repo: job.repo, pr: job.pr, url: posted.url }, "approved by you");
    return state.get(job.id) as Job;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
    if (!allowedHosts().has(req.headers.host ?? "")) throw new HttpError(403, "Bad host");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "POST") {
      if (req.headers["x-proxy-token"] !== token) throw new HttpError(403, "Missing token");
      const jobAction = /^\/api\/jobs\/([^/]+)\/([a-z-]+)$/.exec(path);
      if (jobAction?.[1] && jobAction[2] === "approve") {
        return sendJson(res, 200, await approveJob(jobOr404(jobAction[1])));
      }
      if (jobAction?.[1] && jobAction[2]) {
        return sendJson(res, 200, act(jobOr404(jobAction[1]), jobAction[2]));
      }
      if (path === "/api/posting/pause" || path === "/api/posting/resume") {
        const paused = path.endsWith("pause");
        setPostingPaused(state, paused);
        log.info({ paused }, paused ? "posting paused" : "posting resumed");
        if (!paused) worker.kick();
        return sendJson(res, 200, { postingPaused: paused });
      }
      if (path === "/api/review-settings") {
        const parsed = reviewChoiceSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        setReviewChoice(state, parsed.data);
        const { model, effort, style } = reviewSettings(state, config);
        log.info({ model, effort, style }, "review settings changed");
        return sendJson(res, 200, { model, effort, style });
      }
      throw new HttpError(404, "Not found");
    }
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

    if (path === "/") {
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, renderPage({ token, nonce }), "text/html; charset=utf-8", {
        "Content-Security-Policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      });
    }
    if (path === "/api/status") {
      const { model, effort, style } = reviewSettings(state, config);
      const counts = Object.fromEntries(
        STATUSES.map((s) => [s, state.listByStatus(s).length]).filter(([, n]) => n),
      );
      return sendJson(res, 200, {
        ...runtime,
        uptimeSec: Math.round((Date.now() - Date.parse(runtime.startedAt)) / 1000),
        postingPaused: isPostingPaused(state),
        pollIntervalSec: config.pollIntervalSec,
        publishMode: config.publish.mode,
        canApprove: Boolean(approve),
        model,
        effort,
        style,
        models: MODELS,
        efforts: EFFORTS,
        styles: STYLES.map((key) => ({ key, label: STYLE_SPECS[key].label })),
        sessionUsage: currentSessionUsage(state) ?? null,
        maxSessionUsagePct: config.review.maxSessionUsagePct,
        counts,
      });
    }
    if (path === "/api/jobs") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
      return sendJson(res, 200, state.listRecent(limit));
    }
    const jobPath = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (jobPath?.[1]) {
      const job = jobOr404(jobPath[1]);
      return sendJson(res, 200, { job, review: await readSavedReview(job) });
    }
    throw new HttpError(404, "Not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error({ err, url: req.url }, "status page error");
      sendJson(res, status, { error: (err as Error).message });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    // The page is a convenience; the reviewer keeps running without it.
    log.warn({ err, port }, "status page could not start");
    return undefined;
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  log.info({ url }, "status page ready");

  return {
    url,
    port,
    token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
