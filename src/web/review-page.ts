import type { Finding, ReviewRun } from "../reviewer.ts";
import type { Job } from "../state.ts";
import type { TicketContext } from "../ticket.ts";
import { type Html, html, richText } from "./html.ts";
import { actionForm, ago, type Chrome, countdown, money, page } from "./layout.ts";
import { describeJob, droppedIds, type PrView, prPath } from "./prs.ts";

export interface ReviewPageInput {
  chrome: Chrome;
  pr: PrView;
  /** The saved review of each round, by job id; null when none was saved. */
  runs: Map<number, ReviewRun | null>;
  /** The PR's ticket; null when none was found, undefined when tickets are off. */
  ticket: TicketContext | null | undefined;
  /** 1-based round to open; the latest when not given. */
  openRound: number | null;
  canApprove: boolean;
}

const SEVERITY: Record<string, [string, string]> = {
  bug: ["🔴 bug", "change"],
  risk: ["🟡 risk", "work"],
  question: ["❓ question", "comment"],
  nit: ["🔵 nit", "quiet"],
};
const ORDER = ["bug", "risk", "question", "nit"];
const VERDICT: Record<string, [string, string]> = {
  fixed: ["fixed", "ok"],
  explained: ["explained", "comment"],
  no_longer_applies: ["no longer applies", "quiet"],
  partly_fixed: ["partly fixed", "work"],
  not_fixed: ["not fixed", "change"],
};

/** Only http(s) links leave the page; anything else from a PR or ticket becomes inert. */
const safeHref = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : "#");

const sevChip = (severity: string) => {
  const [label, tone] = SEVERITY[severity] ?? [severity, "quiet"];
  return html`<span class="chip ${tone}">${label}</span>`;
};
const where = (f: { path: string; line: number; endLine?: number | undefined }) =>
  `${f.path}:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}`;
/** A classic one-body finding without its fix: the page shows only what is wrong and why it matters. */
const withoutFix = (body: string) => body.split(/\bFix:/i)[0]?.trim() ?? body;
const bySeverity = (fs: Finding[]) =>
  [...fs].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

function verdictChip(p: { severity: string; verdict: string }): Html {
  let [label, tone] = VERDICT[p.verdict] ?? [p.verdict, "quiet"];
  // Nits and questions never block: left alone they are only optional.
  if (
    (p.severity === "nit" || p.severity === "question") &&
    (p.verdict === "not_fixed" || p.verdict === "partly_fixed")
  ) {
    label += " · optional";
    tone = "quiet";
  }
  return html`<span class="chip ${tone}">${label}</span>`;
}

/** The actions for the PR's newest job, as forms. */
function actions(job: Job, input: ReviewPageInput): Html[] {
  const { chrome } = input;
  const ref = `${job.repo}#${job.pr}`;
  const go = (action: string, label: string, opts: Parameters<typeof actionForm>[3] = {}) =>
    actionForm(chrome, `/do/jobs/${job.id}/${action}`, label, opts);
  const out: Html[] = [];
  if (job.status === "held") {
    const run = input.runs.get(job.id);
    const total = run?.review.findings.length ?? 0;
    const keep = total - droppedIds(job).length;
    out.push(
      go("post", `Post ${keep} ${keep === 1 ? "finding" : "findings"}`, {
        tone: "primary",
        title: "Post it now, without the findings you dropped.",
      }),
    );
    if (job.hold_until)
      out.push(
        go("handle", "I'll handle it", {
          title: "Stop the timer. It waits until you press Post or Discard.",
        }),
      );
    out.push(
      go("discard", "Discard", {
        tone: "danger",
        title: "Post nothing for this commit.",
        confirm: `Discard the review of ${ref}? Nothing is posted.`,
      }),
    );
  }
  if (job.status === "preparing" || job.status === "reviewing")
    out.push(
      go("stop", "Stop", {
        tone: "danger",
        title: "Stop this review now. Nothing is posted.",
        confirm: `Stop the review of ${ref}? Nothing is posted.`,
      }),
    );
  if (job.status === "failed")
    out.push(
      go("retry", "Retry", {
        tone: "primary",
        title: "Try again. A saved review is only posted, not re-run.",
      }),
    );
  if (job.status === "skipped" && job.reason !== "discarded by you")
    out.push(
      go("review-now", "Review now", {
        tone: "primary",
        title: "Review it anyway, ignoring the skip rule.",
      }),
    );
  if (
    input.canApprove &&
    job.round > 1 &&
    job.status === "done" &&
    job.event !== "APPROVED" &&
    job.reason !== "dry-run"
  )
    out.push(
      go("approve", "Approve", {
        tone: "primary",
        title: "Approve this PR on GitHub now, overriding the posted review.",
        confirm: `Approve ${ref} on GitHub as you?`,
      }),
    );
  if (["done", "reviewed", "held", "failed"].includes(job.status))
    out.push(
      go("rereview", "Re-review", {
        title: "Run Claude again on this commit. A review already on GitHub is not posted twice.",
      }),
    );
  return out;
}

