import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision } from "./filters.ts";
import type { TicketContext, TicketStore } from "./ticket.ts";

export type JobStatus =
  | "queued"
  | "preparing"
  | "reviewing"
  | "reviewed"
  /** Would request changes: waits on the status page for your OK, or until hold_until. */
  | "held"
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
  /** 1 for a first review; 2+ for a follow-up that checks the review of parent_job_id. */
  round: number;
  parent_job_id: number | null;
  /** When posting started waiting for CI, so the wait has an end. */
  waiting_since: string | null;
  /** A held review posts by itself at this time. null while held: it waits for you. */
  hold_until: string | null;
  /** Let go by you or by the timer, so it is not held again. */
  released: "you" | "timer" | null;
  /** JSON array of F-ids you dropped while it was held; they are never posted. */
  dropped: string | null;
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
  `ALTER TABLE jobs ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE jobs ADD COLUMN parent_job_id INTEGER;
   ALTER TABLE jobs ADD COLUMN waiting_since TEXT;`,
  `ALTER TABLE jobs ADD COLUMN hold_until TEXT;
   ALTER TABLE jobs ADD COLUMN released TEXT;
   ALTER TABLE jobs ADD COLUMN dropped TEXT;`,
  `CREATE TABLE tickets (
     repo       TEXT    NOT NULL,
     pr         INTEGER NOT NULL,
     data       TEXT    NOT NULL,
     fetched_at TEXT    NOT NULL,
     PRIMARY KEY (repo, pr)
   );`,
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

/** Skip reason for a review stopped from the status page. */
export const STOPPED_REASON = "stopped by you";
/** Reason saved on a follow-up you approved by hand from the status page. */
export const APPROVED_BY_YOU = "approved by you";
/** Reason on a held review, waiting for your OK. */
export const HELD_REASON = "needs your OK";
/** Skip reason for a held review you discarded. */
export const DISCARDED_REASON = "discarded by you";

