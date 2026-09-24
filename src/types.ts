/** A PR where the viewer is a directly requested reviewer, with the details needed to decide on it. */
export interface PullRequest {
  repo: string; // "owner/name"
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headSha: string;
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
  state: string; // "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | ...
}

export interface CreateReviewPayload {
  commit_id: string;
  body: string;
  /** Omitted: GitHub creates a pending review only the author can see. */
  event?: "REQUEST_CHANGES" | "COMMENT";
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
}
