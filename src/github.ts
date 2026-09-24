import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "octokit";
import type { Logger } from "./log.ts";
import type { GitHubClient, PullRequest, PullSource } from "./types.ts";

const execFileAsync = promisify(execFile);

// Direct requests only: `review-requested` would also match every team you belong to.
export const REVIEW_REQUEST_QUERY = "is:pr is:open user-review-requested:@me archived:false";

/** Reuse the gh CLI login so the daemon needs no token of its own. */
export async function getGhToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the error below
  }
  throw new Error("No GitHub login found. Run `gh auth login` and start again.");
}

/** "https://api.github.com/repos/acme/api" -> "acme/api" */
export function repoFromApiUrl(url: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
  if (!match?.[1]) throw new Error(`Unexpected repository_url: ${url}`);
  return match[1];
}

/** "acme/api#128" or a PR URL -> { repo: "acme/api", number: 128 } */
export function parsePrRef(ref: string): { repo: string; number: number } {
  const match =
    /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim()) ??
    /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref);
  if (!match?.[1] || !match[2]) {
    throw new Error(`"${ref}" is not a PR. Use owner/repo#123 or a pull request URL.`);
  }
  return { repo: match[1], number: Number(match[2]) };
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo "${repo}"`);
  return { owner, repo: name };
}

export interface GitHub extends GitHubClient, PullSource {
  getViewerLogin(): Promise<string>;
}

export function createGitHub(token: string, log: Logger): GitHub {
  // Retry once after a rate limit, then let the poller's backoff take over.
  const onLimit =
    (message: string) =>
    (retryAfter: number, options: { url: string }, _octokit: unknown, retryCount: number) => {
      log.warn({ retryAfter, url: options.url }, message);
      return retryCount < 1;
    };

  const octokit = new Octokit({
    auth: token,
    userAgent: "proxy-reviewer/0.1.0",
    request: { timeout: 30_000 },
    throttle: {
      onRateLimit: onLimit("GitHub rate limit hit"),
      onSecondaryRateLimit: onLimit("GitHub secondary rate limit hit"),
    },
  });

  return {
    async getViewerLogin() {
      const { data } = await octokit.request("GET /user");
      return data.login;
    },

    async searchReviewRequests() {
      const items = await octokit.paginate("GET /search/issues", {
        q: REVIEW_REQUEST_QUERY,
        per_page: 100,
      });
      return items.map((item) => ({
        repo: repoFromApiUrl(item.repository_url),
        number: item.number,
      }));
    },

    async getPull(repo, number): Promise<PullRequest> {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...splitRepo(repo),
        pull_number: number,
      });
      return {
        repo,
        number,
        title: data.title,
        body: data.body ?? "",
        url: data.html_url,
        author: data.user.login,
        headSha: data.head.sha,
        baseRef: data.base.ref,
        baseSha: data.base.sha,
        draft: data.draft ?? false,
        changedLines: data.additions + data.deletions,
      };
    },

    async getPullDiff(repo, number) {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...splitRepo(repo),
        pull_number: number,
        mediaType: { format: "diff" },
      });
      // With the diff media type the body is the raw patch text, not the JSON the types describe.
      return data as unknown as string;
    },

    async listPullFiles(repo, number) {
      const files = await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        ...splitRepo(repo),
        pull_number: number,
        per_page: 100,
      });
      return files.map(({ filename, status, additions, deletions }) => ({
        filename,
        status,
        additions,
        deletions,
      }));
    },
  };
}
