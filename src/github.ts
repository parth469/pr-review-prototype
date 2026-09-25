import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "octokit";
import type { Logger } from "./log.ts";
import type {
  CiState,
  FollowUpSource,
  GitHubClient,
  PullRequest,
  PullSource,
  ReviewTarget,
  ReviewThread,
} from "./types.ts";

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

export interface GitHub extends GitHubClient, PullSource, ReviewTarget, FollowUpSource {
  getViewerLogin(): Promise<string>;
  /** Your unsubmitted pending review on the PR, if any (only you can see it). */
  findPendingReview(
    repo: string,
    number: number,
    viewer: string,
  ): Promise<{ id: number; body: string } | undefined>;
}

const THREADS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved path line originalLine
            comments(first: 100) {
              nodes {
                databaseId body createdAt
                author { login }
                pullRequestReview { databaseId }
              }
            }
          }
        }
      }
    }
  }`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string;
          line: number | null;
          originalLine: number | null;
          comments: {
            nodes: Array<{
              databaseId: number;
              body: string;
              createdAt: string;
              author: { login: string } | null;
              pullRequestReview: { databaseId: number } | null;
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

// Check run conclusions that mean CI is red. neutral, skipped and stale do not.
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/** One state for all the checks and statuses of a commit. Any failure wins, then pending. */
export function combineCi(
  runs: Array<{ status: string; conclusion: string | null }>,
  statuses: Array<{ state: string }>,
): CiState {
  if (runs.length === 0 && statuses.length === 0) return "none";
  const failed =
    runs.some((r) => r.status === "completed" && FAILED_CONCLUSIONS.has(r.conclusion ?? "")) ||
    statuses.some((s) => s.state === "failure" || s.state === "error");
  if (failed) return "failure";
  const pending =
    runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending");
  return pending ? "pending" : "success";
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
        state: data.state === "open" ? "open" : "closed",
        merged: data.merged,
        changedLines: data.additions + data.deletions,
      };
    },

    async listRequestedReviewers(repo, number) {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
        { ...splitRepo(repo), pull_number: number },
      );
      return data.users.map((u) => u.login);
    },

    async findOwnReview(repo, number, viewer, marker) {
      const reviews = await octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { ...splitRepo(repo), pull_number: number, per_page: 100 },
      );
      const mine = reviews.find(
        (r) => r.user?.login.toLowerCase() === viewer.toLowerCase() && r.body?.includes(marker),
      );
      return mine
        ? { id: mine.id, url: mine.html_url, state: mine.state, nodeId: mine.node_id }
        : undefined;
    },

    async findPendingReview(repo, number, viewer) {
      const reviews = await octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { ...splitRepo(repo), pull_number: number, per_page: 100 },
      );
      const pending = reviews.find(
        (r) => r.state === "PENDING" && r.user?.login.toLowerCase() === viewer.toLowerCase(),
      );
      return pending ? { id: pending.id, body: pending.body ?? "" } : undefined;
    },

    async createReview(repo, number, payload) {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { ...splitRepo(repo), pull_number: number, ...payload },
      );
      return { id: Number(data.id), url: data.html_url, state: data.state, nodeId: data.node_id };
    },

    async submitReview(repo, number, reviewId, event) {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
        { ...splitRepo(repo), pull_number: number, review_id: reviewId, event },
      );
      return { id: Number(data.id), url: data.html_url, state: data.state, nodeId: data.node_id };
    },

    async listReviewThreads(repo, number) {
      const { owner, repo: name } = splitRepo(repo);
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadsPage = await octokit.graphql<ThreadsPage>(THREADS_QUERY, {
          owner,
          name,
          number,
          cursor,
        });
        const connection = page.repository?.pullRequest?.reviewThreads;
        if (!connection) throw new Error(`${repo}#${number} not found`);
        for (const t of connection.nodes) {
          threads.push({
            id: t.id,
            isResolved: t.isResolved,
            path: t.path,
            line: t.line,
            originalLine: t.originalLine,
            comments: t.comments.nodes.map((c) => ({
              id: c.databaseId,
              author: c.author?.login ?? "ghost",
              body: c.body,
              createdAt: c.createdAt,
              reviewId: c.pullRequestReview?.databaseId ?? null,
            })),
          });
        }
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor);
      return threads;
    },

    async replyInThread(reviewNodeId, threadId, body) {
      await octokit.graphql(
        `mutation ($review: ID!, $thread: ID!, $body: String!) {
           addPullRequestReviewThreadReply(
             input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }
           ) { comment { id } }
         }`,
        { review: reviewNodeId, thread: threadId, body },
      );
    },

    async resolveThread(threadId) {
      await octokit.graphql(
        `mutation ($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`,
        { id: threadId },
      );
    },

    async listIssueComments(repo, number, since) {
      const comments = await octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...splitRepo(repo), issue_number: number, since, per_page: 100 },
      );
      return comments.map((c) => ({
        author: c.user?.login ?? "ghost",
        body: c.body ?? "",
        createdAt: c.created_at,
      }));
    },

    async compareCommits(repo, base, head) {
      const route = "GET /repos/{owner}/{repo}/compare/{basehead}";
      const params = { ...splitRepo(repo), basehead: `${base}...${head}` };
      try {
        const { data } = await octokit.request(route, { ...params, per_page: 1 });
        // "ahead": head builds on base. Anything else means history was rewritten.
        if (data.status !== "ahead" && data.status !== "identical") {
          return { linear: false, patch: "" };
        }
      } catch (err) {
        // The old commit is gone after a force-push.
        if ((err as { status?: number }).status === 404) return { linear: false, patch: "" };
        throw err;
      }
      const { data } = await octokit.request(route, { ...params, mediaType: { format: "diff" } });
      // With the diff media type the body is the raw patch text.
      return { linear: true, patch: data as unknown as string };
    },

    async getReview(repo, number, reviewId) {
      try {
        const { data } = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
          { ...splitRepo(repo), pull_number: number, review_id: reviewId },
        );
        return { state: data.state, submittedAt: data.submitted_at ?? null };
      } catch (err) {
        // A pending review that was deleted is gone for good.
        if ((err as { status?: number }).status === 404) return undefined;
        throw err;
      }
    },

    async getCiState(repo, sha) {
      const ref = { ...splitRepo(repo), ref: sha };
      const [runs, status] = await Promise.all([
        octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
          ...ref,
          per_page: 100,
        }),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", ref),
      ]);
      return combineCi(runs, status.data.statuses);
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