export interface State extends TicketStore {
  recordSeen(input: SeenInput): SeenResult;
  /** Queue a PR commit by hand, ignoring skip rules. Resets a finished or failed job. */
  enqueue(input: Omit<SeenInput, "decision">): Job;
  /**
   * Atomically claim the oldest ready job: queued -> preparing (needs a review) or
   * reviewed -> posting (review done, needs publishing). The returned status says which.
   */
  claimNext(now?: Date, options?: { skipPosting?: boolean }): Job | undefined;
  /**
   * Hold a review that would request changes until `until`, or until you act (null).
   * It no longer counts as released.
   */
  hold(id: number, until: Date | null, now?: Date): void;
  /** Post a held review now (with your drops): held -> reviewed. Undefined if not held. */
  release(id: number): Job | undefined;
  /** Stop the timer of a held review: it waits for you. Undefined if not held with a timer. */
  holdForYou(id: number): Job | undefined;
  /** Post nothing for a held review. Undefined if not held. */
  discard(id: number): Job | undefined;
  /** The F-ids you dropped from a held review, replacing the earlier list. */
  setDropped(id: number, ids: string[]): Job | undefined;
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
  /**
   * Point a job at the latest earlier commit of the same PR whose review is on GitHub, making it
   * a follow-up (round = parent's + 1), or back to round 1 if there is none. Returns the job.
   */
  linkParent(id: number): Job | undefined;
  /**
   * Hold a job until `until` without using up an attempt, e.g. while CI runs. It waits as
   * `status` (default "reviewed"). A CI wait (`ci`, the default) remembers its start in
   * waiting_since; other waits leave that clock alone.
   */
  defer(
    id: number,
    until: Date,
    reason: string,
    now?: Date,
    options?: { status?: "queued" | "reviewed"; ci?: boolean },
  ): void;
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
  /** Forget a PR's saved ticket, so the next review reads it again. False if none was saved. */
  clearTicket(repo: string, pr: number): boolean;
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
     WHERE repo = ? AND pr = ? AND head_sha <> ? AND status IN ('queued', 'held')`,
  );
  const requeueManual = db.prepare(
    `UPDATE jobs SET status = 'queued', reason = NULL, error = NULL, attempts = 0,
       next_attempt_at = NULL, waiting_since = NULL, hold_until = NULL, released = NULL,
       dropped = NULL, title = ?, updated_at = ?
     WHERE id = ?`,
  );
  // A held review whose timer ran out is posted, and marks itself released by the timer.
  const nextStep = `status = CASE status WHEN 'queued' THEN 'preparing' ELSE 'posting' END,
    released = CASE status WHEN 'held' THEN 'timer' ELSE released END`;
  const claim = db.prepare(
    `UPDATE jobs SET ${nextStep}, started_at = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM jobs
       WHERE (status IN ('queued', 'reviewed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'held' AND hold_until IS NOT NULL AND hold_until <= ?)
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
    `UPDATE jobs SET status = ?1, reason = NULL, error = NULL, attempts = 0,
       next_attempt_at = NULL, waiting_since = NULL, hold_until = NULL,
       -- A post retried as reviewed keeps your OK and drops; a new review starts over.
       released = CASE ?1 WHEN 'queued' THEN NULL ELSE released END,
       dropped = CASE ?1 WHEN 'queued' THEN NULL ELSE dropped END,
       updated_at = ?2
     WHERE id = ?3`,
  );
  const holdStmt = db.prepare(
    `UPDATE jobs SET status = 'held', reason = ?, hold_until = ?, released = NULL,
       next_attempt_at = NULL, error = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const releaseStmt = db.prepare(
    `UPDATE jobs SET status = 'reviewed', reason = NULL, released = 'you', next_attempt_at = NULL,
       updated_at = ?
     WHERE id = ? AND status = 'held'`,
  );
  const holdForYouStmt = db.prepare(
    `UPDATE jobs SET hold_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'held' AND hold_until IS NOT NULL`,
  );
  const discardStmt = db.prepare(
    `UPDATE jobs SET status = 'skipped', reason = ?, hold_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'held'`,
  );
  const setDroppedStmt = db.prepare(
    "UPDATE jobs SET dropped = ?, updated_at = ? WHERE id = ? AND status = 'held'",
  );
  const selectRecent = db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?");
  const readTicket = db.prepare("SELECT data FROM tickets WHERE repo = ? AND pr = ?");
  const writeTicket = db.prepare(
    `INSERT INTO tickets (repo, pr, data, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo, pr) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  );
  const deleteTicket = db.prepare("DELETE FROM tickets WHERE repo = ? AND pr = ?");
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
  // Only a review that reached GitHub can be followed up; later commits never parent earlier ones.
  const lastPosted = db.prepare(
    `SELECT * FROM jobs
     WHERE repo = ? AND pr = ? AND head_sha <> ? AND id < ? AND status = 'done'
       AND review_id IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  );
  const setParent = db.prepare(
    "UPDATE jobs SET parent_job_id = ?, round = ?, updated_at = ? WHERE id = ?",
  );
  const deferStmt = db.prepare(
    `UPDATE jobs SET status = ?, reason = ?, next_attempt_at = ?,
       waiting_since = CASE WHEN ? THEN COALESCE(waiting_since, ?) ELSE waiting_since END,
       updated_at = ?
     WHERE id = ?`,
  );

  const toJob = (row: unknown) => row as Job | undefined;
  const iso = (d: Date = new Date()) => d.toISOString();

  function linkParent(id: number): Job | undefined {
    const job = toJob(getJob.get(id));
    if (!job) return undefined;
    const parent = toJob(lastPosted.get(job.repo, job.pr, job.head_sha, job.id));
    const parentId = parent?.id ?? null;
    const round = parent ? parent.round + 1 : 1;
    if (parentId !== job.parent_job_id || round !== job.round) {
      setParent.run(parentId, round, iso(), id);
    }
    return toJob(getJob.get(id));
  }

  function insertLinked(input: {
    repo: string;
    pr: number;
    headSha: string;
    title: string;
    url: string;
    status: JobStatus;
    reason: string | null;
    now: string;
  }): void {
    const { repo, pr, headSha, title, url, status, reason, now } = input;
    const { lastInsertRowid } = insertJob.run(
      repo,
      pr,
      headSha,
      title,
      url,
      status,
      reason,
      now,
      now,
    );
    linkParent(Number(lastInsertRowid));
  }

  return {
    recordSeen({ repo, pr, headSha, title, url, decision }) {
      const now = iso();
      const status: JobStatus = decision.action === "queue" ? "queued" : "skipped";
      const reason = decision.action === "skip" ? decision.reason : null;
      const existing = toJob(findJob.get(repo, pr, headSha));

      if (!existing) {
        // A new push makes any older commit of this PR that is still waiting pointless.
        supersede.run(now, repo, pr, headSha);
        insertLinked({ repo, pr, headSha, title, url, status, reason, now });
        return "new";
      }
      // A review you stopped stays stopped until you start it again.
      if (existing.status !== "skipped" || existing.reason === STOPPED_REASON) return "known";

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
        insertLinked({ repo, pr, headSha, title, url, status: "queued", reason: null, now });
      } else if (!["preparing", "reviewing", "posting"].includes(existing.status)) {
        requeueManual.run(title, now, existing.id);
      }
      return toJob(findJob.get(repo, pr, headSha)) as Job;
    },

    claimNext(now = new Date(), { skipPosting = false } = {}) {
      const t = iso(now);
      return toJob(skipPosting ? claimReviewOnly.get(t, t, t) : claim.get(t, t, t, t));
    },

    claimById(id) {
      const t = iso();
      return toJob(claimOne.get(t, t, id));
    },

    hold(id, until, now = new Date()) {
      holdStmt.run(HELD_REASON, until ? iso(until) : null, iso(now), id);
    },

    release(id) {
      return releaseStmt.run(iso(), id).changes ? toJob(getJob.get(id)) : undefined;
    },

    holdForYou(id) {
      return holdForYouStmt.run(iso(), id).changes ? toJob(getJob.get(id)) : undefined;
    },

    discard(id) {
      return discardStmt.run(DISCARDED_REASON, iso(), id).changes
        ? toJob(getJob.get(id))
        : undefined;
    },

    setDropped(id, ids) {
      const value = ids.length > 0 ? JSON.stringify(ids) : null;
      return setDroppedStmt.run(value, iso(), id).changes ? toJob(getJob.get(id)) : undefined;
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

    linkParent,

    defer(id, until, reason, now = new Date(), { status = "reviewed", ci = true } = {}) {
      deferStmt.run(status, reason, iso(until), ci ? 1 : 0, iso(now), iso(now), id);
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

    getTicket(repo, pr) {
      const row = readTicket.get(repo, pr) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as TicketContext) : undefined;
    },

    saveTicket(repo, pr, ticket, now) {
      writeTicket.run(repo, pr, JSON.stringify(ticket), iso(now));
    },

    clearTicket(repo, pr) {
      return deleteTicket.run(repo, pr).changes > 0;
    },

    close() {
      db.close();
    },
  };
}
