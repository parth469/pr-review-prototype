import type { Config } from "./config.ts";
import { type Finding, mustFix, type Verdict } from "./reviewer.ts";
import type { ReviewEventName } from "./types.ts";

export interface DecideInput {
  /** Every earlier finding checked this round. */
  previous: Array<{
    id: string;
    severity: Finding["severity"];
    mustFix?: boolean;
    verdict: Verdict;
    /** Set when the worker could not confirm the verdict itself, with the reason. */
    needsYou?: string | undefined;
  }>;
  /** New problems in the commits since the last review. */
  newFindings: Array<Pick<Finding, "severity" | "mustFix">>;
  ownPr: boolean;
  round: number;
  settings: Config["followUp"];
}

export type FollowUpDecision = {
  kind: "post";
  event: ReviewEventName;
  /** false: leave the review as a pending draft that only you can see. */
  submit: boolean;
  /** Why, in one line, for the log and the status page. */
  reason: string;
  /** Shown in the posted body, e.g. why it does not approve yet. */
  note: string | null;
  /** Set when the review waits as a draft for you to decide. */
  needsYou: string | null;
};

const OPEN: Verdict[] = ["not_fixed", "partly_fixed"];

/** Whether an "explained" finding of this severity waits for your OK instead of approving. */
export function explanationNeedsYou(
  severity: Finding["severity"],
  settings: Pick<Config["followUp"], "explainedBugNeedsYou" | "explainedRiskNeedsYou">,
): boolean {
  return (
    (severity === "bug" && settings.explainedBugNeedsYou) ||
    (severity === "risk" && settings.explainedRiskNeedsYou)
  );
}

/**
 * The approval rule. Claude only judges each finding; this decides the review event.
 * Only must-fix findings (bugs, serious risks) block, until fixed, explained or gone.
 * Minor risks, nits and questions never block a follow-up, so round two usually approves.
 */
export function decideFollowUp(input: DecideInput): FollowUpDecision {
  const { settings } = input;
  const open = input.previous.filter((p) => mustFix(p) && OPEN.includes(p.verdict));
  const fresh = input.newFindings.filter(mustFix);

  const post = (
    event: ReviewEventName,
    reason: string,
    extra: { submit?: boolean; note?: string | null; needsYou?: string | null } = {},
  ): FollowUpDecision => {
    let submit = extra.submit ?? true;
    let needsYou = extra.needsYou ?? null;
    // Endless back and forth: past the last automatic round, you decide.
    if (input.round > settings.maxAutoRounds) {
      submit = false;
      needsYou ??= `round ${input.round}: past ${settings.maxAutoRounds} automatic rounds`;
    }
    return { kind: "post", event, submit, reason, note: extra.note ?? null, needsYou };
  };

  // GitHub allows neither approving nor requesting changes on your own PR.
  if (input.ownPr) {
    return post("COMMENT", "own PR", {
      note: "Posted as a comment: GitHub does not allow approving or requesting changes on your own PR.",
    });
  }

  if (open.length > 0 || fresh.length > 0) {
    const parts = [
      open.length > 0 ? `${open.map((p) => p.id).join(", ")} still open` : "",
      fresh.length > 0 ? `${fresh.length} new must-fix` : "",
    ].filter(Boolean);
    return post("REQUEST_CHANGES", parts.join(", "));
  }

  // Verdicts plain code cannot confirm: the approval waits as a draft for you.
  const reasons: string[] = [];
  for (const severity of ["bug", "risk"] as const) {
    const explained = input.previous.filter(
      (p) =>
        p.severity === severity &&
        p.verdict === "explained" &&
        explanationNeedsYou(p.severity, settings),
    );
    if (explained.length > 0) {
      reasons.push(
        `explained ${severity} ${explained.map((p) => p.id).join(", ")}: accept the reason?`,
      );
    }
  }
  for (const p of input.previous) if (p.needsYou && mustFix(p)) reasons.push(p.needsYou);
  if (reasons.length > 0) {
    return post("APPROVE", "needs your check", { submit: false, needsYou: reasons.join("; ") });
  }

  if (settings.approve === "pending") {
    return post("APPROVE", "all handled", { submit: false, needsYou: "approval ready to submit" });
  }
  return post("APPROVE", "all handled");
}
