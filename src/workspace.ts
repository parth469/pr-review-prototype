import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.ts";
import type { Job } from "./state.ts";
import type { PullFile, PullRequest, PullSource } from "./types.ts";

/** The PR moved to a newer commit after this job was queued; the newer commit gets its own job. */
export class HeadMovedError extends Error {
  readonly currentSha: string;
  constructor(expected: string, current: string) {
    super(`PR head moved from ${expected.slice(0, 7)} to ${current.slice(0, 7)}`);
    this.name = "HeadMovedError";
    this.currentSha = current;
  }
}

export interface PreparedWorkspace {
  /** Absolute path of the checkout Claude runs in. */
  dir: string;
  slug: string;
  pr: PullRequest;
  diff: string;
  files: PullFile[];
}

export interface Workspace {
  prepare(job: Job): Promise<PreparedWorkspace>;
  cleanup(prepared: PreparedWorkspace): Promise<void>;
}

export interface WorkspaceOptions {
  cacheDir: string;
  workDir: string;
  source: PullSource;
  token?: string;
  /** Where to clone from. Tests point this at a local repo. */
  remoteUrl?: (repo: string) => string;
}

export function jobSlug(job: Pick<Job, "repo" | "pr" | "head_sha">): string {
  return `${job.repo.replace("/", "-")}-${job.pr}-${job.head_sha.slice(0, 7)}`;
}

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const cacheRoot = resolve(options.cacheDir, "repos");
  const workRoot = resolve(options.workDir);
  const remoteUrl = options.remoteUrl ?? ((repo) => `https://github.com/${repo}.git`);
  const token = options.token;
  const gitOpts = (cwd?: string) => ({ ...(cwd ? { cwd } : {}), ...(token ? { token } : {}) });

  async function ensureClone(repo: string): Promise<string> {
    const dir = join(cacheRoot, repo);
    if (!existsSync(join(dir, ".git")) && !existsSync(join(dir, "HEAD"))) {
      await mkdir(join(cacheRoot, repo.split("/")[0] as string), { recursive: true });
      await git(["clone", "--filter=blob:none", "--no-checkout", remoteUrl(repo), dir], gitOpts());
    }
    return dir;
  }

  async function removeWorktree(repoDir: string, dir: string): Promise<void> {
    if (existsSync(dir)) {
      await git(["worktree", "remove", "--force", dir], gitOpts(repoDir)).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
    await git(["worktree", "prune"], gitOpts(repoDir));
  }

  return {
    async prepare(job) {
      const pr = await options.source.getPull(job.repo, job.pr);
      if (pr.headSha !== job.head_sha) throw new HeadMovedError(job.head_sha, pr.headSha);

      const repoDir = await ensureClone(job.repo);
      const ref = `refs/proxy/pr-${job.pr}`;
      await git(
        ["fetch", "--no-tags", "origin", `+refs/pull/${job.pr}/head:${ref}`],
        gitOpts(repoDir),
      );
      const fetched = await git(["rev-parse", ref], gitOpts(repoDir));
      if (fetched !== job.head_sha) throw new HeadMovedError(job.head_sha, fetched);

      const slug = jobSlug(job);
      const dir = join(workRoot, slug);
      await mkdir(workRoot, { recursive: true });
      await removeWorktree(repoDir, dir); // leftover from a crashed run
      await git(["worktree", "add", "--detach", dir, job.head_sha], gitOpts(repoDir));

      const [diff, files] = await Promise.all([
        options.source.getPullDiff(job.repo, job.pr),
        options.source.listPullFiles(job.repo, job.pr),
      ]);
      const reviewDir = join(dir, ".review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "diff.patch"), diff);
      await writeFile(join(reviewDir, "files.json"), `${JSON.stringify(files, null, 2)}\n`);
      await writeFile(
        join(reviewDir, "pr.json"),
        `${JSON.stringify(
          {
            repo: pr.repo,
            number: pr.number,
            title: pr.title,
            author: pr.author,
            base: pr.baseRef,
            head: pr.headSha,
            description: pr.body,
          },
          null,
          2,
        )}\n`,
      );

      return { dir, slug, pr, diff, files };
    },

    async cleanup(prepared) {
      await removeWorktree(join(cacheRoot, prepared.pr.repo), prepared.dir);
    },
  };
}
