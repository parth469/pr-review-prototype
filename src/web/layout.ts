import { type Html, html, raw, toHtmlString } from "./html.ts";

/** Everything the header needs, the same on every page. */
export interface Chrome {
  /** Per-start token; every form sends it back. */
  token: string;
  /** CSP nonce for the one inline style and script. */
  nonce: string;
  /** This page's path and query: forms come back here after their action. */
  back: string;
  /** An action that failed, shown once after its redirect. */
  error: string | null;
  now: Date;
  viewer: string;
  lastPollAt: string | null;
  lastPollError: string | null;
  pollIntervalSec: number;
  postingPaused: boolean;
  publishMode: string;
  sessionUsage: { utilization: number; resetsAt: Date | null } | null;
  maxSessionUsagePct: number | null;
  picks: {
    model: string;
    effort: string;
    style: string;
    holdMin: number;
    models: readonly string[];
    efforts: readonly string[];
    styles: Array<{ key: string; label: string }>;
    holdChoices: number[];
  };
}

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const modelLabel = (m: string) => MODEL_LABELS[m] ?? m;
export const holdLabel = (min: number) =>
  min === 0 ? "Off" : min < 60 ? `${min} min` : `${min / 60} h`;

/** 24-hour local time, with the day when it is not today. */
export function clock(iso: string | Date, now: Date): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? t
    : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${t}`;
}

export function ago(iso: string, now: Date): string {
  const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

export const money = (usd: number) => `$${usd.toFixed(2)}`;

/** A held review's timer; the page script keeps it counting down. */
export function countdown(until: string, now: Date): Html {
  return html`<span class="countdown" data-until="${until}">⏱ posts at ${clock(until, now)}</span>`;
}

/** A button that posts one action, then comes back to this page. */
export function actionForm(
  chrome: Chrome,
  action: string,
  label: string,
  opts: {
    tone?: "primary" | "danger" | "small";
    title?: string;
    confirm?: string;
    fields?: Record<string, string>;
  } = {},
): Html {
  return html`<form method="post" action="${action}" class="inline"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ""}>
