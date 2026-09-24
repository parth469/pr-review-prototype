import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision } from "./filters.ts";

export type JobStatus =
  | "queued"
  | "preparing"
  | "reviewing"
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
];

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
  listByStatus(status: JobStatus): Job[];
  close(): void;
}

export function openState(path: string): State {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const findJob = db.prepare(
    "SELECT status, reason FROM jobs WHERE repo = ? AND pr = ? AND head_sha = ?",
  );
  const insertJob = db.prepare(
    `INSERT INTO jobs (repo, pr, head_sha, title, url, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStatus = db.prepare(
    `UPDATE jobs SET status = ?, reason = ?, title = ?, updated_at = ?
     WHERE repo = ? AND pr = ? AND head_sha = ?`,
  );
  const selectByStatus = db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY id");

  return {
    recordSeen({ repo, pr, headSha, title, url, decision }) {
      const now = new Date().toISOString();
      const status: JobStatus = decision.action === "queue" ? "queued" : "skipped";
      const reason = decision.action === "skip" ? decision.reason : null;
      const existing = findJob.get(repo, pr, headSha) as
        | { status: JobStatus; reason: string | null }
        | undefined;

      if (!existing) {
        insertJob.run(repo, pr, headSha, title, url, status, reason, now, now);
        return "new";
      }
      if (existing.status !== "skipped") return "known";

      // Only skipped jobs are re-evaluated: a draft can become ready, config can change.
      if (status === "queued") {
        updateStatus.run(status, null, title, now, repo, pr, headSha);
        return "requeued";
      }
      if (reason !== existing.reason) {
        updateStatus.run(status, reason, title, now, repo, pr, headSha);
      }
      return "known";
    },

    listByStatus(status) {
      return selectByStatus.all(status) as unknown as Job[];
    },

    close() {
      db.close();
    },
  };
}
