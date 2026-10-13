import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { type Config, EFFORTS, HOLD_CHOICES, MODELS, STYLES } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ReviewRun } from "../reviewer.ts";
import {
  currentSessionUsage,
  holdMinutes,
  isPostingPaused,
  type Runtime,
  reviewSettings,
  setHoldMinutes,
  setPostingPaused,
  setReviewChoice,
} from "../runtime.ts";
import { APPROVED_BY_YOU, type Job, type JobStatus, type State } from "../state.ts";
import { STYLE_SPECS } from "../styles.ts";
import type { TicketContext } from "../ticket.ts";
import type { PostedReview } from "../types.ts";
import type { Chrome } from "./layout.ts";
import { renderListPage } from "./list-page.ts";
import { droppedIds, groupByPr, TABS, type Tab, toPrView } from "./prs.ts";
import { renderReviewPage } from "./review-page.ts";

export interface StatusServerDeps {
  state: State;
  config: Config;
  runtime: Runtime;
  worker: { kick(): void; stop(jobId: number): boolean };
  log: Logger;
  /** Approve the job's PR on GitHub, overriding the posted review. Off when not given. */
  approve?: (job: Job) => Promise<PostedReview>;
  /** Read the job's PR ticket from Linear's comment now. Without it Refresh only forgets it. */
  readTicket?: (job: Job) => Promise<TicketContext | undefined>;
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
  "held",
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
    // Not "no-referrer": under it browsers send `Origin: null` on our own form posts.
    "Referrer-Policy": "same-origin",
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

const dropSchema = z.strictObject({ ids: z.array(z.string().regex(/^F\d+$/)).max(200) });
const holdSchema = z.strictObject({ minutes: z.number().int().min(0) });

/** Minutes offered on the page: the usual choices plus the config default. */
const holdChoices = (config: Config) =>
  [...new Set<number>([...HOLD_CHOICES, config.publish.holdMin])].sort((a, b) => a - b);

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

/** A form post: urlencoded fields. */
async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new HttpError(413, "Body too large");
  }
  return new URLSearchParams(text);
}

/** Where a form goes back to: a path on this server only, never another site. */
const safeBack = (back: string | null) => (back && /^\/(?![/\\])[^\s\\]*$/.test(back) ? back : "/");