/** What's wrong and what happens if not fixed. The fix and the reasoning are for the author. */
function findingCard(f: Finding, job: Job, input: ReviewPageInput, canDrop: boolean): Html {
  const dropped = !!f.id && droppedIds(job).includes(f.id);
  const toggle =
    canDrop && f.id
      ? actionForm(input.chrome, `/do/jobs/${job.id}/drop`, dropped ? "Keep" : "Drop", {
          tone: "small",
          title: dropped
            ? "Post this finding after all."
            : "Don't post this finding. The author never sees it.",
          fields: { id: f.id, dropped: dropped ? "0" : "1" },
        })
      : "";
  const head = html`<div class="fhead">${f.id ? html`<span class="fid">${f.id}</span>` : ""}${sevChip(f.severity)}<span class="ref">${where(f)}</span>${dropped ? html`<span class="chip quiet">dropped</span>` : ""}<span class="spacer"></span>${toggle}</div>`;
  // Findings saved before the readable parts existed have one free-text body.
  if (!f.title)
    return html`<article class="finding${dropped ? " dropped" : ""}">${head}<p>${richText(withoutFix(f.body ?? ""))}</p></article>`;
  return html`<article class="finding${dropped ? " dropped" : ""}">${head}<h3 class="ftitle">${richText(f.title)}</h3>
${f.problem ? html`<p><b>What's wrong:</b> ${richText(f.problem)}</p>` : ""}
${f.impact ? html`<p><b>What happens if not fixed:</b> ${richText(f.impact)}</p>` : ""}</article>`;
}

function earlierTable(run: ReviewRun): Html | string {
  const fu = run.followUp;
  if (!fu) return "";
  if (!fu.previous.length)
    return html`<p class="muted">Nothing left to check from earlier rounds.</p>`;
  return html`<h3 class="sect">Earlier findings · since <span class="ref">${fu.prevSha.slice(0, 7)}</span>${fu.linear ? "" : " (history rewritten)"}</h3>
<div class="scroll"><table class="prev"><thead><tr><th></th><th>Finding</th><th>Verdict</th><th>Reply</th></tr></thead><tbody>${fu.previous.map(
    (
      p,
    ) => html`<tr><td class="fid">${p.id}</td><td>${sevChip(p.severity)} ${richText(p.title ?? withoutFix(p.body ?? ""))}<br><span class="ref muted">${where(p)}</span></td>
<td>${verdictChip(p)}</td><td>${richText(p.reply)}${p.overruled ? html`<br><span class="muted small">Overruled: ${p.overruled}</span>` : ""}</td></tr>`,
  )}</tbody></table></div>`;
}

function roundBody(
  job: Job,
  n: number,
  isLatest: boolean,
  fate: Map<string, string>,
  input: ReviewPageInput,
): Html {
  const run = input.runs.get(job.id) ?? null;
  const parts: Array<Html | string> = [];
  if (job.error) parts.push(html`<p class="note">Error: ${job.error}</p>`);
  if (!run) {
    if (!job.error)
      parts.push(
        html`<p class="muted">${job.status === "skipped" ? `Not reviewed: ${job.reason ?? "skipped"}.` : "No review saved yet. This page reloads when it is ready."}</p>`,
      );
    return html`${parts}`;
  }
  const canDrop = isLatest && job.status === "held";
  parts.push(html`<p class="lead">${richText(run.review.summary)}</p>`);
  if (canDrop)
    parts.push(
      html`<p class="note">This would request changes. Drop the findings you disagree with, then press Post. Untouched findings post as written.</p>`,
    );
  parts.push(earlierTable(run));
  const findings = bySeverity(run.review.findings);
  if (findings.length && run.followUp)
    parts.push(html`<h3 class="sect">New since the last review</h3>`);
  for (const f of findings) {
    const later = f.id ? fate.get(`${n}:${f.id}`) : undefined;
    if (later) parts.push(html`<p class="lineage">R${n} raised → ${later}</p>`);
    parts.push(findingCard(f, job, input, canDrop));
  }
  if (!findings.length && !run.followUp) parts.push(html`<p class="muted">No findings.</p>`);
  return html`${parts}`;
}

/** "R2 not fixed, R3 fixed" for each finding a later round checked, keyed "<round>:<id>". */
function fates(input: ReviewPageInput): Map<string, string> {
  const raisedIn = new Map<string, number>();
  const out = new Map<string, string[]>();
  input.pr.rounds.forEach((job, i) => {
    const run = input.runs.get(job.id);
    for (const p of run?.followUp?.previous ?? []) {
      const from = raisedIn.get(p.id);
      if (from)
        out.set(`${from}:${p.id}`, [
          ...(out.get(`${from}:${p.id}`) ?? []),
          `R${i + 1} ${VERDICT[p.verdict]?.[0] ?? p.verdict}`,
        ]);
    }
    for (const f of run?.review.findings ?? [])
      if (f.id && !raisedIn.has(f.id)) raisedIn.set(f.id, i + 1);
  });
  return new Map([...out].map(([k, v]) => [k, v.join(" → ")]));
}

function panel(input: ReviewPageInput): Html {
  const { pr, chrome } = input;
  const job = pr.latest;
  const look = describeJob(job, { paused: chrome.postingPaused });
  const n = pr.rounds.indexOf(job) + 1;
  const run = input.runs.get(job.id);
  const total = run?.review.findings.length ?? 0;
  const dropped = droppedIds(job).length;
  const ticket = input.ticket;
  return html`<aside class="panel"><div class="panel-in">
<h4>${n ? `R${n}` : "Latest commit"} <span class="chip ${look.tone}">${look.label}</span></h4>
${
  job.status === "held"
    ? html`<p class="big">${total - dropped} to post${dropped ? html` <span class="muted small">· ${dropped} dropped</span>` : ""}</p>
<div>${job.hold_until ? countdown(job.hold_until, chrome.now) : html`<span class="muted">Waits for you, no timer.</span>`}</div>`
    : look.note
      ? html`<p class="muted small">${look.note}</p>`
      : ""
}
<div class="stack">${actions(job, input)}</div>
<p class="small"><a href="${safeHref(pr.url)}" target="_blank" rel="noopener noreferrer">PR on GitHub ↗</a>${job.review_url ? html` · <a href="${safeHref(job.review_url)}" target="_blank" rel="noopener noreferrer">Posted review ↗</a>` : ""}</p>
${
  ticket === undefined
    ? ""
    : html`<p class="small">${
        ticket?.tickets.length
          ? html`Ticket: ${ticket.tickets.map(
              (t) =>
                html`<a href="${safeHref(t.url)}" target="_blank" rel="noopener noreferrer" title="${t.title}">${t.id} ↗</a> `,
            )}${ticket.truncated ? "(cut to fit) " : ""}`
          : html`<span class="muted">No ticket found.</span> `
      }${actionForm(chrome, `/do/jobs/${job.id}/refresh-ticket`, "Refresh", { tone: "small", title: "Read the ticket again from Linear's comment on the PR." })}</p>`
}
${
  pr.rounds.length > 1
    ? html`<h4>Rounds</h4><ul>${[...pr.rounds].reverse().map((r) => {
        const i = pr.rounds.indexOf(r) + 1;
        return html`<li><a href="${prPath(pr)}?round=${i}#r${i}">R${i} · ${describeJob(r, { paused: chrome.postingPaused }).label}</a></li>`;
      })}</ul>`
    : ""
}
</div></aside>`;
}

export function renderReviewPage(input: ReviewPageInput): string {
  const { pr, chrome } = input;
  const paused = chrome.postingPaused;
  const total = pr.rounds.length;
  const open =
    input.openRound && input.openRound >= 1 && input.openRound <= total ? input.openRound : total;
  const fate = fates(input);
  const timeline = [...pr.rounds].reverse().map((job) => {
    const n = pr.rounds.indexOf(job) + 1;
    const look = describeJob(job, { paused });
    const detail = [
      job.findings == null
        ? null
        : `${job.findings} ${job.round > 1 ? "open" : job.findings === 1 ? "finding" : "findings"}`,
      look.note,
      ago(job.updated_at, chrome.now),
      job.cost_usd ? money(job.cost_usd) : null,
    ].filter(Boolean);
    return html`<details class="round" id="r${n}"${n === open ? html` open` : ""}><summary><span class="tdot ${look.tone}"></span><b>R${n}</b> <span class="chip ${look.tone}">${look.label}</span>
<span class="muted small"><span class="ref">${job.head_sha.slice(0, 7)}</span> · ${detail.join(" · ")}</span></summary>
${roundBody(job, n, job === pr.latest, fate, input)}</details>`;
  });
  const body = html`<div class="review"><main>
<a class="back" href="/">← All PRs</a>
<h1 class="rtitle">${pr.title}</h1>
<p class="muted small">${pr.repo}#${pr.pr}${pr.author ? ` · by ${pr.author}` : ""} · ${money(pr.costUsd)} across ${total} ${total === 1 ? "round" : "rounds"}</p>
${total ? timeline : html`<p class="muted">Not reviewed: ${pr.latest.reason ?? "skipped"}.</p>`}
${pr.skipped ? html`<p class="muted small">${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped or replaced before review.</p>` : ""}
</main>${panel(input)}</div>`;
  return page(chrome, `${pr.repo.split("/")[1] ?? pr.repo}#${pr.pr} · Proxy Reviewer`, body);
}
