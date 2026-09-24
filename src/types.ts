/** A PR where the viewer is a directly requested reviewer, with the details needed to decide on it. */
export interface PullRequest {
  repo: string; // "owner/name"
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  draft: boolean;
  changedLines: number;
}

/** Minimal GitHub surface the poller needs, so tests can swap in a fake. */
export interface GitHubClient {
  searchReviewRequests(): Promise<Array<{ repo: string; number: number }>>;
  getPull(repo: string, number: number): Promise<PullRequest>;
}