const sameToken = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A page's content policy: only its own nonce'd style and script, forms only to this server. */
const pagePolicy = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
  "img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
  const { state, config, runtime, worker, log, approve, readTicket } = deps;
  const token = randomBytes(24).toString("base64url");
  let port = deps.port ?? config.statusPage.port;

  const allowedHosts = () => new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));
  // An action's error, shown once on the page it redirects to. Keyed by a random id so a link
  // from elsewhere can't put words on the page.
  const flashes = new Map<string, string>();
  function flash(message: string): string {
    const id = randomBytes(8).toString("hex");
    flashes.set(id, message);
    if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
    return id;
  }

  function jobOr404(id: string): Job {
    const job = /^\d+$/.test(id) ? state.get(Number(id)) : undefined;
    if (!job) throw new HttpError(404, `No job ${id}`);
    return job;
  }

  async function act(job: Job, action: string): Promise<Job> {
    let after: Job | undefined;
    switch (action) {
      case "retry": {
        // A saved review only needs posting again; otherwise review from scratch.
        const saved = job.output_dir && existsSync(join(job.output_dir, "result.json"));
        after = state.resetJob(job.id, saved ? "reviewed" : "queued", ["failed"]);
        break;
      }
      case "rereview":
        after = state.resetJob(job.id, "queued", ["done", "reviewed", "held", "skipped", "failed"]);
        break;
      // A review waiting for your OK: post it now, take your time, or post nothing.
      case "post":
        after = state.release(job.id);
        break;
      case "handle":
        after = state.holdForYou(job.id);
        if (after) {
          log.info({ job: job.id, repo: job.repo, pr: job.pr, action }, "status page action");
          return after;
        }
        break;
      case "discard":
        after = state.discard(job.id);
        break;
      case "review-now":
        after = state.resetJob(job.id, "queued", ["skipped"]);
        break;
      case "refresh-ticket":
        await refreshTicket(job);
        log.info({ job: job.id, repo: job.repo, pr: job.pr, action }, "status page action");
        return job;
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

  /**
   * Read the PR's ticket from Linear's comment again and save it. The saved one stays when the
   * read fails or finds none, so the page never loses a ticket it had.
   */
  async function refreshTicket(job: Job): Promise<void> {
    if (!readTicket) {
      // Forget the saved ticket: the next review reads it from Linear's comment again.
      if (!state.clearTicket(job.repo, job.pr))
        throw new HttpError(409, "No saved ticket to refresh");
      return;
    }
    let ticket: TicketContext | undefined;
    try {
      ticket = await readTicket(job);
    } catch (err) {
      throw new HttpError(502, `Could not read the ticket: ${(err as Error).message}`);
    }
    if (!ticket) throw new HttpError(409, "No ticket found in Linear's comment on the PR");
    state.saveTicket(job.repo, job.pr, ticket, new Date());
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

  /** The F-ids you dropped from a held review; only its new findings can be dropped. */
  async function dropFindings(job: Job, body: unknown): Promise<Job> {
    const parsed = dropSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    if (job.status !== "held") throw new HttpError(409, `Can't change a job that is ${job.status}`);
    const run = (await readSavedReview(job)) as { review?: { findings?: { id?: string }[] } };
    const known = new Set((run?.review?.findings ?? []).map((f) => f.id));
    const unknown = parsed.data.ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new HttpError(400, `Not a new finding: ${unknown.join(", ")}`);
    const ids = [...new Set(parsed.data.ids)];
    const after = state.setDropped(job.id, ids);
    if (!after) throw new HttpError(409, "That review is not waiting any more");
    log.info({ job: job.id, repo: job.repo, pr: job.pr, dropped: ids }, "findings dropped");
    return after;
  }

  function chromeFor(url: URL): Chrome {
    const { model, effort, style } = reviewSettings(state, config);
    const flashId = url.searchParams.get("flash");
    const error = flashId ? (flashes.get(flashId) ?? null) : null;
    if (flashId) flashes.delete(flashId);
    const back = new URL(url);
    back.searchParams.delete("flash");
    return {
      token,
      nonce: randomBytes(16).toString("base64"),
      back: back.pathname + back.search,
      error,
      now: new Date(),
      viewer: runtime.viewer,
      lastPollAt: runtime.lastPollAt,
      lastPollError: runtime.lastPollError,
      pollIntervalSec: config.pollIntervalSec,
      postingPaused: isPostingPaused(state),
      publishMode: config.publish.mode,
      sessionUsage: currentSessionUsage(state) ?? null,
      maxSessionUsagePct: config.review.maxSessionUsagePct ?? null,
      picks: {
        model,
        effort,
        style,
        holdMin: holdMinutes(state, config),
        models: MODELS,
        efforts: EFFORTS,
        styles: STYLES.map((key) => ({ key, label: STYLE_SPECS[key].label })),
        holdChoices: holdChoices(config),
      },
    };
  }

  function sendPage(res: ServerResponse, chrome: Chrome, body: string): void {
    send(res, 200, body, "text/html; charset=utf-8", {
      "Content-Security-Policy": pagePolicy(chrome.nonce),
      "X-Frame-Options": "DENY",
    });
  }

  /**
   * A button on a page: a form post with the token in a field. Afterwards the browser goes back
   * to the page it came from, with the error if the action failed.
   */
  async function handleForm(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    // A form from another site sends its own Origin; the token is the second fence.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin))
      throw new HttpError(403, "Bad origin");
    const form = await readFormBody(req);
    if (!sameToken(form.get("token"), token)) throw new HttpError(403, "Missing token");
    const back = safeBack(form.get("back"));
    let location = back;
    try {
      await formAction(path, form);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      const to = new URL(back, "http://x");
      to.searchParams.set("flash", flash(err.message));
      location = to.pathname + to.search;
    }
    res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
    res.end();
  }

  async function formAction(path: string, form: URLSearchParams): Promise<void> {
    const jobAction = /^\/do\/jobs\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (jobAction?.[1] && jobAction[2]) {
      const job = jobOr404(jobAction[1]);
      if (jobAction[2] === "approve") {
        await approveJob(job);
        return;
      }
      if (jobAction[2] === "drop") {
        const id = form.get("id") ?? "";
        const others = droppedIds(job).filter((d) => d !== id);
        await dropFindings(job, { ids: form.get("dropped") === "1" ? [...others, id] : others });
        return;
      }
      await act(job, jobAction[2]);
      return;
    }
    if (path === "/do/posting/pause" || path === "/do/posting/resume") {
      const paused = path.endsWith("pause");
      setPostingPaused(state, paused);
      log.info({ paused }, paused ? "posting paused" : "posting resumed");
      if (!paused) worker.kick();
      return;
    }
    if (path === "/do/settings") {
      const field = (k: string) => form.get(k) || undefined;
      const parsed = reviewChoiceSchema.safeParse({
        model: field("model"),
        effort: field("effort"),
        style: field("style"),
      });
      if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
      const hold = form.get("hold");
      const minutes = hold === null ? null : Number(hold);
      if (minutes !== null && !holdChoices(config).includes(minutes)) {
        throw new HttpError(400, `Pick one of ${holdChoices(config).join(", ")} minutes`);
      }
      setReviewChoice(state, parsed.data);
      if (minutes !== null) setHoldMinutes(state, minutes);
      log.info({ ...parsed.data, holdMin: minutes }, "review settings changed");
      return;
    }
    throw new HttpError(404, "Not found");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
    if (!allowedHosts().has(req.headers.host ?? "")) throw new HttpError(403, "Bad host");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "POST" && path.startsWith("/do/")) return handleForm(req, res, path);
    if (req.method === "POST") {
      if (!sameToken(req.headers["x-proxy-token"] as string | undefined, token))
        throw new HttpError(403, "Missing token");
      const jobAction = /^\/api\/jobs\/([^/]+)\/([a-z-]+)$/.exec(path);
      if (jobAction?.[1] && jobAction[2] === "approve") {
        return sendJson(res, 200, await approveJob(jobOr404(jobAction[1])));
      }
      if (jobAction?.[1] && jobAction[2] === "drop") {
        const job = jobOr404(jobAction[1]);
        return sendJson(res, 200, await dropFindings(job, await readJsonBody(req)));
      }
      if (jobAction?.[1] && jobAction[2]) {
        return sendJson(res, 200, await act(jobOr404(jobAction[1]), jobAction[2]));
      }
      if (path === "/api/posting/pause" || path === "/api/posting/resume") {
        const paused = path.endsWith("pause");
        setPostingPaused(state, paused);
        log.info({ paused }, paused ? "posting paused" : "posting resumed");
        if (!paused) worker.kick();
        return sendJson(res, 200, { postingPaused: paused });
      }
      if (path === "/api/hold") {
        const parsed = holdSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        if (!holdChoices(config).includes(parsed.data.minutes)) {
          throw new HttpError(400, `Pick one of ${holdChoices(config).join(", ")} minutes`);
        }
        setHoldMinutes(state, parsed.data.minutes);
        log.info({ minutes: parsed.data.minutes }, "hold time changed");
        return sendJson(res, 200, { holdMin: parsed.data.minutes });
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
      const asked = url.searchParams.get("tab");
      const tab: Tab = TABS.includes(asked as Tab) ? (asked as Tab) : "needs";
      const chrome = chromeFor(url);
      const prs = groupByPr(state.listRecent(500));
      const tickets = new Map<string, string[]>();
      if (config.ticket.enabled && tab === "needs") {
        for (const pr of prs) {
          const ids = state.getTicket(pr.repo, pr.pr)?.tickets.map((t) => t.id) ?? [];
          if (ids.length) tickets.set(`${pr.repo}#${pr.pr}`, ids);
        }
      }
      return sendPage(res, chrome, renderListPage({ chrome, tab, prs, tickets }));
    }
    const prPage = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
    if (prPage?.[1] && prPage[2] && prPage[3]) {
      const repo = `${decodeURIComponent(prPage[1])}/${decodeURIComponent(prPage[2])}`;
      const jobs = state.listForPr(repo, Number(prPage[3]));
      if (!jobs.length) throw new HttpError(404, "No reviews for that PR");
      const pr = toPrView(jobs);
      const runs = new Map<number, ReviewRun | null>();
      for (const job of pr.rounds)
        runs.set(job.id, (await readSavedReview(job)) as ReviewRun | null);
      // ?job=<id> (from a notification) or ?round=<n> opens that round.
      const byJob = pr.rounds.findIndex((j) => String(j.id) === url.searchParams.get("job"));
      const round = byJob >= 0 ? byJob + 1 : Number(url.searchParams.get("round")) || null;
      const chrome = chromeFor(url);
      return sendPage(
        res,
        chrome,
        renderReviewPage({
          chrome,
          pr,
          runs,
          ticket: config.ticket.enabled ? (state.getTicket(pr.repo, pr.pr) ?? null) : undefined,
          openRound: round,
          canApprove: Boolean(approve),
        }),
      );
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
        holdMin: holdMinutes(state, config),
        holdChoices: holdChoices(config),
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
      return sendJson(res, 200, {
        job,
        review: await readSavedReview(job),
        // Left out when tickets are off, so the page shows nothing about them.
        ticket: config.ticket.enabled ? (state.getTicket(job.repo, job.pr) ?? null) : undefined,
      });
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
