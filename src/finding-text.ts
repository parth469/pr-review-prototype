import type { Finding } from "./reviewer.ts";

/**
 * How a finding reads to people. New findings come in parts (title, problem, impact, fix,
 * why, maybe a suggestion); findings saved before that have one free-text `body`.
 */

/** Whether a finding has the readable parts, not just a legacy `body`. */
export function isStructured(f: Finding): f is Finding & Required<Pick<Finding, StructuredKey>> {
  return Boolean(f.title && f.problem && f.impact && f.fix && f.why);
}
type StructuredKey = "title" | "problem" | "impact" | "fix" | "why";

/** The first sentence of a text, on one line, cut at `max`. */
export function firstSentence(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** A one-line name for the finding: its title, or the first sentence of a legacy body. */
export function findingTitle(f: Finding, max = 90): string {
  return firstSentence(f.title ?? f.body ?? "", max);
}

/** A code fence longer than any run of backticks inside the code. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** `code` in a fenced block that its own backticks cannot close. */
export function fenced(code: string, info = ""): string {
  const text = code.replace(/\n+$/, "");
  const f = fence(text);
  return `${f}${info}\n${text}\n${f}`;
}

/** A GitHub suggestion block: replaces the lines the comment sits on with `code`. */
export function suggestionBlock(code: string): string {
  return fenced(code, "suggestion");
}

/**
 * The finding as GitHub markdown, without its title line: what's wrong, what happens if not
 * fixed, the fix, an optional suggestion block, then the reasoning folded away.
 * A legacy finding is just its body.
 */
export function findingMarkdown(f: Finding, { suggestion = false } = {}): string {
  if (!isStructured(f)) return f.body ?? "";
  const parts = [
    [
      `**What's wrong:** ${f.problem}`,
      `**What happens if not fixed:** ${f.impact}`,
      `**Fix:** ${f.fix}`,
    ].join("\n"),
  ];
  if (suggestion && f.suggestion) parts.push(suggestionBlock(f.suggestion));
  parts.push(`<details><summary>Why I think so</summary>\n\n${f.why}\n</details>`);
  return parts.join("\n\n");
}