<input type="hidden" name="token" value="${chrome.token}"><input type="hidden" name="back" value="${chrome.back}">${Object.entries(
    opts.fields ?? {},
  ).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<button class="${opts.tone ?? ""}"${opts.title ? html` title="${opts.title}"` : ""}>${label}</button></form>`;
}

/** Model, effort, style and wait-for-OK, behind one "Next review" button. */
function pickers(chrome: Chrome): Html {
  const p = chrome.picks;
  const select = (
    name: string,
    label: string,
    options: Array<[string, string]>,
    value: string,
    note: string,
  ) =>
    html`<label title="${note}"><span>${label}</span><select name="${name}" data-autosubmit>${options.map(
      ([v, text]) =>
        html`<option value="${v}"${v === value ? raw(" selected") : ""}>${text}</option>`,
    )}</select></label>`;
  const styleLabel = p.styles.find((s) => s.key === p.style)?.label ?? p.style;
  return html`<details class="pop"><summary>Next review: <b>${modelLabel(p.model)} · ${capital(p.effort)} · ${styleLabel} · wait ${holdLabel(p.holdMin)}</b></summary>
<form method="post" action="/do/settings" class="pop-body">
<input type="hidden" name="token" value="${chrome.token}"><input type="hidden" name="back" value="${chrome.back}">
${select(
  "model",
  "Model",
  p.models.map((m) => [m, modelLabel(m)]),
  p.model,
  "Model for the next review. A review already running keeps its model.",
)}
${select(
  "effort",
  "Effort",
  p.efforts.map((e) => [e, capital(e)]),
  p.effort,
  "Effort for the next review.",
)}
${select(
  "style",
  "Style",
  p.styles.map((s) => [s.key, s.label]),
  p.style,
  "How findings are written in the next review.",
)}
${select(
  "hold",
  "Wait for OK",
  p.holdChoices.map((m) => [String(m), holdLabel(m)]),
  String(p.holdMin),
  "A review that would request changes waits this long for your OK, then posts as it is. Reviews already waiting keep their time.",
)}
<button class="primary">Save</button></form></details>`;
}

function header(chrome: Chrome): Html {
  const ok = !chrome.lastPollError;
  const usage = chrome.sessionUsage;
  const over =
    usage && chrome.maxSessionUsagePct != null && usage.utilization >= chrome.maxSessionUsagePct;
  return html`<header class="top">
<a class="brand" href="/">Proxy Reviewer</a>
<span class="facts"><span class="dot${ok ? "" : " off"}"></span>${ok ? `Running as ${chrome.viewer}` : `Poll failing: ${chrome.lastPollError}`}
 · last poll ${chrome.lastPollAt ? clock(chrome.lastPollAt, chrome.now) : "–"} · every ${chrome.pollIntervalSec} s
 · posting ${chrome.postingPaused ? "paused" : chrome.publishMode === "submit" ? "on" : chrome.publishMode}${usage ? ` · session ${usage.utilization}%` : ""}</span>
${pickers(chrome)}
${
  chrome.postingPaused
    ? actionForm(chrome, "/do/posting/resume", "Resume posting", { tone: "primary" })
    : actionForm(chrome, "/do/posting/pause", "Pause posting", {
        title: "Reviews still run and wait here until you resume.",
      })
}
</header>
${chrome.postingPaused ? html`<p class="banner">Posting is paused. Reviews still run and wait here until you resume.</p>` : ""}
${over && usage ? html`<p class="banner">Session usage is ${usage.utilization}% (limit ${chrome.maxSessionUsagePct}%). New reviews wait${usage.resetsAt ? ` until ${clock(usage.resetsAt, chrome.now)}` : ""}.</p>` : ""}
${chrome.error ? html`<p class="banner error" role="alert">${chrome.error}</p>` : ""}`;
}

/** A whole page: one inline style and one inline script, both tagged with the nonce. */
export function page(chrome: Chrome, title: string, body: Html): string {
  return `<!doctype html>${toHtmlString(html`<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" href="data:,">
<style nonce="${chrome.nonce}">${raw(CSS)}</style></head>
<body><div class="wrap">${header(chrome)}${body}</div>
<script nonce="${chrome.nonce}">${raw(SCRIPT)}</script></body></html>`)}`;
}

// The only browser code: the countdown, confirm prompts, saving a picker on change, and a reload
// every 30 s while you are not in the middle of something.
const SCRIPT = `"use strict";
function tick() {
  document.querySelectorAll(".countdown[data-until]").forEach(function (el) {
    var until = new Date(el.getAttribute("data-until")), left = until - Date.now();
    var at = until.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    el.classList.toggle("urgent", left < 5 * 60000);
    if (left <= 0) { el.textContent = "⏱ posting now"; return; }
    var m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    el.textContent = "⏱ " + m + ":" + String(s).padStart(2, "0") + " · posts at " + at;
  });
}
tick(); setInterval(tick, 1000);
document.querySelectorAll("form[data-confirm]").forEach(function (f) {
  f.addEventListener("submit", function (e) { if (!confirm(f.getAttribute("data-confirm"))) e.preventDefault(); });
});
document.querySelectorAll("select[data-autosubmit]").forEach(function (s) {
  s.addEventListener("change", function () { s.form.requestSubmit(); });
});
document.querySelectorAll("button[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    navigator.clipboard.writeText(document.querySelector(b.getAttribute("data-copy")).textContent).then(function () {
      b.classList.add("done"); b.title = "Copied";
      setTimeout(function () { b.classList.remove("done"); b.title = "Copy"; }, 1500);
    }, function () { b.title = "Copy failed: select the text and copy by hand"; });
  });
});
var busy = false;
document.addEventListener("submit", function () { busy = true; });
setInterval(function () {
  var a = document.activeElement;
  if (busy || document.hidden || document.querySelector("details.pop[open]")) return;
  if (a && /^(SELECT|INPUT|TEXTAREA|BUTTON)$/.test(a.tagName)) return;
  location.reload();
}, 30000);
`;

const CSS = `
:root { color-scheme: light;
  --bg:#f4f6f8; --panel:#fff; --sunken:#eef1f4; --ink:#18202a; --muted:#5d6977; --line:#dce1e7; --accent:#2a5ea6; --accent-ink:#fff;
  --change:#b3261e; --change-bg:#fbe6e4; --comment:#36597f; --comment-bg:#e3ecf6; --pending:#6a3fa0; --pending-bg:#efe7f8;
  --work:#8a5a00; --work-bg:#fbf0d9; --ok:#2e7d4f; --ok-bg:#e2f2e8; --quiet:#5d6977; --quiet-bg:#eceff2;
  --sans: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono: ui-monospace,"Cascadia Mono",Consolas,"SF Mono",monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark;
  --bg:#0e1217; --panel:#151b22; --sunken:#1b222b; --ink:#e2e8ee; --muted:#93a0ae; --line:#27303a; --accent:#7aa6e6; --accent-ink:#0e1217;
  --change:#f08a80; --change-bg:#3a1c1a; --comment:#9cc0e8; --comment-bg:#1b2a3b; --pending:#c5a6ee; --pending-bg:#2a2140;
  --work:#e8bf6a; --work-bg:#332812; --ok:#7fd1a0; --ok-bg:#16301f; --quiet:#93a0ae; --quiet-bg:#1f262e; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 var(--sans); padding:0 16px 40px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
button, .btnlink { font:inherit; cursor:pointer; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:6px; padding:4px 10px; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
button.danger { color:var(--change); border-color:var(--change); }
button.small { font-size:12px; padding:2px 8px; }
select { font:inherit; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:6px; padding:3px 6px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
form.inline { display:inline; }
.wrap { max-width:1280px; margin:0 auto; }
.muted { color:var(--muted); } .small { font-size:12.5px; } .ref, .num { font-family:var(--mono); font-size:12.5px; } .num { color:var(--muted); white-space:nowrap; }
code { font-family:var(--mono); font-size:12.5px; background:var(--sunken); border-radius:4px; padding:1px 4px; }
.chip { display:inline-block; font-size:12px; font-weight:600; padding:1px 8px; border-radius:999px; white-space:nowrap; }
.chip.change,.pill.change { color:var(--change); background:var(--change-bg); } .chip.comment,.pill.comment { color:var(--comment); background:var(--comment-bg); }
.chip.pending,.pill.pending { color:var(--pending); background:var(--pending-bg); } .chip.work,.pill.work { color:var(--work); background:var(--work-bg); }
.chip.ok,.pill.ok { color:var(--ok); background:var(--ok-bg); } .chip.quiet,.pill.quiet { color:var(--quiet); background:var(--quiet-bg); }
.pill { display:inline-block; font:600 11.5px var(--mono); padding:1px 6px; border-radius:4px; margin-right:3px; }
.skip { font:11.5px var(--mono); color:var(--muted); margin-right:4px; }
.sub { display:block; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.empty { padding:24px 18px; color:var(--muted); }
.countdown { display:inline-block; margin-top:4px; padding:2px 10px; border-radius:6px; font:700 13.5px var(--mono);
  color:var(--pending); background:var(--pending-bg); border:1px solid var(--pending); white-space:nowrap; }
.countdown.urgent { color:var(--change); background:var(--change-bg); border-color:var(--change); }

header.top { display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; padding:16px 0 12px; border-bottom:1px solid var(--line); margin-bottom:12px; }
.brand { font-weight:700; font-size:17px; color:var(--ink); }
.facts { color:var(--muted); font-size:13px; flex:1; min-width:240px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ok); margin-right:6px; } .dot.off { background:var(--change); }
.pop { position:relative; font-size:13px; }
.pop > summary { cursor:pointer; list-style:none; border:1px solid var(--line); border-radius:6px; padding:4px 10px; background:var(--panel); }
.pop > summary::-webkit-details-marker { display:none; }
.pop-body { position:absolute; right:0; top:calc(100% + 6px); z-index:10; background:var(--panel); border:1px solid var(--line); border-radius:8px;
  padding:12px; width:min(320px, calc(100vw - 32px)); box-shadow:0 8px 24px #0003; display:flex; flex-direction:column; gap:10px; }
.pop-body label { display:flex; justify-content:space-between; align-items:center; gap:10px; color:var(--muted); }
.banner { margin:0 0 12px; padding:10px 14px; border-radius:8px; background:var(--work-bg); color:var(--work); font-weight:600; }
.banner.error { background:var(--change-bg); color:var(--change); }

.tabs { display:flex; flex-wrap:wrap; gap:4px; align-items:center; border-bottom:1px solid var(--line); margin-bottom:6px; }
.tab { padding:6px 12px; border-bottom:2px solid transparent; color:var(--muted); margin-bottom:-1px; }
.tab:hover { text-decoration:none; color:var(--ink); } .tab.on { color:var(--ink); border-color:var(--accent); font-weight:600; }
.count { font-size:12px; color:var(--muted); background:var(--quiet-bg); border-radius:999px; padding:0 7px; margin-left:4px; font-weight:400; }
.tabnote { margin-left:auto; font-size:12px; color:var(--muted); }
h2.group { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:18px 0 8px; }

/* Needs you: grouped rows */
.row { border-bottom:1px solid var(--line); box-shadow:inset 3px 0 0 var(--pending); } .row:last-child { border-bottom:0; }
.row > summary { display:grid; grid-template-columns:230px minmax(0,1fr) auto auto 16px; gap:14px; align-items:center; padding:10px 12px; cursor:pointer; list-style:none; }
.row > summary::-webkit-details-marker { display:none; } .row > summary:hover { background:var(--sunken); }
.row[open] .caret { transform:rotate(90deg); } .caret { color:var(--muted); }
.row-main { display:flex; flex-direction:column; min-width:0; } .row-title { color:var(--ink); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
ul.rounds { list-style:none; margin:0; padding:4px 12px 10px 40px; } ul.rounds li { padding:3px 0; } li.skipped { color:var(--muted); font-style:italic; font-size:12.5px; }
@media (max-width:720px) { .row > summary { grid-template-columns:minmax(0,1fr) 16px; } .row > summary > .num { display:none; } }

/* Open: board */
.board { display:grid; grid-template-columns:repeat(4, minmax(220px,1fr)); gap:12px; overflow-x:auto; padding-bottom:4px; }
.col { background:var(--sunken); border-radius:10px; padding:4px 10px 10px; min-width:220px; } .col h2.group { margin:10px 0; }
.bcard { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:8px; display:flex; flex-direction:column; gap:4px; }
.bcard.hot { border-color:var(--pending); } .bcard-title { color:var(--ink); font-weight:600; overflow-wrap:anywhere; }

/* All: dense lines */
.line { display:grid; grid-template-columns:10px 150px minmax(0,1fr) auto 200px 80px; gap:12px; align-items:center; padding:6px 12px; border-bottom:1px solid var(--line); font-size:13px; }
.line:last-child { border-bottom:0; } .line:hover { background:var(--sunken); }
.ldot { width:9px; height:9px; border-radius:50%; background:var(--quiet); }
.ldot.pending { background:var(--pending); } .ldot.change { background:var(--change); } .ldot.ok { background:var(--ok); } .ldot.work { background:var(--work); } .ldot.comment { background:var(--comment); }
.line-title { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.line-state { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:900px) { .line { grid-template-columns:10px minmax(0,1fr) auto; } .line .ref, .line-state, .line .num { display:none; } }

/* Review page: timeline and side panel */
.review { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:24px; }
@media (max-width:900px) { .review { grid-template-columns:minmax(0,1fr); } .panel { order:-1; } }
.back { display:inline-block; margin:4px 0 8px; font-size:13px; }
.rtitle { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; overflow-wrap:anywhere; }
.round { border-left:2px solid var(--line); margin-left:6px; padding:0 0 12px 18px; position:relative; }
.round > summary { cursor:pointer; list-style:none; padding:8px 0; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.round > summary::-webkit-details-marker { display:none; }
.tdot { position:absolute; left:-7px; top:14px; width:12px; height:12px; border-radius:50%; border:2px solid var(--bg); background:var(--quiet); }
.tdot.pending { background:var(--pending); } .tdot.change { background:var(--change); } .tdot.ok { background:var(--ok); } .tdot.work { background:var(--work); } .tdot.comment { background:var(--comment); }
.lead { font-size:15px; margin:10px 0; overflow-wrap:anywhere; }
.note { background:var(--pending-bg); color:var(--pending); padding:8px 12px; border-radius:8px; }
.sect { font-size:13px; color:var(--muted); font-weight:600; margin:16px 0 8px; }
.finding { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin:10px 0; }
.finding.dropped > :not(.fhead) { opacity:.45; }
.fhead { display:flex; flex-wrap:wrap; gap:8px; align-items:center; } .fhead .spacer { flex:1; }
.fid { font:12px var(--mono); color:var(--muted); }
.ftitle { font-size:15px; margin:8px 0 4px; overflow-wrap:anywhere; } .finding p { margin:6px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
.lineage { color:var(--muted); font:12px var(--mono); margin:14px 0 -6px; }
.scroll { overflow-x:auto; }
table.prev { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); min-width:560px; }
table.prev th { text-align:left; font-size:12px; color:var(--muted); background:var(--sunken); padding:6px 10px; }
table.prev td { padding:8px 10px; border-top:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
table.prev td.fid { white-space:nowrap; overflow-wrap:normal; }
.panel-in { position:sticky; top:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px; }
.panel h4 { margin:6px 0 0; display:flex; gap:8px; align-items:center; font-size:14px; }
.panel .stack { display:flex; flex-direction:column; gap:6px; } .panel .stack button { width:100%; }
.copyrow { display:flex; align-items:stretch; gap:6px; }
.copyrow .resume { flex:1; min-width:0; word-break:break-all; user-select:all; font-size:11.5px; padding:6px 8px; }
button.copy { padding:0 8px; display:flex; align-items:center; color:var(--muted); }
button.copy:hover { color:var(--ink); }
button.copy .i-done, button.copy.done .i-copy { display:none; }
button.copy.done .i-done { display:inline; color:var(--ok); }
.panel ul { padding-left:18px; margin:0; } .big { font-size:22px; font-weight:700; margin:0; }
`;
