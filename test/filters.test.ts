import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { decide, matchesRepo } from "../src/filters.ts";
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
