import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/git.ts";
import type { Job } from "../src/state.ts";
import type { PullSource } from "../src/types.ts";
import { createWorkspace, HeadMovedError, jobSlug } from "../src/workspace.ts";
import { makePr } from "./helpers.ts";

const commit = (cwd: string, msg: string) =>
  git(
    // No signing: a global commit.gpgsign would wait on a key prompt and time the test out.
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-am",
      msg,
    ],
    { cwd },
  );

// A local "GitHub": a repo with main and a PR head published as refs/pull/1/head.
async function makeOrigin(): Promise<{ dir: string; headSha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "proxy-origin-"));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  await git(["add", "."], { cwd: dir });
  await commit(dir, "base");
  await git(["checkout", "-q", "-b", "feature"], { cwd: dir });
  writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
  await commit(dir, "change");
  const headSha = await git(["rev-parse", "HEAD"], { cwd: dir });
  await git(["update-ref", "refs/pull/1/head", headSha], { cwd: dir });
  await git(["checkout", "-q", "main"], { cwd: dir });
  return { dir, headSha };
}

function job(headSha: string): Job {
  return {
    id: 1,
    repo: "acme/api",
    pr: 1,
    head_sha: headSha,
    title: "t",
    url: "u",
    status: "preparing",
    round: 1,
    parent_job_id: null,
    waiting_since: null,
    reason: null,
    attempts: 0,
    review_id: null,
    findings: null,
    error: null,
    next_attempt_at: null,
    started_at: null,
    output_dir: null,
    cost_usd: null,
    duration_ms: null,
    review_url: null,
    event: null,
    created_at: "",
    updated_at: "",
  };
}

// Real git on Windows is slow, more so with test files running in parallel.
describe("workspace", { timeout: 60_000 }, () => {
  let origin: { dir: string; headSha: string };
  beforeAll(async () => {
    origin = await makeOrigin();
  }, 60_000);

  function setup(apiHeadSha: string) {
    const root = mkdtempSync(join(tmpdir(), "proxy-ws-"));
    const source: PullSource = {
      getPull: async () => makePr({ repo: "acme/api", number: 1, headSha: apiHeadSha }),
      getPullDiff: async () => "diff --git a/app.ts b/app.ts\n",
      listPullFiles: async () => [
        { filename: "app.ts", status: "modified", additions: 1, deletions: 1 },
      ],
    };
    return createWorkspace({
      cacheDir: join(root, "cache"),
      workDir: join(root, "work"),
      source,
      remoteUrl: () => origin.dir,
    });
  }

  it("checks out the PR head with review files, then cleans up", async () => {
    const ws = setup(origin.headSha);
    const prepared = await ws.prepare(job(origin.headSha));

    expect(prepared.slug).toBe(jobSlug(job(origin.headSha)));
    // core.autocrlf may turn LF into CRLF on checkout; line numbers are unaffected.
    expect(readFileSync(join(prepared.dir, "app.ts"), "utf8").trimEnd()).toBe(
      "export const a = 2;",
    );
    expect(await git(["rev-parse", "HEAD"], { cwd: prepared.dir })).toBe(origin.headSha);
    expect(readFileSync(join(prepared.dir, ".review", "diff.patch"), "utf8")).toContain("app.ts");
    const meta = JSON.parse(readFileSync(join(prepared.dir, ".review", "pr.json"), "utf8"));
    expect(meta).toMatchObject({ repo: "acme/api", number: 1, base: "main" });

    await ws.cleanup(prepared);
    expect(existsSync(prepared.dir)).toBe(false);
  });

  it("reuses the clone and replaces a leftover worktree", async () => {
    const ws = setup(origin.headSha);
    const first = await ws.prepare(job(origin.headSha));
    mkdirSync(join(first.dir, "leftover"), { recursive: true });
    const second = await ws.prepare(job(origin.headSha));
    expect(existsSync(join(second.dir, "leftover"))).toBe(false);
    await ws.cleanup(second);
  });

  it("refuses when the PR has moved to another commit", async () => {
    const ws = setup("f".repeat(40));
    await expect(ws.prepare(job(origin.headSha))).rejects.toBeInstanceOf(HeadMovedError);
  });
});
