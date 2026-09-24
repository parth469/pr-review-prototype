import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollOnce } from "../src/poller.ts";
import { openState, type State } from "../src/state.ts";
import type { GitHubClient, PullRequest } from "../src/types.ts";
import { defaultConfig, makePr, silentLog } from "./helpers.ts";

function fakeGitHub(prs: PullRequest[], failing: number[] = []): GitHubClient {
  return {
    searchReviewRequests: async () => prs.map((p) => ({ repo: p.repo, number: p.number })),
    getPull: async (repo, number) => {
      if (failing.includes(number)) throw new Error("boom");
      const pr = prs.find((p) => p.repo === repo && p.number === number);
      if (!pr) throw new Error("not found");
      return pr;
    },
  };
}

describe("pollOnce", () => {
  let state: State;
  beforeEach(() => {
    state = openState(":memory:");
  });
  afterEach(() => state.close());

  const deps = (github: GitHubClient) => ({
    github,
    state,
    config: defaultConfig,
    viewer: "me",
    log: silentLog,
  });

  it("queues eligible PRs, skips drafts, and reports nothing new on the next run", async () => {
    const github = fakeGitHub([makePr({ number: 1 }), makePr({ number: 2, draft: true })]);

    expect(await pollOnce(deps(github))).toEqual({
      found: 2,
      queued: 1,
      skipped: 1,
      known: 0,
      errors: 0,
    });
    expect(await pollOnce(deps(github))).toEqual({
      found: 2,
      queued: 0,
      skipped: 0,
      known: 2,
      errors: 0,
    });
  });

  it("keeps going when one PR fails to load", async () => {
    const github = fakeGitHub([makePr({ number: 1 }), makePr({ number: 2 })], [1]);
    const summary = await pollOnce(deps(github));
    expect(summary).toMatchObject({ queued: 1, errors: 1 });
    expect(state.listByStatus("queued").map((j) => j.pr)).toEqual([2]);
  });
});
