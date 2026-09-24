import type { Finding, ReviewRun } from "./reviewer.ts";
import type { PullRequest } from "./types.ts";

const SEVERITY_ORDER: Finding["severity"][] = ["bug", "risk", "question", "nit"];
const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  bug: "🔴 bug",
  risk: "🟡 risk",
  question: "❓ question",
  nit: "🔵 nit",
};

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}

function location(f: Finding): string {
  return f.endLine && f.endLine !== f.line
    ? `${f.path}:${f.line}-${f.endLine}`
    : `${f.path}:${f.line}`;
}

/** Local, human-readable copy of the review. M3 builds the GitHub review from result.json. */
export function renderReviewMarkdown(pr: PullRequest, run: ReviewRun): string {
  const { review } = run;
  const lines = [
    `# Review: ${pr.repo}#${pr.number}`,
    "",
    `**${pr.title}** by @${pr.author} · commit \`${pr.headSha.slice(0, 7)}\` · ${pr.url}`,
    "",
    `Verdict: **${review.verdict === "request_changes" ? "request changes" : "no issues"}** · ` +
      `${review.findings.length} findings · ${(run.durationMs / 60_000).toFixed(1)} min · ` +
      `$${run.costUsd.toFixed(2)}`,
    "",
    "## Summary",
    "",
    review.summary,
    "",
  ];
  if (review.findings.length > 0) {
    lines.push("## Findings", "");
    for (const f of sortFindings(review.findings)) {
      lines.push(`- **${SEVERITY_LABEL[f.severity]}** \`${location(f)}\`: ${f.body}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
