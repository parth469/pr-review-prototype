import { type FollowUpResult, findingMarker, type LedgerEntry, replyMarker } from "./followup.ts";
import { sortFindings } from "./report.ts";
import { type Finding, mustFix, type Review, type Verdict } from "./reviewer.ts";
import type { PullRequest, ReviewEventName } from "./types.ts";

export type ReviewEvent = "REQUEST_CHANGES" | "COMMENT" | "APPROVE";

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface ReviewDraft {
  event: ReviewEvent;
  body: string;
  comments: InlineComment[];
  /** Findings that could not be placed on a diff line, listed in the body instead. */
  outside: Finding[];
}

const MAX_BODY = 65_000;

const LABEL: Record<Finding["severity"], string> = {
  bug: "🔴 bug",
  risk: "🟡 risk",
  question: "❓ question",
  nit: "🔵 nit",
};

const PLURAL: Record<Finding["severity"], [string, string]> = {
  bug: ["bug", "bugs"],
  risk: ["risk", "risks"],
  question: ["question", "questions"],
  nit: ["nit", "nits"],
};

/** "**F2 · 🔴 bug**": the id lets the author name a finding in a PR comment. */
function tag(f: Finding): string {
  return f.id ? `**${f.id} · ${LABEL[f.severity]}**` : `**${LABEL[f.severity]}**`;
}

const blocksEvent = (f: Pick<Finding, "severity">) => f.severity === "bug" || f.severity === "risk";

/** Hidden marker that lets us find our own review again and never post it twice. */
export function reviewMarker(headSha: string): string {
  return `<!-- proxy-reviewer:${headSha} -->`;
}

function trim(text: string): string {
  return text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY - 20)}\n\n…(truncated)`;
}

export function countFindings(findings: Finding[]): string {
  const order: Finding["severity"][] = ["bug", "risk", "question", "nit"];
  return order
    .map((s) => {
      const n = findings.filter((f) => f.severity === s).length;
      return n === 0 ? "" : `${n} ${PLURAL[s][n === 1 ? 0 : 1]}`;
    })
    .filter(Boolean)
    .join(" · ");
}

export function chooseEvent(
  review: Review,
  pr: PullRequest,
  viewer: string,
  carried: LedgerEntry[] = [],
): ReviewEvent {
  // GitHub refuses REQUEST_CHANGES and APPROVE on your own PR.
  if (pr.author.toLowerCase() === viewer.toLowerCase()) return "COMMENT";
  // Nits and questions never block: without a bug or risk, approve. Earlier findings carried
  // into a full review follow the round-two rule: only must-fix ones block.
  return review.findings.some(blocksEvent) || carried.some(mustFix) ? "REQUEST_CHANGES" : "APPROVE";
}

export interface BuildInput {
  review: Review;
  pr: PullRequest;
  viewer: string;
  commentable: Map<string, Set<number>>;
  /** Put every finding in the body, e.g. after GitHub rejected the inline comments. */
  noInline?: boolean;
  /** Earlier bugs and risks still open, when a full review replaced a follow-up. */
  carried?: LedgerEntry[];
}

export function buildReview({
  review,
  pr,
  viewer,
  commentable,
  noInline = false,
  carried = [],
}: BuildInput): ReviewDraft {
  const comments: InlineComment[] = [];
  const outside: Finding[] = [];

  for (const f of sortFindings(review.findings)) {
    const lines = commentable.get(f.path);
    if (noInline || !lines?.has(f.line)) {
      outside.push(f);
      continue;
    }
    const marker = f.id ? `\n\n${findingMarker(pr.headSha, f.id)}` : "";
    const comment: InlineComment = {
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: `${trim(`${tag(f)} ${f.body}`)}${marker}`,
    };
    // A range becomes a multi-line comment ending at endLine, if every end is commentable.
    if (f.endLine && f.endLine > f.line && lines.has(f.endLine)) {
      comment.start_line = f.line;
      comment.start_side = "RIGHT";
      comment.line = f.endLine;
    }
    comments.push(comment);
  }

  const event = chooseEvent(review, pr, viewer, carried);
  const parts = [review.summary];
  if (review.findings.length > 0) parts.push(`**${countFindings(review.findings)}**`);
  if (outside.length > 0) {
    const heading = comments.length > 0 ? "Other findings" : "Findings";
    parts.push(
      `### ${heading}\n\n${outside.map((f) => `- ${tag(f)} \`${at(f)}\` ${f.body}`).join("\n")}`,
    );
  }
  if (carried.length > 0) {
    parts.push(
      [
        "### Still open from earlier reviews",
        "Too much changed for a follow-up, so this is a full review. These earlier points were not checked this time; the next round checks them:",
        carried.map((f) => `- ${tag(f)} \`${at(f)}\` ${headline(f.body)}`).join("\n"),
      ].join("\n\n"),
    );
  }
  if (outside.some((f) => f.id) || carried.length > 0) {
    parts.push("_To answer a point listed here, name its id (for example F2) in a PR comment._");
  }
  if (event === "COMMENT" && pr.author.toLowerCase() === viewer.toLowerCase()) {
    parts.push(
      "_Posted as a comment: GitHub does not allow approving or requesting changes on your own PR._",
    );
  }
  // The marker goes after trimming so a long review never loses it.
  const body = `${trim(parts.join("\n\n"))}\n\n${reviewMarker(pr.headSha)}`;
  return { event, body, comments, outside };
}

