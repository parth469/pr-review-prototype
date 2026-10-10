import type { Config } from "./config.ts";
import type { PullRequest } from "./types.ts";

export type Decision = { action: "queue" } | { action: "skip"; reason: string };

/** Patterns: "*", "owner/*" or "owner/name". Case-insensitive, like GitHub names. */
export function matchesRepo(pattern: string, repo: string): boolean {
  const p = pattern.toLowerCase();
  const r = repo.toLowerCase();
  if (p === "*") return true;
  if (p.endsWith("/*")) return r.startsWith(p.slice(0, -1));
  return p === r;
}

/** Patterns: an exact branch name or a prefix ending in "*". Case-insensitive. */
export function matchesBranch(pattern: string, ref: string): boolean {
  const p = pattern.toLowerCase();
  const r = ref.toLowerCase();
  if (p.endsWith("*")) return r.startsWith(p.slice(0, -1));
  return p === r;
}

export function decide(pr: PullRequest, config: Config, viewer: string): Decision {
  const { allow, deny } = config.repos;
  if (deny.some((p) => matchesRepo(p, pr.repo))) {
    return { action: "skip", reason: "repo denied" };
  }
  if (!allow.some((p) => matchesRepo(p, pr.repo))) {
    return { action: "skip", reason: "repo not allowed" };
  }
  if (config.skipBranches.some((p) => matchesBranch(p, pr.headRef))) {
    return { action: "skip", reason: `release branch (${pr.headRef})` };
  }
  if (config.skipDrafts && pr.draft) {
    return { action: "skip", reason: "draft" };
  }
  if (config.skipOwnPrs && pr.author.toLowerCase() === viewer.toLowerCase()) {
    return { action: "skip", reason: "own PR" };
  }
  if (pr.changedLines > config.maxChangedLines) {
    return {
      action: "skip",
      reason: `too large (${pr.changedLines} > ${config.maxChangedLines} lines)`,
    };
  }
  return { action: "queue" };
}
