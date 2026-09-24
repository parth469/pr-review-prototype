import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision } from "./filters.ts";

export type JobStatus =
  | "queued"
  | "preparing"
  | "reviewing"
  | "reviewed"
  | "posting"
  | "done"
  | "failed"
  | "skipped";

export interface Job {
  id: number;
  repo: string;
  pr: number;
  head_sha: string;
  title: string;
  url: string;
  status: JobStatus;
  reason: string | null;
  attempts: number;
  review_id: number | null;
  findings: number | null;
  error: string | null;
  next_attempt_at: string | null;
  started_at: string | null;
  output_dir: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  review_url: string | null;
  event: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeenInput {
  repo: string;
  pr: number;
  headSha: string;
  title: string;
  url: string;
  decision: Decision;
}

/** new: first time this commit is seen · requeued: was skipped, now eligible · known: no change */
export type SeenResult = "new" | "requeued" | "known";

export interface ReviewOutcome {
  findings: number;
  outputDir: string;
  costUsd: number;
  durationMs: number;
}

// Wait before retry N (1-based). Past the end, the last value repeats.
const RETRY_DELAYS_MS = [5 * 60_000, 20 * 60_000];

// Each entry upgrades the schema by one version. Append only; never edit a released step.
const MIGRATIONS: string[] = [
  `CREATE TABLE jobs (
     id          INTEGER PRIMARY KEY,
     repo        TEXT    NOT NULL,
     pr          INTEGER NOT NULL,
     head_sha    TEXT    NOT NULL,
     title       TEXT    NOT NULL,
     url         TEXT    NOT NULL,
     status      TEXT    NOT NULL,
     reason      TEXT,
     attempts    INTEGER NOT NULL DEFAULT 0,
     review_id   INTEGER,
     findings    INTEGER,
     error       TEXT,
     created_at  TEXT    NOT NULL,
     updated_at  TEXT    NOT NULL,
     UNIQUE (repo, pr, head_sha)
   );
   CREATE INDEX jobs_status ON jobs (status);`,
  `ALTER TABLE jobs ADD COLUMN next_attempt_at TEXT;
   ALTER TABLE jobs ADD COLUMN started_at TEXT;
   ALTER TABLE jobs ADD COLUMN output_dir TEXT;
   ALTER TABLE jobs ADD COLUMN cost_usd REAL;
   ALTER TABLE jobs ADD COLUMN duration_ms INTEGER;`,
  `ALTER TABLE jobs ADD COLUMN review_url TEXT;
   ALTER TABLE jobs ADD COLUMN event TEXT;`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export interface PublishOutcome {
  reviewId: number | null;
  url: string | null;
  event: string;
  /** Set when nothing was posted, e.g. "dry-run". */
  reason?: string;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export interface State {
  recordSeen(input: SeenInput): SeenResult;
  /** Queue a PR commit by hand, ignoring skip rules. Resets a finished or failed job. */
  enqueue(input: Omit<SeenInput, "decision">): Job;
  /**
   * Atomically claim the oldest ready job: queued -> preparing (needs a review) or
   * reviewed -> posting (review done, needs publishing). The returned status says which.
   */
  claimNext(now?: Date, options?: { skipPosting?: boolean }): Job | undefined;
  /** Claim one specific queued or reviewed job, ignoring its retry time. */
  claimById(id: number): Job | undefined;
  setStatus(id: number, status: JobStatus): void;
  skip(id: number, reason: string): void;
  /** Review saved; the job waits as `reviewed` to be published, with a fresh attempt budget. */
  completeReview(id: number, outcome: ReviewOutcome): void;
  completePublish(id: number, outcome: PublishOutcome): void;
  /**
   * Record a failed attempt; go back to retryStatus with backoff, or mark failed after
   * maxAttempts. Posting failures retry as "reviewed" so Claude does not run again.
   */
  failAttempt(
    id: number,
    error: string,
    maxAttempts: number,
    options?: { now?: Date; retryStatus?: "queued" | "reviewed" },
  ): Job;
  /** Put jobs left mid-flight by a crash back where they can resume. Returns how many. */
  recoverStale(): number;
  get(id: number): Job | undefined;
  listByStatus(status: JobStatus): Job[];
  /** Most recently updated jobs first. */
  listRecent(limit: number): Job[];
  /**
   * Send a job back to `queued` (review again) or `reviewed` (post again) with a fresh
   * attempt budget, but only from one of the given statuses. Returns undefined otherwise.
   */
  resetJob(id: number, to: "queued" | "reviewed", from: JobStatus[]): Job | undefined;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  close(): void;
}

export function openState(path: string): State {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const findJob = db.prepare("SELECT * FROM jobs WHERE repo = ? AND pr = ? AND head_sha = ?");
  const getJob = db.prepare("SELECT * FROM jobs WHERE id = ?");
  const insertJob = db.prepare(
    `INSERT INTO jobs (repo, pr, head_sha, title, url, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSeen = db.prepare(
    `UPDATE jobs SET status = ?, reason = ?, title = ?, updated_at = ?
     WHERE repo = ? AND pr = ? AND head_sha = ?`,
  );
  const supersede = db.prepare(
    `UPDATE jobs SET status = 'skipped', reason = 'superseded', updated_at = ?
     WHERE repo = ? AND pr = ? AND head_sha <> ? AND status = 'queued'`,
  );
  const requeueManual = db.prepare(
    `UPDATE jobs SET status = 'queued', reason = NULL, error = NULL, attempts = 0,
       next_attempt_at = NULL, title = ?, updated_at = ?
     WHERE id = ?`,
  );
  const nextStep = `status = CASE status WHEN 'queued' THEN 'preparing' ELSE 'posting' END`;
  const claim = db.prepare(
    `UPDATE jobs SET ${nextStep}, started_at = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM jobs
       WHERE status IN ('queued', 'reviewed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT 1
     )
     RETURNING *`,
  );
  // Same as claim, but leaves reviewed jobs alone while posting is paused.
  const claimReviewOnly = db.prepare(
    `UPDATE jobs SET status = 'preparing', started_at = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT 1
     )
     RETURNING *`,
  );
  const reset = db.prepare(
    `UPDATE jobs SET status = ?, reason = NULL, error = NULL, attempts = 0,
       next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const selectRecent = db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?");
  const readSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const writeSetting = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const claimOne = db.prepare(
    `UPDATE jobs SET ${nextStep}, started_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'reviewed')
     RETURNING *`,
  );
  const setStatusStmt = db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?");
  const skipStmt = db.prepare(
    "UPDATE jobs SET status = 'skipped', reason = ?, updated_at = ? WHERE id = ?",
  );
  const complete = db.prepare(
    `UPDATE jobs SET status = 'reviewed', findings = ?, output_dir = ?, cost_usd = ?,
       duration_ms = ?, error = NULL, attempts = 0, next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const published = db.prepare(
    `UPDATE jobs SET status = 'done', review_id = ?, review_url = ?, event = ?, reason = ?,
       error = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const fail = db.prepare(
    `UPDATE jobs SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const recover = db.prepare(
    `UPDATE jobs
     SET status = CASE status WHEN 'posting' THEN 'reviewed' ELSE 'queued' END, updated_at = ?
     WHERE status IN ('preparing', 'reviewing', 'posting')`,
  );
  const selectByStatus = db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY id");

  const toJob = (row: unknown) => row as Job | undefined;
  const iso = (d: Date = new Date()) => d.toISOString();

  return {
    recordSeen({ repo, pr, headSha, title, url, decision }) {
      const now = iso();
      const status: JobStatus = decision.action === "queue" ? "queued" : "skipped";
      const reason = decision.action === "skip" ? decision.reason : null;
      const existing = toJob(findJob.get(repo, pr, headSha));

      if (!existing) {
        // A new push makes any older commit of this PR that is still waiting pointless.
        supersede.run(now, repo, pr, headSha);
        insertJob.run(repo, pr, headSha, title, url, status, reason, now, now);
        return "new";
      }
      if (existing.status !== "skipped") return "known";

      // Only skipped jobs are re-evaluated: a draft can become ready, config can change.
      if (status === "queued") {
        updateSeen.run(status, null, title, now, repo, pr, headSha);
        return "requeued";
      }
      if (reason !== existing.reason) {
        updateSeen.run(status, reason, title, now, repo, pr, headSha);
      }
      return "known";
    },

    enqueue({ repo, pr, headSha, title, url }) {
      const now = iso();
      const existing = toJob(findJob.get(repo, pr, headSha));
      if (!existing) {
        supersede.run(now, repo, pr, headSha);
        insertJob.run(repo, pr, headSha, title, url, "queued", null, now, now);
      } else if (!["preparing", "reviewing", "posting"].includes(existing.status)) {
        requeueManual.run(title, now, existing.id);
      }
      return toJob(findJob.get(repo, pr, headSha)) as Job;
    },

    claimNext(now = new Date(), { skipPosting = false } = {}) {
      const t = iso(now);
      return toJob((skipPosting ? claimReviewOnly : claim).get(t, t, t));
    },

    claimById(id) {
      const t = iso();
      return toJob(claimOne.get(t, t, id));
    },

    setStatus(id, status) {
      setStatusStmt.run(status, iso(), id);
    },

    skip(id, reason) {
      skipStmt.run(reason, iso(), id);
    },

    completeReview(id, { findings, outputDir, costUsd, durationMs }) {
      complete.run(findings, outputDir, costUsd, durationMs, iso(), id);
    },

    completePublish(id, { reviewId, url, event, reason }) {
      published.run(reviewId, url, event, reason ?? null, iso(), id);
    },

    failAttempt(id, error, maxAttempts, { now = new Date(), retryStatus = "queued" } = {}) {
      const job = toJob(getJob.get(id));
      if (!job) throw new Error(`Job ${id} not found`);
      const attempts = job.attempts + 1;
      const giveUp = attempts >= maxAttempts;
      const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? 0;
      const nextAt = giveUp ? null : iso(new Date(now.getTime() + delay));
      fail.run(giveUp ? "failed" : retryStatus, attempts, error, nextAt, iso(now), id);
      return toJob(getJob.get(id)) as Job;
    },

    recoverStale() {
      return Number(recover.run(iso()).changes);
    },

    get(id) {
      return toJob(getJob.get(id));
    },

    listByStatus(status) {
      return selectByStatus.all(status) as unknown as Job[];
    },

    listRecent(limit) {
      return selectRecent.all(limit) as unknown as Job[];
    },

    resetJob(id, to, from) {
      const job = toJob(getJob.get(id));
      if (!job || !from.includes(job.status)) return undefined;
      reset.run(to, iso(), id);
      return toJob(getJob.get(id));
    },

    getSetting(key) {
      return (readSetting.get(key) as { value: string } | undefined)?.value;
    },

    setSetting(key, value) {
      writeSetting.run(key, value);
    },

    close() {
      db.close();
    },
  };
}
