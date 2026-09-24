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
