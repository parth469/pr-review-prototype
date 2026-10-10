import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { decide, matchesBranch, matchesRepo } from "../src/filters.ts";
import { defaultConfig, makePr } from "./helpers.ts";

describe("matchesRepo", () => {
  it.each([
    ["*", "acme/api", true],
    ["acme/*", "acme/api", true],
    ["acme/*", "acmecorp/api", false],
    ["acme/api", "acme/api", true],
    ["Acme/API", "acme/api", true],
    ["acme/api", "acme/web", false],
  ])("%s vs %s -> %s", (pattern, repo, expected) => {
    expect(matchesRepo(pattern, repo)).toBe(expected);
  });
});

describe("matchesBranch", () => {
  it.each([
    ["staging", "staging", true],
    ["staging", "staging-fix", false],
    ["cycle-*", "cycle-14", true],
    ["Cycle-*", "cycle-14", true],
    ["cycle-*", "parth/cycle-14", false],
    ["dev", "Dev", true],
  ])("%s vs %s -> %s", (pattern, ref, expected) => {
    expect(matchesBranch(pattern, ref)).toBe(expected);
  });
});

describe("decide", () => {
  it("queues an eligible PR", () => {
    expect(decide(makePr(), defaultConfig, "me")).toEqual({ action: "queue" });
  });

  it("lets deny win over allow", () => {
    const config = parseConfig({ repos: { allow: ["acme/*"], deny: ["acme/api"] } });
    expect(decide(makePr(), config, "me")).toEqual({ action: "skip", reason: "repo denied" });
  });

  it("skips repos outside the allowlist", () => {
    const config = parseConfig({ repos: { allow: ["other/*"] } });
    expect(decide(makePr(), config, "me")).toEqual({ action: "skip", reason: "repo not allowed" });
  });

  it("skips release branches listed in skipBranches", () => {
    const config = parseConfig({ skipBranches: ["staging", "cycle-*"] });
    expect(decide(makePr({ headRef: "cycle-14" }), config, "me")).toEqual({
      action: "skip",
      reason: "release branch (cycle-14)",
    });
    expect(decide(makePr({ headRef: "parth/kgit-1-fix" }), config, "me")).toEqual({
      action: "queue",
    });
    expect(decide(makePr({ headRef: "staging" }), defaultConfig, "me")).toEqual({
      action: "queue",
    });
  });

  it("skips drafts unless disabled", () => {
    const pr = makePr({ draft: true });
    expect(decide(pr, defaultConfig, "me")).toEqual({ action: "skip", reason: "draft" });
    expect(decide(pr, parseConfig({ skipDrafts: false }), "me")).toEqual({ action: "queue" });
  });

  it("skips the viewer's own PRs", () => {
    const pr = makePr({ author: "Me" });
    expect(decide(pr, defaultConfig, "me")).toEqual({ action: "skip", reason: "own PR" });
  });

  it("skips PRs over the size limit", () => {
    const pr = makePr({ changedLines: 5000 });
    expect(decide(pr, defaultConfig, "me")).toEqual({
      action: "skip",
      reason: "too large (5000 > 3000 lines)",
    });
  });
});
