import { sortFindings } from "./report.ts";
import type { Finding, Review } from "./reviewer.ts";
import type { PullRequest } from "./types.ts";

export type ReviewEvent = "REQUEST_CHANGES" | "COMMENT";

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

export function chooseEvent(review: Review, pr: PullRequest, viewer: string): ReviewEvent {
  // GitHub refuses REQUEST_CHANGES on your own PR.
  if (pr.author.toLowerCase() === viewer.toLowerCase()) return "COMMENT";
  return review.findings.some((f) => f.severity === "bug" || f.severity === "risk")
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

export interface BuildInput {
  review: Review;
  pr: PullRequest;
  viewer: string;
  commentable: Map<string, Set<number>>;
  /** Put every finding in the body, e.g. after GitHub rejected the inline comments. */
  noInline?: boolean;
}

export function buildReview({
  review,
  pr,
  viewer,
  commentable,
  noInline = false,
}: BuildInput): ReviewDraft {
  const comments: InlineComment[] = [];
  const outside: Finding[] = [];

  for (const f of sortFindings(review.findings)) {
    const lines = commentable.get(f.path);
    if (noInline || !lines?.has(f.line)) {
      outside.push(f);
      continue;
    }
    const comment: InlineComment = {
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: trim(`**${LABEL[f.severity]}** ${f.body}`),
    };
    // A range becomes a multi-line comment ending at endLine, if every end is commentable.
    if (f.endLine && f.endLine > f.line && lines.has(f.endLine)) {
      comment.start_line = f.line;
      comment.start_side = "RIGHT";
      comment.line = f.endLine;
    }
    comments.push(comment);
  }

  const event = chooseEvent(review, pr, viewer);
  const parts = [review.summary];
  if (review.findings.length > 0) parts.push(`**${countFindings(review.findings)}**`);
  if (outside.length > 0) {
    const heading = comments.length > 0 ? "Other findings" : "Findings";
    parts.push(
      `### ${heading}\n\n${outside
        .map((f) => {
          const at = f.endLine && f.endLine > f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
          return `- **${LABEL[f.severity]}** \`${f.path}:${at}\` ${f.body}`;
        })
        .join("\n")}`,
    );
  }
  if (event === "COMMENT" && pr.author.toLowerCase() === viewer.toLowerCase()) {
    parts.push("_Posted as a comment: GitHub does not allow requesting changes on your own PR._");
  }
  // The marker goes after trimming so a long review never loses it.
  const body = `${trim(parts.join("\n\n"))}\n\n${reviewMarker(pr.headSha)}`;
  return { event, body, comments, outside };
}
