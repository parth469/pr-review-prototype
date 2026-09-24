import { describe, expect, it } from "vitest";
import { buildReview, chooseEvent, reviewMarker } from "../src/publish.ts";
import type { Finding, Review } from "../src/reviewer.ts";
import { makePr } from "./helpers.ts";

const pr = makePr({ author: "teammate" });
const f = (severity: Finding["severity"], line = 5, path = "src/a.ts"): Finding => ({
  path,
  line,
  severity,
  body: `${severity} text`,
});
const review = (findings: Finding[]): Review => ({
  summary: "Summary here.",
  verdict: findings.length ? "request_changes" : "no_issues",
  findings,
});
const commentable = new Map([["src/a.ts", new Set([5, 6, 7])]]);

describe("chooseEvent", () => {
  it("requests changes only for bugs or risks", () => {
    expect(chooseEvent(review([f("bug")]), pr, "me")).toBe("REQUEST_CHANGES");
    expect(chooseEvent(review([f("risk"), f("nit")]), pr, "me")).toBe("REQUEST_CHANGES");
    expect(chooseEvent(review([f("nit"), f("question")]), pr, "me")).toBe("COMMENT");
    expect(chooseEvent(review([]), pr, "me")).toBe("COMMENT");
  });

  it("comments on your own PR, which GitHub won't let you request changes on", () => {
    expect(chooseEvent(review([f("bug")]), makePr({ author: "Me" }), "me")).toBe("COMMENT");
  });
});

describe("buildReview", () => {
  it("puts diff findings inline and the rest in the body", () => {
    const draft = buildReview({
      review: review([f("nit", 6), f("bug", 5), f("risk", 99), f("bug", 1, "other.ts")]),
      pr,
      viewer: "me",
      commentable,
    });
    expect(draft.event).toBe("REQUEST_CHANGES");
    expect(draft.comments).toEqual([
      { path: "src/a.ts", line: 5, side: "RIGHT", body: "**🔴 bug** bug text" },
      { path: "src/a.ts", line: 6, side: "RIGHT", body: "**🔵 nit** nit text" },
    ]);
    expect(draft.outside.map((x) => `${x.path}:${x.line}`)).toEqual(["other.ts:1", "src/a.ts:99"]);
    expect(draft.body).toContain("### Other findings");
    expect(draft.body).toContain("`src/a.ts:99`");
    expect(draft.body).toContain("**2 bugs · 1 risk · 1 nit**");
    expect(draft.body.endsWith(reviewMarker(pr.headSha))).toBe(true);
  });

  it("makes a multi-line comment when both ends are in the diff", () => {
    const draft = buildReview({
      review: review([{ ...f("risk", 5), endLine: 7 }]),
      pr,
      viewer: "me",
      commentable,
    });
    expect(draft.comments[0]).toMatchObject({
      start_line: 5,
      start_side: "RIGHT",
      line: 7,
      side: "RIGHT",
    });
  });

  it("falls back to a single line when the range leaves the diff", () => {
    const draft = buildReview({
      review: review([{ ...f("risk", 6), endLine: 40 }]),
      pr,
      viewer: "me",
      commentable,
    });
    expect(draft.comments[0]).toMatchObject({ line: 6 });
    expect(draft.comments[0]).not.toHaveProperty("start_line");
  });

  it("moves everything into the body with noInline", () => {
    const draft = buildReview({
      review: review([f("bug", 5)]),
      pr,
      viewer: "me",
      commentable,
      noInline: true,
    });
    expect(draft.comments).toEqual([]);
    expect(draft.body).toContain("### Findings");
  });

  it("notes the fallback to a comment on your own PR", () => {
    const draft = buildReview({
      review: review([f("bug", 5)]),
      pr: makePr({ author: "me" }),
      viewer: "me",
      commentable,
    });
    expect(draft.event).toBe("COMMENT");
    expect(draft.body).toContain("does not allow requesting changes on your own PR");
  });

  it("keeps the marker even when the body is trimmed", () => {
    const huge = { ...review([]), summary: "x".repeat(70_000) };
    const draft = buildReview({ review: huge, pr, viewer: "me", commentable });
    expect(draft.body.length).toBeLessThan(65_600);
    expect(draft.body).toContain("…(truncated)");
    expect(draft.body.endsWith(reviewMarker(pr.headSha))).toBe(true);
  });
});
