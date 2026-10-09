import { describe, expect, it } from "vitest";
import {
  fenced,
  findingMarkdown,
  findingTitle,
  isStructured,
  suggestionBlock,
} from "../src/finding-text.ts";
import type { Finding } from "../src/reviewer.ts";

const readable: Finding = {
  path: "src/fetcher.ts",
  line: 122,
  endLine: 124,
  severity: "bug",
  title: "Stop button may not stop the request",
  problem: "A cancel that happens while the login token loads is missed.",
  impact: "The request keeps running for up to 15 s after the user clicks Stop.",
  fix: "Check `signal.aborted` before adding the listener.",
  suggestion: "  if (signal?.aborted) timeoutController.abort();\n",
  why: "- The listener is added after `await getElectronToken()`.",
};
const legacy: Finding = { path: "a.ts", line: 1, severity: "nit", body: "Rename x. It is vague." };

describe("finding text", () => {
  it("tells readable findings from legacy ones", () => {
    expect(isStructured(readable)).toBe(true);
    expect(isStructured(legacy)).toBe(false);
  });

  it("titles a finding by its title, or a legacy body's first sentence", () => {
    expect(findingTitle(readable)).toBe("Stop button may not stop the request");
    expect(findingTitle(legacy)).toBe("Rename x.");
  });

  it("lays out the parts, the suggestion and the folded reasoning", () => {
    expect(findingMarkdown(readable, { suggestion: true })).toBe(
      [
        "**What's wrong:** A cancel that happens while the login token loads is missed.",
        "**What happens if not fixed:** The request keeps running for up to 15 s after the user clicks Stop.",
        "**Fix:** Check `signal.aborted` before adding the listener.",
        "",
        "```suggestion",
        "  if (signal?.aborted) timeoutController.abort();",
        "```",
        "",
        "<details><summary>Why I think so</summary>",
        "",
        "- The listener is added after `await getElectronToken()`.",
        "</details>",
      ].join("\n"),
    );
    expect(findingMarkdown(readable)).not.toContain("```suggestion");
    expect(findingMarkdown(legacy)).toBe(legacy.body);
  });

  it("uses a fence the code's own backticks cannot close", () => {
    expect(fenced("const s = ```x```;")).toBe("````\nconst s = ```x```;\n````");
    expect(suggestionBlock("a\n\n")).toBe("```suggestion\na\n```");
  });
});
