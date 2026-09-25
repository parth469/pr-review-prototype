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

/** Sort, then number F{first}, F{first+1}... so every finding has a stable id. */
export function numberFindings(findings: Finding[], first = 1): Finding[] {
  return sortFindings(findings).map((f, i) => ({ ...f, id: `F${first + i}` }));
}

/** The number after the highest F-id used so far. */
export function nextFindingNumber(ids: Array<string | undefined>): number {
  const numbers = ids.map((id) => Number(/^F(\d+)$/.exec(id ?? "")?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
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
    `# ${run.followUp ? "Follow-up review" : "Review"}: ${pr.repo}#${pr.number}`,
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
  const followUp = run.followUp;
  if (followUp) {
    lines.push(
      `## Earlier findings (round ${followUp.round}, since \`${followUp.prevSha.slice(0, 7)}\`)`,
      "",
    );
    if (!followUp.linear) lines.push("_History was rewritten: checked against the whole PR._", "");
    for (const p of followUp.previous) {
      lines.push(
        `- **${p.id}** ${SEVERITY_LABEL[p.severity]} \`${location(p)}\` → **${p.verdict.replace(/_/g, " ")}**`,
        `  - Evidence: ${p.evidence}`,
        `  - Reply: ${p.reply}`,
        ...(p.overruled ? [`  - Overruled: ${p.overruled}`] : []),
        ...(p.needsYou ? [`  - Needs you: ${p.needsYou}`] : []),
      );
    }
    if (followUp.previous.length === 0) lines.push("Nothing left to check.");
    lines.push("");
  }
  if (review.findings.length > 0) {
    lines.push(followUp ? "## New findings" : "## Findings", "");
    for (const f of sortFindings(review.findings)) {
      const id = f.id ? `**${f.id}** ` : "";
      lines.push(`- ${id}**${SEVERITY_LABEL[f.severity]}** \`${location(f)}\`: ${f.body}`);
    }
    lines.push("");
  }
  if (run.carried && run.carried.length > 0) {
    lines.push("## Still open from earlier reviews (not checked this time)", "");
    for (const f of run.carried) {
      lines.push(`- **${f.id}** **${SEVERITY_LABEL[f.severity]}** \`${location(f)}\`: ${f.body}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
