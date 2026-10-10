/** A PR where the viewer is a directly requested reviewer, with the details needed to decide on it. */
export interface PullRequest {
  repo: string; // "owner/name"
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headSha: string;
  /** The PR's own branch, e.g. "parth/kgit-1316-…". */
  headRef: string;
  baseRef: string;
  baseSha: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  changedLines: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

/** Minimal GitHub surface the poller needs, so tests can swap in a fake. */
export interface GitHubClient {
  searchReviewRequests(): Promise<Array<{ repo: string; number: number }>>;
  getPull(repo: string, number: number): Promise<PullRequest>;
}

/** Extra GitHub reads the worker needs to prepare a review. */
export interface PullSource {
  getPull(repo: string, number: number): Promise<PullRequest>;
  getPullDiff(repo: string, number: number): Promise<string>;
  listPullFiles(repo: string, number: number): Promise<PullFile[]>;
}

export interface PostedReview {
  id: number;
  url: string;
  state: string; // "CHANGES_REQUESTED" | "COMMENTED" | "APPROVED" | "PENDING" | ...
  /** GraphQL id, needed to add thread replies to the review. */
  nodeId?: string;
}

/** Where one of our inline findings lives on GitHub, saved in posted.json after posting. */
export interface ThreadRef {
  threadId: string;
  commentId: number;
}

export interface ThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  /** The review the comment belongs to; null for a comment posted outside a review. */
  reviewId: number | null;
}

/** An inline comment thread on a PR, as the GraphQL reviewThreads connection describes it. */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: ThreadComment[];
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Changes from one commit to another, and whether the second still builds on the first. */
export interface Comparison {
  /** false after a force-push or rebase: the old commit is not an ancestor any more. */
  linear: boolean;
  patch: string;
}

/** GitHub reads the worker needs to prepare a follow-up review. */
export interface FollowUpSource {
  listReviewThreads(repo: string, number: number): Promise<ReviewThread[]>;
  /** PR conversation comments, oldest first, created at or after `since`. */
  listIssueComments(repo: string, number: number, since: string): Promise<IssueComment[]>;
  compareCommits(repo: string, base: string, head: string): Promise<Comparison>;
  /** One review's state now; undefined if it was deleted. submittedAt is null while pending. */
  getReview(
    repo: string,
    number: number,
    reviewId: number,
  ): Promise<{ state: string; submittedAt: string | null } | undefined>;
}

export interface CreateReviewPayload {
  commit_id: string;
  body: string;
  /** Omitted: GitHub creates a pending review only the author can see. */
  event?: ReviewEventName;
  comments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  }>;
}

/** GitHub calls the publisher needs. */
export interface ReviewTarget {
  getPull(repo: string, number: number): Promise<PullRequest>;
  listRequestedReviewers(repo: string, number: number): Promise<string[]>;
  findOwnReview(
    repo: string,
    number: number,
    viewer: string,
    marker: string,
  ): Promise<PostedReview | undefined>;
  createReview(repo: string, number: number, payload: CreateReviewPayload): Promise<PostedReview>;
  listReviewThreads(repo: string, number: number): Promise<ReviewThread[]>;
  /** Submit a pending review. */
  submitReview(
    repo: string,
    number: number,
    reviewId: number,
    event: ReviewEventName,
  ): Promise<PostedReview>;
  /** Reply in a thread, as part of the given (pending) review. */
  replyInThread(reviewNodeId: string, threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
}

export type ReviewEventName = "REQUEST_CHANGES" | "COMMENT" | "APPROVE";
