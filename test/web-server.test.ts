import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { createRuntime, holdMinutes, isPostingPaused } from "../src/runtime.ts";
import { openState, type State } from "../src/state.ts";
import { type StatusServer, startStatusServer } from "../src/web/server.ts";
import { silentLog } from "./helpers.ts";

// fetch() can't send a forged Host header, so use node:http directly.
function call(
  port: number,
  path: string,
  {
    method = "GET",
    token,
    host,
    body,
  }: { method?: string; token?: string; host?: string; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Host: host ?? `127.0.0.1:${port}`,
          ...(token ? { "X-Proxy-Token": token } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("status server", () => {
  let state: State;
  let server: StatusServer;
  let kicks: number;
  let running: Set<number>;
  let approved: number[];
  let dir: string;

  const seed = (pr: number) =>
    state.recordSeen({
      repo: "acme/api",
      pr,
      headSha: `sha${pr}`,
      title: `PR ${pr}`,
      url: `https://github.com/acme/api/pull/${pr}`,
      decision: { action: "queue" },
    });

  beforeEach(async () => {
    state = openState(":memory:");
    dir = mkdtempSync(join(tmpdir(), "proxy-web-"));
    kicks = 0;
    running = new Set();
    approved = [];
    const started = await startStatusServer({
      state,
      config: parseConfig({}),
      runtime: createRuntime("me"),
      worker: { kick: () => void kicks++, stop: (id) => running.delete(id) },
      log: silentLog,
      approve: async (job) => {
        approved.push(job.id);
        return { id: 99, url: "https://github.com/acme/api/pull/1#r99", state: "APPROVED" };
      },
      port: 0,
    });
    if (!started) throw new Error("server did not start");
    server = started;
  });
  afterEach(async () => {
    await server.close();
    state.close();
  });

  it("serves the page with the token and a strict content policy", async () => {
    const res = await call(server.port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(`var TOKEN = "${server.token}";`);
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a request for another host name (DNS rebinding)", async () => {
    const res = await call(server.port, "/api/jobs", { host: "evil.example:4777" });
    expect(res.status).toBe(403);
  });

  it("refuses button calls without the token", async () => {
    expect((await call(server.port, "/api/posting/pause", { method: "POST" })).status).toBe(403);
    expect(
      (await call(server.port, "/api/posting/pause", { method: "POST", token: "wrong" })).status,
    ).toBe(403);
    expect(isPostingPaused(state)).toBe(false);
  });

  it("pauses and resumes posting, and resume wakes the worker", async () => {
    const post = (p: string) => call(server.port, p, { method: "POST", token: server.token });
    expect(JSON.parse((await post("/api/posting/pause")).body)).toEqual({ postingPaused: true });
    expect(isPostingPaused(state)).toBe(true);
    const status = JSON.parse((await call(server.port, "/api/status")).body);
    expect(status).toMatchObject({ viewer: "me", postingPaused: true });
    await post("/api/posting/resume");
    expect(isPostingPaused(state)).toBe(false);
    expect(kicks).toBe(1);
  });

  it("lists recent jobs and shows one with its saved review", async () => {
    seed(1);
    seed(2);
    const job = state.claimNext();
    if (!job) throw new Error("no job");
    const out = join(dir, "r1");
    mkdirSync(out);
    writeFileSync(
      join(out, "result.json"),
      JSON.stringify({ review: { summary: "s", verdict: "no_issues", findings: [] } }),
    );
    state.completeReview(job.id, { findings: 0, outputDir: out, costUsd: 0.1, durationMs: 1 });

    const list = JSON.parse((await call(server.port, "/api/jobs")).body);
    expect(list.map((j: { pr: number }) => j.pr)).toEqual([1, 2]); // most recently updated first
    const detail = JSON.parse((await call(server.port, `/api/jobs/${job.id}`)).body);
    expect(detail.review.review.summary).toBe("s");
    expect((await call(server.port, "/api/jobs/999")).status).toBe(404);
  });

  it("retries a failed job: post again when a review is saved, review again when not", async () => {
    seed(1);
    seed(2);
    const withReview = state.claimNext();
    const without = state.claimNext();
    if (!withReview || !without) throw new Error("no jobs");
    const out = join(dir, "saved");
    mkdirSync(out);
    writeFileSync(join(out, "result.json"), "{}");
    state.completeReview(withReview.id, { findings: 1, outputDir: out, costUsd: 0, durationMs: 0 });
    state.claimNext();
    state.failAttempt(withReview.id, "502", 1, { retryStatus: "reviewed" });
    state.failAttempt(without.id, "boom", 1);

    const post = (id: number, a: string) =>
      call(server.port, `/api/jobs/${id}/${a}`, { method: "POST", token: server.token });
    expect(JSON.parse((await post(withReview.id, "retry")).body)).toMatchObject({
      status: "reviewed",
      attempts: 0,
      error: null,
    });
    expect(JSON.parse((await post(without.id, "retry")).body)).toMatchObject({ status: "queued" });
    expect(kicks).toBe(2);
    // Retry only applies to failed jobs.
    expect((await post(without.id, "retry")).status).toBe(409);
  });

  it("re-reviews a finished job and reviews a skipped one now", async () => {
    state.recordSeen({
      repo: "acme/api",
      pr: 5,
      headSha: "d",
      title: "Draft",
      url: "u",
      decision: { action: "skip", reason: "draft" },
    });
    const skipped = state.listByStatus("skipped")[0];
    if (!skipped) throw new Error("no job");
    const post = (a: string) =>
      call(server.port, `/api/jobs/${skipped.id}/${a}`, { method: "POST", token: server.token });

    expect((await post("rereview")).status).toBe(200); // skipped can be re-reviewed too
    expect(state.get(skipped.id)?.status).toBe("queued");
    expect((await post("review-now")).status).toBe(409); // no longer skipped
    expect((await post("explode")).status).toBe(404);
  });

  it("stops a running review, and says so when it is not running", async () => {
    seed(1);
    const job = state.claimNext();
    if (!job) throw new Error("no job");
    running.add(job.id);
    const stop = () =>
      call(server.port, `/api/jobs/${job.id}/stop`, { method: "POST", token: server.token });
    expect((await stop()).status).toBe(200);
    expect(running.has(job.id)).toBe(false);
    expect((await stop()).status).toBe(409);
  });

  it("shows the PR's saved ticket and forgets it on Refresh ticket", async () => {
    seed(1);
    const job = state.claimNext();
    if (!job) throw new Error("no job");
    const detail = async () =>
      JSON.parse((await call(server.port, `/api/jobs/${job.id}`)).body) as { ticket: unknown };
    expect((await detail()).ticket).toBeNull();

    const ticket = {
      tickets: [{ id: "ACME-1", title: "t", url: "u", description: "d", templateOnly: false }],
      truncated: false,
    };
    state.saveTicket("acme/api", 1, ticket, new Date());
    expect((await detail()).ticket).toEqual(ticket);

    const refresh = () =>
      call(server.port, `/api/jobs/${job.id}/refresh-ticket`, {
        method: "POST",
        token: server.token,
      });
    expect((await refresh()).status).toBe(200);
    expect(state.getTicket("acme/api", 1)).toBeUndefined();
    expect((await refresh()).status).toBe(409);
  });

  it("approves a posted re-requested review, and nothing else", async () => {
    // Round 1, posted as a request for changes.
    seed(1);
    const first = state.claimNext();
    if (!first) throw new Error("no job");
    state.completePublish(first.id, { reviewId: 1, url: "u1", event: "CHANGES_REQUESTED" });
    // The author pushed again and re-requested: round 2, posted as a comment.
    state.recordSeen({
      repo: "acme/api",
      pr: 1,
      headSha: "sha1b",
      title: "PR 1",
      url: "u",
      decision: { action: "queue" },
    });
    const claimed = state.claimNext();
    if (!claimed) throw new Error("no job");
    const second = state.linkParent(claimed.id);
    expect(second?.round).toBe(2);
    state.completePublish(claimed.id, { reviewId: 2, url: "u2", event: "COMMENTED" });

    const approve = (id: number) =>
      call(server.port, `/api/jobs/${id}/approve`, { method: "POST", token: server.token });
    expect((await approve(first.id)).status).toBe(409); // round 1: not a re-request
    const res = await approve(claimed.id);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "done",
      event: "APPROVED",
      review_id: 99,
      reason: "approved by you",
    });
    expect((await approve(claimed.id)).status).toBe(409); // already approved
    expect(approved).toEqual([claimed.id]);
  });

  it("picks the model, effort and style for the next review, and refuses anything else", async () => {
    const set = (body: unknown) =>
      call(server.port, "/api/review-settings", {
        method: "POST",
        token: server.token,
        body: JSON.stringify(body),
      });
    const status = async () => JSON.parse((await call(server.port, "/api/status")).body);
    expect(await status()).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      efforts: ["low", "medium", "high"],
      style: "readable",
      styles: [
        { key: "readable", label: "New skill + new format" },
        { key: "caveman-readable", label: "Caveman + new format" },
        { key: "caveman-classic", label: "Caveman + old format" },
      ],
      sessionUsage: null,
    });

    expect(JSON.parse((await set({ model: "claude-sonnet-5-5" })).body)).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
      style: "readable",
    });
    await set({ effort: "low" });
    await set({ style: "caveman-classic" });
    const picked = { model: "claude-sonnet-5-5", effort: "low", style: "caveman-classic" };
    expect(await status()).toMatchObject(picked);

    expect((await set({ effort: "max" })).status).toBe(400);
    expect((await set({ model: "gpt-5" })).status).toBe(400);
    expect((await set({ style: "terse" })).status).toBe(400);
    expect(await status()).toMatchObject(picked);
  });

  describe("a review waiting for your OK", () => {
    const post = (p: string, body?: unknown) =>
      call(server.port, p, {
        method: "POST",
        token: server.token,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const heldJob = () => {
      seed(1);
      const job = state.claimNext();
      if (!job) throw new Error("no job");
      const out = join(dir, "held");
      mkdirSync(out, { recursive: true });
      const findings = ["F1", "F2", "F3"].map((id) => ({
        id,
        path: "a",
        line: 1,
        severity: "bug",
      }));
      writeFileSync(
        join(out, "result.json"),
        JSON.stringify({ review: { summary: "s", verdict: "request_changes", findings } }),
      );
      state.completeReview(job.id, { findings: 3, outputDir: out, costUsd: 1, durationMs: 1 });
      state.claimNext();
      state.hold(job.id, new Date(Date.now() + 30 * 60_000));
      return job.id;
    };

    it("posts it now and wakes the worker", async () => {
      const id = heldJob();
      const res = await post(`/api/jobs/${id}/post`);
      expect(JSON.parse(res.body)).toMatchObject({ status: "reviewed", released: "you" });
      expect(kicks).toBe(1);
      expect((await post(`/api/jobs/${id}/post`)).status).toBe(409);
    });

    it("stops the timer when you'll handle it", async () => {
      const id = heldJob();
      expect(JSON.parse((await post(`/api/jobs/${id}/handle`)).body)).toMatchObject({
        status: "held",
        hold_until: null,
      });
      expect((await post(`/api/jobs/${id}/handle`)).status).toBe(409);
    });

    it("discards it", async () => {
      const id = heldJob();
      expect(JSON.parse((await post(`/api/jobs/${id}/discard`)).body)).toMatchObject({
        status: "skipped",
        reason: "discarded by you",
      });
    });

    it("keeps the findings you drop, and only real new findings", async () => {
      const id = heldJob();
      const res = await post(`/api/jobs/${id}/drop`, { ids: ["F2", "F2", "F3"] });
      expect(JSON.parse(res.body).dropped).toBe('["F2","F3"]');
      expect((await post(`/api/jobs/${id}/drop`, { ids: ["F9"] })).status).toBe(400);
      expect((await post(`/api/jobs/${id}/drop`, { ids: ["<b>"] })).status).toBe(400);
      expect((await post(`/api/jobs/${id}/drop`, { ids: [] })).status).toBe(200);
      expect(state.get(id)?.dropped).toBeNull();
      state.release(id);
      expect((await post(`/api/jobs/${id}/drop`, { ids: ["F1"] })).status).toBe(409);
    });

    it("can be re-reviewed", async () => {
      const id = heldJob();
      expect(JSON.parse((await post(`/api/jobs/${id}/rereview`)).body).status).toBe("queued");
    });
  });

  it("picks how long Request changes waits, and refuses other values", async () => {
    const post = (body: unknown) =>
      call(server.port, "/api/hold", {
        method: "POST",
        token: server.token,
        body: JSON.stringify(body),
      });
    let status = JSON.parse((await call(server.port, "/api/status")).body);
    expect(status).toMatchObject({ holdMin: 30, holdChoices: [0, 15, 30, 60, 120] });
    expect(JSON.parse((await post({ minutes: 0 })).body)).toEqual({ holdMin: 0 });
    expect(holdMinutes(state, parseConfig({}))).toBe(0);
    expect((await post({ minutes: 7 })).status).toBe(400);
    expect((await post({ minutes: "30" })).status).toBe(400);
    status = JSON.parse((await call(server.port, "/api/status")).body);
    expect(status.holdMin).toBe(0);
  });

  it("gives up quietly when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    const second = await startStatusServer({
      state,
      config: parseConfig({}),
      runtime: createRuntime("me"),
      worker: { kick: () => undefined, stop: () => false },
      log: silentLog,
      port,
    });
    expect(second).toBeUndefined();
    blocker.close();
  });
});