export interface ThreadReply {
  id: string;
  threadId: string;
  body: string;
  /** Resolve the thread once the review is submitted. */
  resolve: boolean;
}

export interface FollowUpDraft extends Omit<ReviewDraft, "event"> {
  event: ReviewEventName;
  /** false: leave it as a pending draft only you can see. */
  submit: boolean;
  replies: ThreadReply[];
}

export interface FollowUpBuildInput {
  review: Review;
  followUp: FollowUpResult;
  pr: PullRequest;
  /** Lines of the whole PR diff that can take a comment, for the new findings. */
  commentable: Map<string, Set<number>>;
  event: ReviewEventName;
  submit: boolean;
  note: string | null;
  resolveThreads: boolean;
  noInline?: boolean;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  fixed: "✅ fixed",
  explained: "💬 explained",
  no_longer_applies: "➖ no longer applies",
  partly_fixed: "🟠 partly fixed",
  not_fixed: "❌ not fixed",
};
const DONE: Verdict[] = ["fixed", "explained", "no_longer_applies"];
/** One table cell: the first sentence of a finding, on one line, without breaking the table. */
function headline(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const cut = sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
  return cut.replace(/\|/g, "\\|");
}

function at(f: Finding): string {
  return f.endLine && f.endLine > f.line
    ? `${f.path}:${f.line}-${f.endLine}`
    : `${f.path}:${f.line}`;
}

/**
 * Round two: a verdict table for the earlier findings, a reply in each finding's thread, and
 * inline comments for new problems. Nits and questions left alone get no reply: they were
 * optional, and the table already says so once.
 */
export function buildFollowUpReview(input: FollowUpBuildInput): FollowUpDraft {
  const { review, followUp, pr } = input;
  const base = buildReview({
    review,
    pr,
    viewer: "",
    commentable: input.commentable,
    noInline: input.noInline ?? false,
  });

  const replies: ThreadReply[] = [];
  const noThread: string[] = [];
  const rows: string[] = [];
  let leftOpen = review.findings.length > 0;
  for (const p of followUp.previous) {
    const optional = !mustFix(p) && !DONE.includes(p.verdict);
    rows.push(
      `| ${p.id} | ${LABEL[p.severity]} \`${at(p)}\` ${headline(p.body)} | ${VERDICT_LABEL[p.verdict]}${optional ? " (non-blocking)" : ""} |`,
    );
    if (!DONE.includes(p.verdict)) leftOpen = true;
    if (optional) continue;
    if (p.thread) {
      replies.push({
        id: p.id,
        threadId: p.thread.threadId,
        body: `${trim(p.reply)}\n\n${replyMarker(pr.headSha, p.id)}`,
        resolve: input.resolveThreads && DONE.includes(p.verdict) && !p.threadResolved,
      });
    } else {
      noThread.push(
        `- **${p.id}** ${VERDICT_LABEL[p.verdict]}: ${p.reply.replace(/\s+/g, " ").trim()}`,
      );
    }
  }

  const since = followUp.linear
    ? `changes since \`${followUp.prevSha.slice(0, 7)}\``
    : `history was rewritten since \`${followUp.prevSha.slice(0, 7)}\`, so every point was checked against the whole PR`;
  const parts = [`**Follow-up review** · round ${followUp.round} · ${since}`, review.summary];
  if (rows.length > 0) {
    parts.push(["| # | Earlier finding | Now |", "|---|---|---|", ...rows].join("\n"));
  }
  if (noThread.length > 0)
    parts.push(`### Earlier findings outside the diff\n\n${noThread.join("\n")}`);
  if (review.findings.length > 0) {
    parts.push(`**New since the last review: ${countFindings(review.findings)}**`);
  }
  if (base.outside.length > 0) {
    const heading = base.comments.length > 0 ? "Other new findings" : "New findings";
    parts.push(
      `### ${heading}\n\n${base.outside
        .map((f) => `- ${tag(f)} \`${at(f)}\` ${f.body}`)
        .join("\n")}`,
    );
  }
  if (noThread.length > 0 || base.outside.length > 0) {
    parts.push("_To answer a point listed here, name its id (for example F2) in a PR comment._");
  }
  if (input.note) parts.push(`_${input.note}_`);
  if (input.event === "APPROVE" && leftOpen) {
    parts.push("_Approving: what is left is non-blocking. Fix it here or in a later PR._");
  }

  return {
    event: input.event,
    submit: input.submit,
    body: `${trim(parts.join("\n\n"))}\n\n${reviewMarker(pr.headSha)}`,
    comments: base.comments,
    outside: base.outside,
    replies,
  };
}
