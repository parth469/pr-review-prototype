import { describe, expect, it } from "vitest";
import { loadPrompt, renderPrompt } from "../src/prompt.ts";

describe("renderPrompt", () => {
  it("fills placeholders, with or without spaces", () => {
    expect(
      renderPrompt("/{{skill}} on {{ repo }}#{{number}}", {
        skill: "caveman:caveman-review",
        repo: "acme/api",
        number: 7,
      }),
    ).toBe("/caveman:caveman-review on acme/api#7");
  });

  it("rejects an unknown placeholder", () => {
    expect(() => renderPrompt("{{nope}}", {})).toThrow(/\{\{nope\}\}/);
  });

  it("renders the shipped review prompt with the skill on the first line", async () => {
    const text = await loadPrompt("prompts/review.md", {
      skill: "caveman:caveman-review",
      repo: "acme/api",
      number: 7,
      sha: "abc1234",
      baseRef: "main",
    });
    expect(text.split("\n")[0]).toBe("/caveman:caveman-review");
    expect(text).toContain("acme/api#7 at commit abc1234");
    expect(text).not.toMatch(/\{\{/);
  });
});
