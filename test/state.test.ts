import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openState, type SeenInput, type State } from "../src/state.ts";

const base: SeenInput = {
  repo: "acme/api",
  pr: 128,
  headSha: "3f9c2e1",
  title: "Add session refresh",
  url: "https://github.com/acme/api/pull/128",
  decision: { action: "queue" },
};

describe("state", () => {
  let state: State;
  beforeEach(() => {
    state = openState(":memory:");
  });
  afterEach(() => state.close());

  describe("recordSeen", () => {
    it("records a commit once", () => {
      expect(state.recordSeen(base)).toBe("new");
      expect(state.recordSeen(base)).toBe("known");
      expect(state.listByStatus("queued")).toHaveLength(1);
    });

    it("supersedes a waiting older commit when a new head SHA arrives", () => {
      state.recordSeen(base);
      expect(state.recordSeen({ ...base, headSha: "9aa01bc" })).toBe("new");
      expect(state.listByStatus("queued").map((j) => j.head_sha)).toEqual(["9aa01bc"]);
      expect(state.listByStatus("skipped")[0]).toMatchObject({
        head_sha: "3f9c2e1",
        reason: "superseded",
      });
    });

    it("requeues a skipped job that became eligible", () => {
      state.recordSeen({ ...base, decision: { action: "skip", reason: "draft" } });
      expect(state.listByStatus("skipped")[0]?.reason).toBe("draft");

      expect(state.recordSeen(base)).toBe("requeued");
      expect(state.listByStatus("skipped")).toHaveLength(0);
      expect(state.listByStatus("queued")[0]?.reason).toBeNull();
    });

    it("does not requeue a queued job that is now skipped", () => {
      state.recordSeen(base);
      const result = state.recordSeen({ ...base, decision: { action: "skip", reason: "draft" } });
      expect(result).toBe("known");
      expect(state.listByStatus("queued")).toHaveLength(1);
    });
  });

  describe("job lifecycle", () => {
    it("claims the oldest ready job exactly once", () => {
      state.recordSeen(base);
      state.recordSeen({ ...base, pr: 129 });
      expect(state.claimNext()?.pr).toBe(128);
      expect(state.claimNext()?.pr).toBe(129);
      expect(state.claimNext()).toBeUndefined();
      expect(state.listByStatus("preparing")).toHaveLength(2);
    });

    it("retries with backoff, then gives up", () => {
      state.recordSeen(base);
      const t0 = new Date("2026-09-24T10:00:00Z");
      const job = state.claimNext(t0);
      if (!job) throw new Error("no job");

      const first = state.failAttempt(job.id, "boom", 3, { now: t0 });
      expect(first).toMatchObject({ status: "queued", attempts: 1, error: "boom" });
      expect(first.next_attempt_at).toBe("2026-09-24T10:05:00.000Z");

      // Not ready before the retry time, ready after it.
      expect(state.claimNext(new Date("2026-09-24T10:04:00Z"))).toBeUndefined();
      expect(state.claimNext(new Date("2026-09-24T10:05:00Z"))?.id).toBe(job.id);

      const second = state.failAttempt(job.id, "boom", 3, { now: t0 });
      expect(second.next_attempt_at).toBe("2026-09-24T10:20:00.000Z");
      state.claimNext(new Date("2026-09-24T11:00:00Z"));
      expect(state.failAttempt(job.id, "boom", 3, { now: t0 })).toMatchObject({
        status: "failed",
        attempts: 3,
      });
    });

    it("records a finished review", () => {
      state.recordSeen(base);
      const job = state.claimNext();
      if (!job) throw new Error("no job");
      state.completeReview(job.id, {
        findings: 4,
        outputDir: "/r/x",
        costUsd: 1.25,
        durationMs: 90_000,
      });
      expect(state.get(job.id)).toMatchObject({
        status: "reviewed",
        findings: 4,
        cost_usd: 1.25,
        output_dir: "/r/x",
      });
    });

    it("puts crashed jobs back in the queue", () => {
      state.recordSeen(base);
      const job = state.claimNext();
      if (!job) throw new Error("no job");
      state.setStatus(job.id, "reviewing");
      expect(state.recoverStale()).toBe(1);
      expect(state.get(job.id)?.status).toBe("queued");
    });

    describe("publishing", () => {
      const reviewedJob = () => {
        state.recordSeen(base);
        const job = state.claimNext();
        if (!job) throw new Error("no job");
        state.setStatus(job.id, "reviewing");
        state.failAttempt(job.id, "flaky", 3); // an earlier review attempt failed
        state.claimById(job.id);
        state.completeReview(job.id, { findings: 2, outputDir: "/r", costUsd: 1, durationMs: 1 });
        return job.id;
      };

      it("gives a reviewed job a fresh attempt budget and claims it for posting", () => {
        const id = reviewedJob();
        expect(state.get(id)).toMatchObject({ status: "reviewed", attempts: 0, error: null });
        expect(state.claimNext()).toMatchObject({ id, status: "posting" });
      });

      it("retries a failed post as reviewed, so Claude does not run again", () => {
        const id = reviewedJob();
        state.claimNext();
        const t0 = new Date("2026-09-24T10:00:00Z");
        const after = state.failAttempt(id, "502", 3, { now: t0, retryStatus: "reviewed" });
        expect(after).toMatchObject({ status: "reviewed", attempts: 1 });
        expect(state.claimNext(new Date("2026-09-24T10:01:00Z"))).toBeUndefined();
        expect(state.claimNext(new Date("2026-09-24T10:06:00Z"))?.status).toBe("posting");
      });

      it("records the posted review", () => {
        const id = reviewedJob();
        state.claimNext();
        state.completePublish(id, { reviewId: 77, url: "https://r", event: "CHANGES_REQUESTED" });
        expect(state.get(id)).toMatchObject({
          status: "done",
          review_id: 77,
          review_url: "https://r",
          event: "CHANGES_REQUESTED",
          reason: null,
        });
      });

      it("resumes an interrupted post as reviewed", () => {
        const id = reviewedJob();
        state.claimNext();
        expect(state.recoverStale()).toBe(1);
        expect(state.get(id)?.status).toBe("reviewed");
      });
    });

    it("enqueues by hand and resets a finished job", () => {
      const job = state.enqueue(base);
      expect(job.status).toBe("queued");
      state.claimById(job.id);
      state.completeReview(job.id, { findings: 0, outputDir: "x", costUsd: 0, durationMs: 0 });
      expect(state.enqueue(base)).toMatchObject({ id: job.id, status: "queued", attempts: 0 });
    });

    it("claims a specific job by id only when it is queued", () => {
      const job = state.enqueue(base);
      expect(state.claimById(job.id)?.status).toBe("preparing");
      expect(state.claimById(job.id)).toBeUndefined();
    });

    it("leaves reviewed jobs alone while posting is paused", () => {
      state.recordSeen(base);
      state.recordSeen({ ...base, pr: 129 });
      const first = state.claimNext();
      if (!first) throw new Error("no job");
      state.completeReview(first.id, { findings: 1, outputDir: "/r", costUsd: 0, durationMs: 0 });

      // Paused: skips the reviewed job and takes the next review instead.
      expect(state.claimNext(undefined, { skipPosting: true })?.pr).toBe(129);
      expect(state.claimNext(undefined, { skipPosting: true })).toBeUndefined();
      expect(state.claimNext()).toMatchObject({ id: first.id, status: "posting" });
    });
  });

  describe("hold for your OK", () => {
    const t0 = new Date("2026-10-09T10:00:00Z");
    const later = (min: number) => new Date(t0.getTime() + min * 60_000);
    const heldJob = (until: Date | null = later(30)) => {
      state.recordSeen(base);
      const job = state.claimNext(t0);
      if (!job) throw new Error("no job");
      state.completeReview(job.id, { findings: 2, outputDir: "/r", costUsd: 1, durationMs: 1 });
      state.claimNext(t0);
      state.hold(job.id, until, t0);
      return job.id;
    };

    it("waits until the timer runs out, then posts as released by the timer", () => {
      const id = heldJob();
      expect(state.get(id)).toMatchObject({
        status: "held",
        reason: "needs your OK",
        hold_until: later(30).toISOString(),
        released: null,
      });
      expect(state.claimNext(later(29))).toBeUndefined();
      expect(state.claimNext(later(30))).toMatchObject({
        id,
        status: "posting",
        released: "timer",
      });
    });

    it("never times out a review you said you'd handle", () => {
      const id = heldJob();
      expect(state.holdForYou(id)).toMatchObject({ status: "held", hold_until: null });
      expect(state.claimNext(later(600))).toBeUndefined();
      expect(state.holdForYou(id)).toBeUndefined(); // no timer left to stop
    });

    it("posts at once when you press Post", () => {
      const id = heldJob(null);
      expect(state.release(id)).toMatchObject({ status: "reviewed", released: "you" });
      expect(state.claimNext(t0)).toMatchObject({ id, status: "posting", released: "you" });
      expect(state.release(id)).toBeUndefined(); // not held any more
    });

    it("discards a held review", () => {
      const id = heldJob();
      expect(state.discard(id)).toMatchObject({ status: "skipped", reason: "discarded by you" });
      expect(state.claimNext(later(60))).toBeUndefined();
    });

    it("keeps the findings you drop, only while held", () => {
      const id = heldJob();
      expect(state.setDropped(id, ["F2"])?.dropped).toBe('["F2"]');
      expect(state.setDropped(id, [])?.dropped).toBeNull();
      state.release(id);
      expect(state.setDropped(id, ["F1"])).toBeUndefined();
    });

    it("leaves held reviews alone while posting is paused", () => {
      heldJob();
      expect(state.claimNext(later(60), { skipPosting: true })).toBeUndefined();
    });

    it("drops a held review when a newer commit arrives", () => {
      const id = heldJob();
      state.recordSeen({ ...base, headSha: "9999999" });
      expect(state.get(id)).toMatchObject({ status: "skipped", reason: "superseded" });
    });

    it("keeps your OK and drops when a failed post is retried", () => {
      const id = heldJob();
      state.setDropped(id, ["F1"]);
      state.release(id);
      state.claimNext(t0);
      state.failAttempt(id, "502", 1, { retryStatus: "reviewed" });
      expect(state.resetJob(id, "reviewed", ["failed"])).toMatchObject({
        status: "reviewed",
        released: "you",
        dropped: '["F1"]',
      });
    });

    it("forgets the hold and the drops on a re-review", () => {
      const id = heldJob();
      state.setDropped(id, ["F1"]);
      expect(state.resetJob(id, "queued", ["held"])).toMatchObject({
        status: "queued",
        hold_until: null,
        released: null,
        dropped: null,
      });
    });
  });

  describe("status page helpers", () => {
    it("resets a job only from the allowed statuses", () => {
      state.recordSeen(base);
      const job = state.claimNext();
      if (!job) throw new Error("no job");
      state.failAttempt(job.id, "boom", 1);
      expect(state.resetJob(job.id, "queued", ["done"])).toBeUndefined();
      expect(state.resetJob(job.id, "queued", ["failed"])).toMatchObject({
        status: "queued",
        attempts: 0,
        error: null,
        next_attempt_at: null,
      });
      expect(state.resetJob(999, "queued", ["failed"])).toBeUndefined();
    });

    it("lists the most recently updated jobs first", async () => {
      state.recordSeen(base);
      state.recordSeen({ ...base, pr: 129 });
      state.recordSeen({ ...base, pr: 130 });
      const first = state.listByStatus("queued")[0];
      if (!first) throw new Error("no job");
      await new Promise((r) => setTimeout(r, 5)); // a later timestamp than the inserts
      state.skip(first.id, "draft"); // touch the oldest
      const recent = state.listRecent(2).map((j) => j.pr);
      expect(recent[0]).toBe(128);
      expect(recent).toHaveLength(2);
    });

    it("stores settings", () => {
      expect(state.getSetting("posting_paused")).toBeUndefined();
      state.setSetting("posting_paused", "true");
      state.setSetting("posting_paused", "false");
      expect(state.getSetting("posting_paused")).toBe("false");
    });
  });

  describe("follow-up rounds", () => {
    let state: State;
    beforeEach(() => {
      state = openState(":memory:");
    });
    afterEach(() => state.close());

    /** Record a commit and take it all the way to a posted review. */
    function post(headSha: string, reviewId: number | null = 900) {
      state.recordSeen({ ...base, headSha });
      const job = state.claimNext();
      if (!job) throw new Error("nothing to claim");
      state.completeReview(job.id, { findings: 1, outputDir: "o", costUsd: 1, durationMs: 1 });
      state.claimById(job.id);
      state.completePublish(job.id, { reviewId, url: "u", event: "CHANGES_REQUESTED" });
      return state.get(job.id);
    }

    it("makes a new commit on a PR with a posted review a follow-up", () => {
      const first = post("aaa1111");
      expect(first).toMatchObject({ round: 1, parent_job_id: null });
      state.recordSeen({ ...base, headSha: "bbb2222" });
      const second = state.listByStatus("queued")[0];
      expect(second).toMatchObject({ round: 2, parent_job_id: first?.id });

      const secondPosted = post("ccc3333");
      expect(secondPosted).toMatchObject({ round: 2, parent_job_id: first?.id });
    });

    it("counts rounds along the chain", () => {
      post("aaa1111");
      const two = post("bbb2222");
      state.recordSeen({ ...base, headSha: "ccc3333" });
      expect(state.listByStatus("queued")[0]).toMatchObject({ round: 3, parent_job_id: two?.id });
    });

    it("does not follow up a dry run, which never reached GitHub", () => {
      post("aaa1111", null);
      state.recordSeen({ ...base, headSha: "bbb2222" });
      expect(state.listByStatus("queued")[0]).toMatchObject({ round: 1, parent_job_id: null });
    });

    it("links a parent posted after the job was queued", () => {
      state.recordSeen({ ...base, headSha: "aaa1111" });
      const first = state.claimNext();
      state.recordSeen({ ...base, headSha: "bbb2222" }); // queued while the first is reviewing
      const second = state.listByStatus("queued")[0];
      expect(second?.round).toBe(1);
      if (!first || !second) throw new Error("missing jobs");
      state.completeReview(first.id, { findings: 1, outputDir: "o", costUsd: 1, durationMs: 1 });
      state.claimById(first.id);
      state.completePublish(first.id, { reviewId: 1, url: "u", event: "COMMENTED" });
      expect(state.linkParent(second.id)).toMatchObject({ round: 2, parent_job_id: first.id });
    });

    it("never makes a later commit the parent of an earlier job", () => {
      state.recordSeen({ ...base, headSha: "aaa1111" });
      const early = state.listByStatus("queued")[0];
      post("bbb2222");
      if (!early) throw new Error("missing job");
      expect(state.linkParent(early.id)).toMatchObject({ round: 1, parent_job_id: null });
    });

    it("holds a reviewed job without using an attempt, remembering when waiting began", () => {
      state.recordSeen(base);
      const job = state.claimNext();
      if (!job) throw new Error("nothing to claim");
      state.completeReview(job.id, { findings: 0, outputDir: "o", costUsd: 1, durationMs: 1 });
      state.claimById(job.id);
      const t0 = new Date("2026-09-25T10:00:00Z");
      state.defer(job.id, new Date("2026-09-25T10:05:00Z"), "waiting for CI", t0);
      expect(state.get(job.id)).toMatchObject({
        status: "reviewed",
        reason: "waiting for CI",
        attempts: 0,
        next_attempt_at: "2026-09-25T10:05:00.000Z",
        waiting_since: "2026-09-25T10:00:00.000Z",
      });
      expect(state.claimNext(new Date("2026-09-25T10:04:00Z"))).toBeUndefined();

      state.claimNext(new Date("2026-09-25T10:06:00Z"));
      state.defer(
        job.id,
        new Date("2026-09-25T10:11:00Z"),
        "waiting for CI",
        new Date("2026-09-25T10:06:00Z"),
      );
      expect(state.get(job.id)?.waiting_since).toBe("2026-09-25T10:00:00.000Z");

      state.resetJob(job.id, "queued", ["reviewed"]);
      expect(state.get(job.id)?.waiting_since).toBeNull();
    });

    it("can hold a queued job for a wait that is not about CI", () => {
      state.recordSeen(base);
      const job = state.claimNext();
      if (!job) throw new Error("nothing to claim");
      const t0 = new Date("2026-09-25T10:00:00Z");
      state.defer(job.id, new Date("2026-09-25T10:15:00Z"), "pending review", t0, {
        status: "queued",
        ci: false,
      });
      expect(state.get(job.id)).toMatchObject({
        status: "queued",
        reason: "pending review",
        attempts: 0,
        next_attempt_at: "2026-09-25T10:15:00.000Z",
        waiting_since: null,
      });
      expect(state.claimNext(new Date("2026-09-25T10:14:00Z"))).toBeUndefined();
      expect(state.claimNext(new Date("2026-09-25T10:16:00Z"))).toMatchObject({
        status: "preparing",
      });
    });
  });

  it("upgrades an M1 database in place", () => {
    const path = join(mkdtempSync(join(tmpdir(), "proxy-state-")), "state.db");
    const v1 = new DatabaseSync(path);
    v1.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL,
      head_sha TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, review_id INTEGER, findings INTEGER,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (repo, pr, head_sha));
      INSERT INTO jobs (repo, pr, head_sha, title, url, status, created_at, updated_at)
      VALUES ('acme/api', 1, 'abc', 't', 'u', 'queued', 'x', 'x');
      PRAGMA user_version = 1;`);
    v1.close();

    const upgraded = openState(path);
    expect(upgraded.listByStatus("queued")[0]).toMatchObject({
      pr: 1,
      next_attempt_at: null,
      round: 1,
      parent_job_id: null,
      waiting_since: null,
    });
    expect(upgraded.claimNext()?.pr).toBe(1);
    upgraded.close();
  });
});
