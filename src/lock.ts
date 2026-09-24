import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export class AlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`Proxy Reviewer is already running (pid ${pid}). Stop it first: npm run service -- stop`);
    this.name = "AlreadyRunningError";
    this.pid = pid;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * Make sure only one server runs, so a manual `npm start` never races the background service.
 * Returns a release function. A lock left by a process that died is taken over.
 */
export function acquireLock(path: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = { pid, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(info), { flag: "wx" }); // fails if the file exists
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readLock(path)?.pid === pid) rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(path);
      if (holder && holder.pid !== pid && isAlive(holder.pid)) {
        throw new AlreadyRunningError(holder.pid);
      }
      rmSync(path, { force: true }); // stale: its process is gone
    }
  }
  throw new Error(`Could not create ${path}`);
}
