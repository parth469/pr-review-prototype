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

      const first = state.failAttempt(job.id, "boom", 3, t0);
      expect(first).toMatchObject({ status: "queued", attempts: 1, error: "boom" });
      expect(first.next_attempt_at).toBe("2026-09-24T10:05:00.000Z");

      // Not ready before the retry time, ready after it.
      expect(state.claimNext(new Date("2026-09-24T10:04:00Z"))).toBeUndefined();
      expect(state.claimNext(new Date("2026-09-24T10:05:00Z"))?.id).toBe(job.id);

      const second = state.failAttempt(job.id, "boom", 3, t0);
      expect(second.next_attempt_at).toBe("2026-09-24T10:20:00.000Z");
      state.claimNext(new Date("2026-09-24T11:00:00Z"));
      expect(state.failAttempt(job.id, "boom", 3, t0)).toMatchObject({
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
    expect(upgraded.listByStatus("queued")[0]).toMatchObject({ pr: 1, next_attempt_at: null });
    expect(upgraded.claimNext()?.pr).toBe(1);
    upgraded.close();
  });
});
