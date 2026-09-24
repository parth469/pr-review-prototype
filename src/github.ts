import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "octokit";
import type { Logger } from "./log.ts";
import type { GitHubClient, PullRequest } from "./types.ts";

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

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo "${repo}"`);
  return { owner, repo: name };
}

export interface GitHub extends GitHubClient {
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
        url: data.html_url,
        author: data.user.login,
        headSha: data.head.sha,
        draft: data.draft ?? false,
        changedLines: data.additions + data.deletions,
      };
    },
  };
}
