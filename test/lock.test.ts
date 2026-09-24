import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlreadyRunningError, acquireLock, readLock } from "../src/lock.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "proxy-lock-")), "server.lock");

describe("acquireLock", () => {
  it("takes a free lock and releases it", () => {
    const path = lockPath();
    const release = acquireLock(path);
    expect(readLock(path)?.pid).toBe(process.pid);
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses while a live process holds it", () => {
    const path = lockPath();
    // The test runner's parent is alive for the whole test.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
    expect(() => acquireLock(path)).toThrow(AlreadyRunningError);
    expect(readLock(path)?.pid).toBe(process.ppid);
  });

  it("takes over a lock whose process is gone", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, startedAt: "x" }));
    const release = acquireLock(path);
    expect(readLock(path)?.pid).toBe(process.pid);
    release();
  });

  it("treats an unreadable lock file as stale", () => {
    const path = lockPath();
    writeFileSync(path, "not json");
    acquireLock(path)();
  });

  it("does not delete a lock that another process took over", () => {
    const path = lockPath();
    const release = acquireLock(path);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
    release();
    expect(readLock(path)?.pid).toBe(process.ppid);
  });
});
