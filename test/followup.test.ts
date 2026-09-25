import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countChangedLines,
  type FollowUpContext,
  finalizeFollowUp,
  findingMarker,
  type LedgerEntry,
  ledgerOf,
  matchThreads,
  needsCheck,
  prepareFollowUp,
  stripMarkers,
} from "../src/followup.ts";
import type { FollowUpOutput, ReviewRun } from "../src/reviewer.ts";
import type { Job } from "../src/state.ts";
import type { Comparison, FollowUpSource, IssueComment, ReviewThread } from "../src/types.ts";
import { defaultConfig, silentLog } from "./helpers.ts";

const prevSha = "a".repeat(40);
const headSha = "b".repeat(40);
const parent = {
  id: 1,
  repo: "acme/api",
  pr: 128,
  head_sha: prevSha,
  round: 1,
  updated_at: "2026-09-24T10:00:00Z",
} as Job;
const job = { id: 2, repo: "acme/api", pr: 128, head_sha: headSha, round: 2 } as Job;

// src/a.ts: line 2 changed since the last review; line 10 is outside the change.
const SINCE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");
const PR_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,12 @@",
  ...Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`),
].join("\n");

const firstRun: ReviewRun = {
  review: {
    summary: "s",
    verdict: "request_changes",
    findings: [
      { id: "F1", path: "src/a.ts", line: 2, severity: "bug", body: "Unsafe compare." },
      { id: "F2", path: "src/a.ts", line: 10, severity: "nit", body: "Rename x." },
    ],
  },
  costUsd: 1,
  durationMs: 1,
  numTurns: 1,
  sessionId: "s",
};

const thread = (id: string, body: string, extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  isResolved: false,
  path: "src/a.ts",
  line: 2,
  originalLine: 2,
  comments: [{ id: 50, author: "me", body, createdAt: "t", reviewId: 800 }],
  ...extra,
});

describe("helpers", () => {
  it("counts added and deleted lines, not file headers", () => {
    expect(countChangedLines(SINCE)).toBe(2);
  });

  it("strips our hidden markers from comment bodies", () => {
    expect(stripMarkers(`Fixed.\n\n${findingMarker(headSha, "F3")}`)).toBe("Fixed.");
  });
});

describe("ledgerOf", () => {
  it("starts from a first review's findings, all open, with saved threads", () => {
    const ledger = ledgerOf(parent, firstRun, {
      id: 800,
      url: "u",
      state: "CHANGES_REQUESTED",
      threads: { F1: { threadId: "T1", commentId: 50 } },
    });
    expect(ledger.map((e) => [e.id, e.status, e.sha, e.thread?.threadId ?? null])).toEqual([
      ["F1", "open", prevSha, "T1"],
      ["F2", "open", prevSha, null],
    ]);
  });

  it("numbers findings of a review saved before F-ids existed", () => {
    const old = {
      ...firstRun,
      review: {
        ...firstRun.review,
        findings: firstRun.review.findings.map(({ id, ...f }) => f).reverse(),
      },
    };
    expect(ledgerOf(parent, old).map((e) => [e.id, e.severity])).toEqual([
      ["F1", "bug"],
      ["F2", "nit"],
    ]);
  });

  it("rechecks open findings and blocking ones still open, not settled or skipped nits", () => {
    const e = (severity: LedgerEntry["severity"], status: LedgerEntry["status"]) =>
      ({ severity, status }) as LedgerEntry;
    const s = defaultConfig.followUp;
    expect(needsCheck(e("nit", "open"), s)).toBe(true);
    expect(needsCheck(e("bug", "partly_fixed"), s)).toBe(true);
    expect(needsCheck(e("risk", "not_fixed"), s)).toBe(true);
    expect(needsCheck(e("bug", "fixed"), s)).toBe(false);
    expect(needsCheck(e("nit", "not_fixed"), s)).toBe(false);
  });

  it("rechecks an explanation that still needs your OK, until you accepted it", () => {
    const s = defaultConfig.followUp;
    const explained = { severity: "bug", status: "explained" } as LedgerEntry;
    expect(needsCheck(explained, s)).toBe(true);
    expect(needsCheck({ ...explained, accepted: true }, s)).toBe(false);
    expect(needsCheck({ ...explained, severity: "risk" }, s)).toBe(true);
    expect(needsCheck(explained, { ...s, explainedBugNeedsYou: false })).toBe(false);
    expect(needsCheck({ ...explained, severity: "nit" }, s)).toBe(false);
  });
});

describe("matchThreads", () => {
  const ledger = ledgerOf(parent, firstRun);

  it("finds threads by our hidden marker", () => {
    const threads = [
      thread("T-other", "someone else", {
        comments: [{ id: 1, author: "bob", body: "x", createdAt: "t", reviewId: 1 }],
      }),
      thread("T1", `bug\n\n${findingMarker(prevSha, "F1")}`),
    ];
    const { matched, byLine } = matchThreads(ledger, threads, "me");
    expect(matched.get("F1")?.id).toBe("T1");
    expect(matched.has("F2")).toBe(false);
    expect(byLine).toBe(0);
  });

  it("prefers the saved thread id", () => {
    const withThread = ledger.map((e) =>
      e.id === "F1" ? { ...e, thread: { threadId: "T9", commentId: 9 } } : e,
    );
    const threads = [thread("T1", findingMarker(prevSha, "F1")), thread("T9", "old")];
    expect(matchThreads(withThread, threads, "me").matched.get("F1")?.id).toBe("T9");
  });

  it("falls back to our own comment on the same file and line for old reviews", () => {
    const threads = [
      thread("T-old", "**🔴 bug** Unsafe compare.", { line: null, originalLine: 2 }),
      thread("T-marked", findingMarker("c".repeat(40), "F7"), { line: 10, originalLine: 10 }),
    ];
    const { matched, byLine } = matchThreads(ledger, threads, "me");
    expect(matched.get("F1")?.id).toBe("T-old");
    expect(matched.has("F2")).toBe(false); // a thread with a marker is never guessed at
    expect(byLine).toBe(1);
  });
});

function fakeSource(
  opts: {
    compare?: Comparison;
    threads?: ReviewThread[];
    comments?: IssueComment[];
    review?: { state: string; submittedAt: string | null };
  } = {},
): FollowUpSource & { since?: string } {
  const source: FollowUpSource & { since?: string } = {
    compareCommits: async () => opts.compare ?? { linear: true, patch: SINCE },
    getReview: async () => opts.review,
    listReviewThreads: async () => opts.threads ?? [],
    listIssueComments: async (_r, _n, since) => {
      source.since = since;
      return opts.comments ?? [];
    },
  };
  return source;
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "proxy-fu-"));
  mkdirSync(join(dir, ".review"));
  return dir;
}

const prepareInput = (dir: string, freshReviewOverLines = 1000) => ({
  job,
  parent,
  parentRun: firstRun,
  prAuthor: "teammate",
  diff: PR_DIFF,
  dir,
  settings: { ...defaultConfig.followUp, freshReviewOverLines },
});

describe("prepareFollowUp", () => {
  it("writes previous.json, threads.json and since-last.patch for Claude", async () => {
    const dir = checkout();
    const threads = [
      thread("T1", `bug ${findingMarker(prevSha, "F1")}`, {
        comments: [
          {
            id: 50,
            author: "me",
            body: `bug ${findingMarker(prevSha, "F1")}`,
            createdAt: "t",
            reviewId: 800,
          },
          {
            id: 51,
            author: "teammate",
            body: "Fixed with timingSafeEqual.",
            createdAt: "t",
            reviewId: null,
          },
        ],
      }),
    ];
    const source = fakeSource({
      threads,
      comments: [{ author: "teammate", body: "Pushed fixes.", createdAt: "t" }],
    });
    const plan = await prepareFollowUp({ source, viewer: "me", log: silentLog }, prepareInput(dir));
    if (plan.kind !== "follow-up") throw new Error("expected a follow-up");

    expect(source.since).toBe(parent.updated_at);
    expect(plan.context.toCheck.map((e) => e.id)).toEqual(["F1", "F2"]);
    expect(plan.context.replied).toEqual(new Set(["F1"]));
    expect(plan.context.authorComments).toEqual(["Pushed fixes."]);
    const read = (name: string) => readFileSync(join(dir, ".review", name), "utf8");
    expect(JSON.parse(read("previous.json"))[0]).toMatchObject({
      id: "F1",
      severity: "bug",
      raisedIn: { round: 1, commit: "aaaaaaa" },
      thread: "open",
    });
    const t = JSON.parse(read("threads.json"));
    expect(t.findings[0].comments).toEqual([
      { by: "you (the reviewer)", body: "bug" },
      { by: "PR author", body: "Fixed with timingSafeEqual." },
    ]);
    expect(t.conversation).toEqual([{ by: "PR author", at: "t", body: "Pushed fixes." }]);
    expect(read("since-last.patch")).toBe(SINCE);
  });

  it("uses the whole PR diff after a force-push", async () => {
    const dir = checkout();
    const plan = await prepareFollowUp(
      {
        source: fakeSource({ compare: { linear: false, patch: "" } }),
        viewer: "me",
        log: silentLog,
      },
      prepareInput(dir),
    );
    expect(plan).toMatchObject({
      kind: "follow-up",
      context: { linear: false, sinceLast: PR_DIFF },
    });
  });

  it("asks for a fresh review when too much changed", async () => {
    const plan = await prepareFollowUp(
      { source: fakeSource(), viewer: "me", log: silentLog },
      prepareInput(checkout(), 1),
    );
    expect(plan).toMatchObject({
      kind: "fresh",
      reason: "2 lines changed since the last review (over 1)",
      nextId: 3,
    });
    // The open bug is carried into the full review; the nit is not.
    if (plan.kind !== "fresh") throw new Error("expected fresh");
    expect(plan.carried.map((e) => e.id)).toEqual(["F1"]);
  });

  it("leaves out changes to files outside the PR, e.g. from merging the base branch", async () => {
    const merged = [
      SINCE,
      "diff --git a/vendor/big.ts b/vendor/big.ts",
      "--- a/vendor/big.ts",
      "+++ b/vendor/big.ts",
      "@@ -1,1 +1,3 @@",
      "-a",
      "+b",
      "+c",
      "+d",
    ].join("\n");
    const plan = await prepareFollowUp(
      {
        source: fakeSource({ compare: { linear: true, patch: merged } }),
        viewer: "me",
        log: silentLog,
      },
      prepareInput(checkout(), 2),
    );
    if (plan.kind !== "follow-up") throw new Error("expected a follow-up");
    expect(plan.context.sinceLast).not.toContain("vendor/big.ts");
    expect(plan.context.sinceLastLines).toBe(2);
  });

  it("reads comments from when the earlier review was submitted", async () => {
    const source = fakeSource({
      review: { state: "APPROVED", submittedAt: "2026-09-24T12:00:00Z" },
    });
    await prepareFollowUp(
      { source, viewer: "me", log: silentLog },
      { ...prepareInput(checkout()), parent: { ...parent, review_id: 800 } as Job },
    );
    expect(source.since).toBe("2026-09-24T12:00:00Z");
  });

  it("accepts explanations once you submit the draft that carried them as an approval", async () => {
    const explainedRun: ReviewRun = {
      ...firstRun,
      followUp: {
        round: 2,
        parentJobId: 0,
        prevSha,
        linear: true,
        sinceLastLines: 2,
        previous: [],
        ledger: [
          {
            id: "F1",
            path: "src/a.ts",
            line: 2,
            severity: "bug",
            body: "b",
            sha: prevSha,
            round: 1,
            status: "explained",
            thread: null,
          },
        ],
      },
    };
    const plan = async (review?: { state: string; submittedAt: string | null }) => {
      const result = await prepareFollowUp(
        { source: fakeSource(review ? { review } : {}), viewer: "me", log: silentLog },
        {
          ...prepareInput(checkout()),
          parent: { ...parent, review_id: 900 } as Job,
          parentRun: explainedRun,
          posted: { id: 900, url: "u", state: "PENDING", needsYou: "explained bug F1" },
        },
      );
      if (result.kind !== "follow-up") throw new Error("expected a follow-up");
      return result.context;
    };
    const submitted = await plan({ state: "APPROVED", submittedAt: "t" });
    expect(submitted.toCheck).toEqual([]);
    expect(submitted.settled[0]).toMatchObject({ id: "F1", accepted: true });
    // You deleted the draft: the explanation is checked again, and waits for you again.
    const deleted = await plan();
    expect(deleted.toCheck.map((e) => e.id)).toEqual(["F1"]);
  });
});

function context(overrides: Partial<FollowUpContext> = {}): FollowUpContext {
  const ledger = ledgerOf(parent, firstRun);
  return {
    job,
    parent,
    prevSha,
    linear: true,
    sinceLast: SINCE,
    sinceLastLines: 2,
    toCheck: ledger,
    settled: [],
    threads: new Map([["F1", thread("T1", "bug")]]),
    replied: new Set(),
    authorComments: [],
    ...overrides,
  };
}

const verdict = (
  id: string,
  v: FollowUpOutput["previous"][number]["verdict"],
  fixedAt: Array<{ path: string; line: number }> = [],
) => ({ id, verdict: v, fixedAt, evidence: "because", reply: `Reply ${id}` });

describe("finalizeFollowUp", () => {
  it("fails the run unless every earlier finding has exactly one verdict", () => {
    const out = (previous: FollowUpOutput["previous"]) => ({
      summary: "s",
      previous,
      findings: [],
    });
    expect(() =>
      finalizeFollowUp(context(), out([verdict("F1", "fixed")]), PR_DIFF, silentLog),
    ).toThrow("missing F2");
    expect(() =>
      finalizeFollowUp(
        context(),
        out([verdict("F1", "not_fixed"), verdict("F2", "fixed"), verdict("F9", "fixed")]),
        PR_DIFF,
        silentLog,
      ),
    ).toThrow("unknown F9");
    expect(() =>
      finalizeFollowUp(
        context(),
        out([verdict("F1", "not_fixed"), verdict("F1", "fixed"), verdict("F2", "fixed")]),
        PR_DIFF,
        silentLog,
      ),
    ).toThrow("repeated F1");
  });

  it("keeps a fix that points at a changed line, and links the thread", () => {
    const { followUp, review } = finalizeFollowUp(
      context(),
      {
        summary: "s",
        previous: [
          verdict("F1", "fixed", [{ path: "src/a.ts", line: 2 }]),
          verdict("F2", "not_fixed"),
        ],
        findings: [],
      },
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous[0]).toMatchObject({
      id: "F1",
      verdict: "fixed",
      thread: { threadId: "T1", commentId: 50 },
      reply: "Reply F1",
    });
    expect(followUp.previous[0]?.overruled).toBeUndefined();
    // A nit left open does not keep the review in "request changes".
    expect(review.verdict).toBe("no_issues");
  });

  it("overrules a fix that cites no changed line", () => {
    const { followUp, review } = finalizeFollowUp(
      context(),
      {
        summary: "s",
        previous: [
          verdict("F1", "fixed", [{ path: "src/a.ts", line: 10 }]),
          verdict("F2", "partly_fixed"),
        ],
        findings: [],
      },
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous.map((p) => p.verdict)).toEqual(["not_fixed", "not_fixed"]);
    expect(followUp.previous[0]?.overruled).toBe(
      "Claude said fixed, but no line cited for the fix was added since aaaaaaa",
    );
    expect(followUp.previous[0]?.reply).toContain("couldn't find a change");
    expect(review.verdict).toBe("request_changes");
  });

  it("accepts an explanation only when someone else replied", () => {
    const answer = {
      summary: "s",
      previous: [verdict("F1", "explained"), verdict("F2", "not_fixed")],
      findings: [],
    };
    const none = finalizeFollowUp(context(), answer, PR_DIFF, silentLog);
    expect(none.followUp.previous[0]?.verdict).toBe("not_fixed");

    const inThread = finalizeFollowUp(
      context({ replied: new Set(["F1"]) }),
      answer,
      PR_DIFF,
      silentLog,
    );
    expect(inThread.followUp.previous[0]?.verdict).toBe("explained");

    const unrelated = context({ authorComments: ["Thanks for the review!"] });
    expect(
      finalizeFollowUp(unrelated, answer, PR_DIFF, silentLog).followUp.previous[0]?.verdict,
    ).toBe("not_fixed");
    // A finding with no thread is not explained by just any comment either.
    const noThread = context({ threads: new Map(), authorComments: ["Thanks!"] });
    expect(
      finalizeFollowUp(noThread, answer, PR_DIFF, silentLog).followUp.previous[0]?.verdict,
    ).toBe("not_fixed");
    const naming = context({ authorComments: ["F1 is intended: the map is capped at 500."] });
    expect(finalizeFollowUp(naming, answer, PR_DIFF, silentLog).followUp.previous[0]?.verdict).toBe(
      "explained",
    );
  });

  const two = (a: FollowUpOutput["previous"][number], b = verdict("F2", "not_fixed")) => ({
    summary: "s",
    previous: [a, b],
    findings: [],
  });

  it("overrules a fix that cites only a context line of the change", () => {
    // Line 1 is a context line in SINCE, not a change.
    const { followUp } = finalizeFollowUp(
      context(),
      two(verdict("F1", "fixed", [{ path: "src/a.ts", line: 1 }])),
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous[0]).toMatchObject({ verdict: "not_fixed" });
  });

  it("overrules no_longer_applies when the finding's file did not change", () => {
    const elsewhere = ledgerOf(parent, firstRun).map((e) =>
      e.id === "F1" ? { ...e, path: "src/other.ts" } : e,
    );
    const { followUp } = finalizeFollowUp(
      context({ toCheck: elsewhere }),
      two(verdict("F1", "no_longer_applies")),
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous[0]).toMatchObject({
      verdict: "not_fixed",
      overruled: "Claude said no_longer_applies, but src/other.ts did not change since aaaaaaa",
    });
    const same = finalizeFollowUp(
      context(),
      two(verdict("F1", "no_longer_applies")),
      PR_DIFF,
      silentLog,
    );
    expect(same.followUp.previous[0]).toMatchObject({ verdict: "no_longer_applies" });
    expect(same.followUp.previous[0]?.needsYou).toBeUndefined();
  });

  it("leaves a bug fixed only in another file to you", () => {
    const elsewhere = ledgerOf(parent, firstRun).map((e) =>
      e.id === "F1" ? { ...e, path: "src/other.ts" } : e,
    );
    const { followUp } = finalizeFollowUp(
      context({ toCheck: elsewhere }),
      two(verdict("F1", "fixed", [{ path: "src/a.ts", line: 2 }])),
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous[0]).toMatchObject({
      verdict: "fixed",
      needsYou: "F1 fixed only in another file (src/a.ts): check it",
    });
    // Never saved in the ledger: next round decides again.
    expect(followUp.ledger[0]).not.toHaveProperty("needsYou");
  });

  it("leaves a bug fixed after a force-push to you", () => {
    const { followUp } = finalizeFollowUp(
      context({ linear: false }),
      two(verdict("F1", "fixed", [{ path: "src/a.ts", line: 2 }])),
      PR_DIFF,
      silentLog,
    );
    expect(followUp.previous[0]?.needsYou).toBe("F1 fixed after a force-push: check it");
  });

  it("numbers new findings after the earlier ones and drops those outside the new changes", () => {
    const { review, followUp } = finalizeFollowUp(
      context(),
      {
        summary: "s",
        previous: [
          verdict("F1", "fixed", [{ path: "src/a.ts", line: 2 }]),
          verdict("F2", "fixed", [{ path: "src/a.ts", line: 2 }]),
        ],
        findings: [
          { path: "src/a.ts", line: 2, severity: "risk", body: "New risk." },
          { path: "src/a.ts", line: 10, severity: "bug", body: "Untouched code." },
          { path: "src/a.ts", line: 3, severity: "bug", body: "Context line only." },
        ],
      },
      PR_DIFF,
      silentLog,
    );
    expect(review.findings).toEqual([
      { id: "F3", path: "src/a.ts", line: 2, severity: "risk", body: "New risk." },
    ]);
    expect(review.verdict).toBe("request_changes");
    expect(followUp.ledger.map((e) => [e.id, e.status, e.sha.slice(0, 1), e.round])).toEqual([
      ["F1", "fixed", "a", 1],
      ["F2", "fixed", "a", 1],
      ["F3", "open", "b", 2],
    ]);
  });
});
