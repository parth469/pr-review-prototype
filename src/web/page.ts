/**
 * The status page: one self-contained HTML document. Every piece of PR data is inserted with
 * textContent, never as HTML, because titles and findings come from other people's PRs.
 */
export function renderPage({ token, nonce }: { token: string; nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy Reviewer</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">
:root {
  color-scheme: light;
  --bg: #f4f6f8; --panel: #ffffff; --sunken: #eef1f4; --ink: #18202a; --muted: #5d6977;
  --line: #dce1e7; --accent: #2a5ea6; --accent-ink: #ffffff;
  --change: #b3261e; --change-bg: #fbe6e4; --comment: #36597f; --comment-bg: #e3ecf6;
  --pending: #6a3fa0; --pending-bg: #efe7f8; --work: #8a5a00; --work-bg: #fbf0d9;
  --ok: #2e7d4f; --ok-bg: #e2f2e8; --quiet: #5d6977; --quiet-bg: #eceff2;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0e1217; --panel: #151b22; --sunken: #1b222b; --ink: #e2e8ee; --muted: #93a0ae;
    --line: #27303a; --accent: #7aa6e6; --accent-ink: #0e1217;
    --change: #f08a80; --change-bg: #3a1c1a; --comment: #9cc0e8; --comment-bg: #1b2a3b;
    --pending: #c5a6ee; --pending-bg: #2a2140; --work: #e8bf6a; --work-bg: #332812;
    --ok: #7fd1a0; --ok-bg: #16301f; --quiet: #93a0ae; --quiet-bg: #1f262e;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); padding: 0 16px 40px; }
a { color: var(--accent); }
button { font: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 6px; padding: 4px 10px; }
button:hover { border-color: var(--accent); }
button:disabled, select:disabled { opacity: .5; cursor: progress; }
select { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 4px 6px; }
select:hover { border-color: var(--accent); }
.picks { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.picks label { display: flex; align-items: center; gap: 6px; }
button.danger { color: var(--change); border-color: var(--change); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button:focus-visible, select:focus-visible, a:focus-visible, tr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wrap { max-width: 1280px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 20px 0 14px; border-bottom: 1px solid var(--line); }
h1 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 13px; flex: 1; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 1px; }
.dot.off { background: var(--change); }
.counts { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 0; }
.banner { margin: 14px 0 0; padding: 10px 14px; border-radius: 8px; background: var(--work-bg); color: var(--work); font-weight: 600; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 1100px) { .layout { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); } }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 720px; }
th { text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  background: var(--sunken); padding: 8px 12px; border-bottom: 1px solid var(--line); }
td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--sunken); }
tbody tr.selected { background: var(--sunken); box-shadow: inset 3px 0 0 var(--accent); }
.ref { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
.title { color: var(--muted); display: block; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--muted); }
.chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.chip.change { color: var(--change); background: var(--change-bg); }
.chip.comment { color: var(--comment); background: var(--comment-bg); }
.chip.pending { color: var(--pending); background: var(--pending-bg); }
.chip.work { color: var(--work); background: var(--work-bg); }
.chip.ok { color: var(--ok); background: var(--ok-bg); }
.chip.quiet { color: var(--quiet); background: var(--quiet-bg); }
.sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { padding: 16px 18px; }
.detail h2 { font-size: 15px; margin: 0 0 4px; }
.detail .meta { color: var(--muted); font-size: 13px; margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.detail .summary { margin: 0 0 14px; }
.finding { border-top: 1px solid var(--line); padding: 10px 0; }
.finding.dropped > :not(.pick) { opacity: .5; }
.finding .pick { float: right; margin-left: 8px; }
.finding .loc { font-family: var(--mono); font-size: 12.5px; margin-left: 6px; }
.finding p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.finding .why { color: var(--muted); font-size: 13px; }
.finding .ftitle { font-weight: 600; }
.finding .sugg { margin: 6px 0 0; padding: 8px; background: var(--sunken); border-radius: 4px; font-family: var(--mono); font-size: 12.5px; overflow-x: auto; }
.finding summary { margin-top: 6px; cursor: pointer; color: var(--muted); font-size: 13px; }
.fid { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-right: 6px; }
.round { margin-left: 6px; }
.detail h3 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 16px 0 4px; }
code { font-family: var(--mono); font-size: 12.5px; background: var(--sunken); border-radius: 4px; padding: 1px 4px; }
.empty { color: var(--muted); padding: 24px 18px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
#toast { position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%);
  background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 13px; }
@media (prefers-reduced-motion: no-preference) { tbody tr { transition: background .12s; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Proxy Reviewer</h1>
    <div class="facts" id="facts"><span>Connecting…</span></div>
    <div class="picks" id="picks" hidden>
      <label title="Model for the next review. A review already running keeps its model.">Model <select id="model"></select></label>
      <label title="Effort for the next review.">Effort <select id="effort"></select></label>
      <label title="How findings are written in the next review. A review already running keeps its style.">Style <select id="style"></select></label>
      <label title="A review that would request changes waits this long for your OK, then posts as it is. Reviews already waiting keep their time.">Wait for OK <select id="hold"></select></label>
    </div>
    <button id="pause" type="button" hidden></button>
  </header>
  <div id="banner" class="banner" hidden>Posting is paused. Reviews still run and wait here until you resume.</div>
  <div id="usageBanner" class="banner" hidden></div>
  <div class="counts" id="counts"></div>
  <div class="layout">
    <section class="card" aria-label="Pull requests">
      <div class="scroll">
        <table>
          <thead><tr><th>PR</th><th>Status</th><th>Findings</th><th>Cost</th><th>Updated</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="empty" id="noJobs" hidden>No PRs yet. When someone requests your review, it shows up here within a minute.</div>
    </section>
    <section class="card" aria-label="Details" id="detail">
      <div class="empty">Select a PR to see its review.</div>
    </section>
  </div>
</div>
<div id="toast" role="status" hidden></div>
<script nonce="${nonce}">
"use strict";
var TOKEN = ${JSON.stringify(token).replace(/</g, "\\u003c")};
var selected = null;
var paused = false;
var busy = false;
var canApprove = false;

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    if (k === "text") node.textContent = attrs[k];
    else if (k === "class") node.className = attrs[k];
    else node.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) { if (c) node.appendChild(c); });
  return node;
}
function time(iso) {
  if (!iso) return "–";
  var d = new Date(iso), now = new Date();
  var t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
}
function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
}
function api(path, post, body) {
  var init = post ? { method: "POST", headers: { "X-Proxy-Token": TOKEN } } : {};
  if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(path, init).then(function (r) {
    return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.statusText); return body; });
  });
}

// What a job's state means to you, and how loud it should look.
function describe(job) {
  var s = job.status;
  if (s === "done") {
    if (job.reason === "dry-run") return ["Dry run", "quiet", "Nothing posted"];
    if (job.event === "CHANGES_REQUESTED") return ["Requested changes", "change"];
    if (job.event === "APPROVED") return ["Approved", "ok", job.reason === "approved by you" ? "Approved by you" : null];
    if (job.event === "PENDING") {
      return job.reason ? ["Needs your OK", "pending", job.reason.replace(/^needs your OK: /, "")] : ["Pending draft", "pending", "Only you can see it"];
    }
    return ["Commented", "comment"];
  }
  if (s === "held") {
    var dropped = droppedOf(job).length;
    var when = job.hold_until ? "Posts as it is at " + time(job.hold_until) : "Waiting for you, no timer";
    if (paused && job.hold_until) when += " · posting paused";
    return ["Needs your OK", "pending", when + (dropped ? " · " + dropped + " dropped" : "")];
  }
  if (s === "reviewed") {
    if (paused) return ["Waiting to post", "pending", "Posting is paused"];
    if (job.reason === "waiting for CI") return ["Waiting for CI", "work", "Next check " + time(job.next_attempt_at)];
    return ["Posting soon", "work"];
  }
  if (s === "queued" && job.next_attempt_at && /^session usage /.test(job.reason || "")) return ["Usage limit", "pending", job.reason + " · reviews at " + time(job.next_attempt_at)];
  if (s === "queued") return job.next_attempt_at ? ["Retry at " + time(job.next_attempt_at), "work", job.error] : ["Queued", "quiet"];
  if (s === "preparing") return ["Checking out…", "work"];
  if (s === "reviewing") return ["Claude reviewing…", "work"];
  if (s === "posting") return ["Posting…", "work"];
  if (s === "failed") return ["Failed", "change", job.error];
  if (s === "skipped" && job.reason === "stopped by you") return ["Stopped", "quiet", "Review now starts it again"];
  if (s === "skipped" && job.reason === "discarded by you") return ["Discarded", "quiet", "Nothing posted"];
  if (s === "skipped") return ["Skipped", "quiet", job.reason];
  return [s, "quiet"];
}
function actionsFor(job) {
  var a = [];
  if (job.status === "preparing" || job.status === "reviewing") a.push(["stop", "Stop", "Stop this review now. Nothing is posted; Review now starts it again."]);
  if (job.status === "failed") a.push(["retry", "Retry", "Try again. A saved review is only posted, not re-run."]);
  if (job.status === "skipped" && job.reason !== "discarded by you") a.push(["review-now", "Review now", "Review it anyway, ignoring the skip rule."]);
  if (job.status === "held") {
    a.push(["post", "Post", "Post it now, without the findings you dropped."]);
    if (job.hold_until) a.push(["handle", "I'll handle it", "Stop the timer. It waits until you press Post or Discard."]);
    a.push(["discard", "Discard", "Post nothing for this commit."]);
  }
  // Only a re-requested review: approve it yourself, whatever the posted review said.
  if (canApprove && job.round > 1 && job.status === "done" && job.event !== "APPROVED" && job.reason !== "dry-run")
    a.push(["approve", "Approve", "Approve this PR on GitHub now, overriding the posted review. A draft left for your OK is submitted as the approval."]);
  if (["done", "reviewed", "held", "failed"].indexOf(job.status) >= 0)
    a.push(["rereview", "Re-review", "Run Claude again on this commit. If a review of this commit is already on GitHub, it is not posted twice."]);
  return a;
}
function actionButton(job, action) {
  var b = el("button", { type: "button", text: action[1], title: action[2], class: action[0] === "stop" || action[0] === "discard" ? "danger" : action[0] === "approve" || action[0] === "post" ? "primary" : "" });
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    if (action[0] === "stop" && !confirm("Stop the review of " + job.repo + "#" + job.pr + "? Nothing is posted.")) return;
    if (action[0] === "approve" && !confirm("Approve " + job.repo + "#" + job.pr + " on GitHub as you?")) return;
    if (action[0] === "discard" && !confirm("Discard the review of " + job.repo + "#" + job.pr + "? Nothing is posted.")) return;
    b.disabled = true;
    api("/api/jobs/" + job.id + "/" + action[0], true)
      .then(function () { toast(action[1] + ": " + job.repo + "#" + job.pr); if (selected === job.id) select(job.id); else refresh(); })
      .catch(function (err) { toast(err.message); })
      .finally(function () { b.disabled = false; });
  });
  return b;
}

function renderStatus(st) {
  paused = st.postingPaused;
  canApprove = st.canApprove;
  var facts = document.getElementById("facts");
  var ok = !st.lastPollError;
  facts.replaceChildren.apply(facts, [
    el("span", {}, [el("span", { class: "dot" + (ok ? "" : " off") }), document.createTextNode(ok ? "Running as " + st.viewer : "Poll failing: " + st.lastPollError)]),
    el("span", { text: "Last poll " + time(st.lastPollAt) + " · every " + st.pollIntervalSec + " s" }),
    el("span", { text: "Posting: " + (paused ? "paused" : st.publishMode === "submit" ? "on" : st.publishMode) }),
    st.sessionUsage ? el("span", { text: "Session " + st.sessionUsage.utilization + "%" + (st.sessionUsage.resetsAt ? " · resets " + time(st.sessionUsage.resetsAt) : "") }) : null
  ].filter(Boolean));
  renderPicks(st);
  var over = st.sessionUsage && st.maxSessionUsagePct != null && st.sessionUsage.utilization >= st.maxSessionUsagePct;
  var ub = document.getElementById("usageBanner");
  ub.hidden = !over;
  if (over) ub.textContent = "Session usage is " + st.sessionUsage.utilization + "% (limit " + st.maxSessionUsagePct + "%). New reviews wait" + (st.sessionUsage.resetsAt ? " until " + time(st.sessionUsage.resetsAt) : "") + ".";
  var btn = document.getElementById("pause");
  btn.hidden = false;
  btn.textContent = paused ? "Resume posting" : "Pause posting";
  btn.className = paused ? "primary" : "";
  document.getElementById("banner").hidden = !paused;
  var labels = { done: "posted", held: "need your OK", reviewed: "waiting to post", queued: "queued", preparing: "checking out", reviewing: "reviewing", posting: "posting", failed: "failed", skipped: "skipped" };
  document.getElementById("counts").replaceChildren.apply(
    document.getElementById("counts"),
    Object.keys(st.counts).map(function (k) { return el("span", { class: "chip quiet", text: st.counts[k] + " " + (labels[k] || k) }); })
  );
}

var LABELS = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", low: "Low", medium: "Medium", high: "High" };
function fillSelect(id, options, value) {
  var sel = document.getElementById(id);
  if (sel.options.length !== options.length) {
    sel.replaceChildren.apply(sel, options.map(function (o) { return el("option", { value: o, text: LABELS[o] || o }); }));
  }
  // Leave it alone while you are choosing.
  if (document.activeElement !== sel && !sel.disabled) sel.value = value;
}
function renderPicks(st) {
  document.getElementById("picks").hidden = false;
  fillSelect("model", st.models, st.model);
  fillSelect("effort", st.efforts, st.effort);
  (st.styles || []).forEach(function (s) { LABELS[s.key] = s.label; });
  fillSelect("style", (st.styles || []).map(function (s) { return s.key; }), st.style);
  (st.holdChoices || []).forEach(function (m) { LABELS["hold:" + m] = m === 0 ? "Off" : m < 60 ? m + " min" : (m / 60) + " h"; });
  fillSelect("hold", (st.holdChoices || []).map(function (m) { return "hold:" + m; }), "hold:" + st.holdMin);
}
document.getElementById("hold").addEventListener("change", function () {
  var sel = this;
  sel.disabled = true;
  api("/api/hold", true, { minutes: Number(sel.value.slice(5)) })
    .then(function (r) { toast(r.holdMin === 0 ? "Request changes posts at once" : "Request changes waits " + LABELS["hold:" + r.holdMin] + " for your OK"); })
    .catch(function (err) { toast(err.message); })
    .finally(function () { sel.disabled = false; sel.blur(); refresh(); });
});
["model", "effort", "style"].forEach(function (id) {
  var sel = document.getElementById(id);
  sel.addEventListener("change", function () {
    var body = {}; body[id] = sel.value;
    sel.disabled = true;
    api("/api/review-settings", true, body)
      .then(function (r) { toast("Next review: " + (LABELS[r.model] || r.model) + " · " + (LABELS[r.effort] || r.effort) + " effort · " + (LABELS[r.style] || r.style)); })
      .catch(function (err) { toast(err.message); })
      .finally(function () { sel.disabled = false; sel.blur(); refresh(); });
  });
});

function renderJobs(jobs) {
  document.getElementById("noJobs").hidden = jobs.length > 0;
  document.getElementById("rows").replaceChildren.apply(document.getElementById("rows"), jobs.map(function (job) {
    var d = describe(job);
    var statusCell = el("td", {}, [el("span", { class: "chip " + d[1], text: d[0] }), d[2] ? el("span", { class: "sub", text: d[2], title: d[2] }) : null]);
    if (job.review_url) {
      statusCell.appendChild(document.createTextNode(" "));
      var link = el("a", { href: job.review_url, target: "_blank", rel: "noopener", text: "open ↗" });
      link.addEventListener("click", function (e) { e.stopPropagation(); });
      statusCell.appendChild(link);
    }
    var row = el("tr", { tabindex: "0", class: job.id === selected ? "selected" : "" }, [
      el("td", {}, [
        el("span", { class: "ref", text: job.repo + "#" + job.pr }),
        job.round > 1 ? el("span", { class: "chip quiet round", text: "R" + job.round, title: "Follow-up review, round " + job.round }) : null,
        el("span", { class: "title", text: job.title, title: job.title })
      ]),
      statusCell,
      el("td", { class: "num", text: job.findings == null ? "–" : job.findings + (job.round > 1 ? " open" : job.findings === 1 ? " finding" : " findings") }),
      el("td", { class: "num", text: job.cost_usd == null ? "–" : "$" + job.cost_usd.toFixed(2) }),
      el("td", { class: "num", text: time(job.updated_at) }),
      el("td", {}, actionsFor(job).map(function (a) { return actionButton(job, a); }))
    ]);
    row.addEventListener("click", function () { select(job.id); });
    row.addEventListener("keydown", function (e) { if (e.key === "Enter") select(job.id); });
    return row;
  }));
}

// Backtick-quoted code spans become <code> elements; every piece is still inserted as text.
var BACKTICK = String.fromCharCode(96);
function richText(tag, text, cls) {
  var node = el(tag, cls ? { class: cls } : {});
  String(text).split(BACKTICK).forEach(function (piece, i) {
    node.appendChild(i % 2 ? el("code", { text: piece }) : document.createTextNode(piece));
  });
  return node;
}
var SEVERITY = { bug: ["🔴 bug", "change"], risk: ["🟡 risk", "work"], question: ["❓ question", "comment"], nit: ["🔵 nit", "quiet"] };
var ORDER = ["bug", "risk", "question", "nit"];
var VERDICT = { fixed: ["fixed", "ok"], explained: ["explained", "comment"], no_longer_applies: ["no longer applies", "quiet"], partly_fixed: ["partly fixed", "work"], not_fixed: ["not fixed", "change"] };
function where(f) { return f.path + ":" + f.line + (f.endLine && f.endLine !== f.line ? "-" + f.endLine : ""); }
function labeled(label, text) {
  var p = richText("p", text);
  p.insertBefore(el("b", { text: label + ": " }), p.firstChild);
  return p;
}
function droppedOf(job) {
  try { var ids = JSON.parse(job.dropped || "[]"); return Array.isArray(ids) ? ids : []; } catch (e) { return []; }
}
// Keep or Drop one new finding of a held review. The whole list is saved on each click.
function pickButton(job, f) {
  var dropped = droppedOf(job), isDropped = dropped.indexOf(f.id) >= 0;
  var b = el("button", { type: "button", class: "pick", text: isDropped ? "Keep" : "Drop",
    title: isDropped ? "Post this finding after all." : "Don't post this finding. The author never sees it." });
  b.addEventListener("click", function () {
    var next = isDropped ? dropped.filter(function (id) { return id !== f.id; }) : dropped.concat([f.id]);
    b.disabled = true;
    api("/api/jobs/" + job.id + "/drop", true, { ids: next })
      .then(function () { toast((isDropped ? "Keeping " : "Dropped ") + f.id); select(job.id); })
      .catch(function (err) { toast(err.message); b.disabled = false; });
  });
  return b;
}
function findingRow(f, job) {
  var s = SEVERITY[f.severity] || [f.severity, "quiet"];
  var held = job && job.status === "held" && f.id;
  var isDropped = held && droppedOf(job).indexOf(f.id) >= 0;
  var cls = "finding" + (isDropped ? " dropped" : "");
  var kids = [held ? pickButton(job, f) : null, f.id ? el("span", { class: "fid", text: f.id }) : null, el("span", { class: "chip " + s[1], text: s[0] }),
    isDropped ? el("span", { class: "chip quiet round", text: "dropped" }) : null, el("span", { class: "loc", text: where(f) })];
  // Findings saved before the readable parts existed have one free-text body.
  if (!f.title) return el("div", { class: cls }, kids.concat([richText("p", f.body || "")]));
  return el("div", { class: cls }, kids.concat([
    el("p", { class: "ftitle", text: f.title }),
    labeled("What's wrong", f.problem),
    labeled("What happens if not fixed", f.impact),
    labeled("Fix", f.fix),
    f.suggestion ? el("pre", { class: "sugg", text: f.suggestion }) : null,
    el("details", {}, [el("summary", { text: "Why I think so" }), richText("p", f.why, "why")]),
  ]));
}
// The PR's Linear ticket, as round 1 checked it; or that none was found.
function ticketLine(job, ticket, run) {
  if (!ticket) return el("p", { class: "meta", text: run ? "No ticket found: checked for code problems only." : "No ticket read yet." });
  var items = ticket.tickets.map(function (t) {
    var note = t.templateOnly ? " (title only)" : "";
    return el("span", {}, [el("a", { href: t.url, target: "_blank", rel: "noopener", text: t.id + " ↗" }), document.createTextNode(" " + t.title + note)]);
  });
  var refresh = el("button", { type: "button", text: "Refresh ticket", title: "Read the ticket again from Linear's comment on the next review. Only round 1 checks the code against it." });
  refresh.addEventListener("click", function () {
    refresh.disabled = true;
    api("/api/jobs/" + job.id + "/refresh-ticket", true)
      .then(function () { toast("Ticket will be read again on the next review."); select(job.id); })
      .catch(function (err) { toast(err.message); refresh.disabled = false; });
  });
  return el("p", { class: "meta" }, [el("span", { text: "Ticket:" })].concat(items, ticket.truncated ? [el("span", { text: "(cut to fit)" })] : [], [refresh]));
}
function renderDetail(data) {
  var job = data.job, run = data.review, d = describe(job);
  var parts = [
    el("h2", { text: job.repo + "#" + job.pr + " · " + job.title }),
    el("p", { class: "meta" }, [
      el("span", {}, [el("span", { class: "chip " + d[1], text: d[0] })]),
      el("span", { class: "ref", text: job.head_sha.slice(0, 7) }),
      run ? el("span", { text: (run.durationMs / 60000).toFixed(1) + " min · $" + run.costUsd.toFixed(2) + " · " + run.numTurns + " turns" }) : null,
      run && run.style ? el("span", { text: LABELS[run.style] || run.style }) : null,
      el("a", { href: job.url, target: "_blank", rel: "noopener", text: "PR ↗" }),
      job.review_url ? el("a", { href: job.review_url, target: "_blank", rel: "noopener", text: "Posted review ↗" }) : null
    ]),
    actionsFor(job).length ? el("div", { class: "actions" }, actionsFor(job).map(function (a) { return actionButton(job, a); })) : null
  ];
  if (job.error) parts.push(el("p", { class: "summary", text: "Error: " + job.error }));
  if (data.ticket !== undefined) parts.push(ticketLine(job, data.ticket, run));
  if (job.status === "held") parts.push(el("p", { class: "summary", text: "This would request changes. Drop the findings you disagree with, then press Post. Untouched findings post as written." + (job.hold_until ? " If you do nothing, it posts at " + time(job.hold_until) + "." : "") }));
  if (run) {
    parts.push(richText("p", run.review.summary, "summary"));
    var fu = run.followUp;
    if (fu) {
      parts.push(el("h3", { text: "Earlier findings · round " + fu.round + " · since " + fu.prevSha.slice(0, 7) + (fu.linear ? "" : " (history rewritten)") }));
      fu.previous.forEach(function (p) {
        var s = SEVERITY[p.severity] || [p.severity, "quiet"], v = VERDICT[p.verdict] || [p.verdict, "quiet"];
        // Nits and questions never block: left alone they are only optional.
        if ((p.severity === "nit" || p.severity === "question") && (p.verdict === "not_fixed" || p.verdict === "partly_fixed")) v = [v[0] + " · optional", "quiet"];
        parts.push(el("div", { class: "finding" }, [
          el("span", { class: "fid", text: p.id }), el("span", { class: "chip " + s[1], text: s[0] }), el("span", { class: "loc", text: where(p) }),
          document.createTextNode(" → "), el("span", { class: "chip " + v[1], text: v[0] }),
          richText("p", p.reply),
          el("p", { class: "why", text: "Evidence: " + p.evidence }),
          p.overruled ? el("p", { class: "why", text: "Overruled: " + p.overruled }) : null
        ]));
      });
      if (!fu.previous.length) parts.push(el("p", { class: "summary", text: "Nothing left to check." }));
      if (run.review.findings.length) parts.push(el("h3", { text: "New since the last review" }));
    }
    run.review.findings.slice().sort(function (a, b) { return ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity); }).forEach(function (f) {
      parts.push(findingRow(f, job));
    });
    if (!run.review.findings.length && !fu) parts.push(el("p", { class: "summary", text: "No findings." }));
  } else if (!job.error) {
    parts.push(el("p", { class: "summary", text: job.status === "skipped" ? "Not reviewed: " + (job.reason || "skipped") + "." : "No review saved yet." }));
  }
  document.getElementById("detail").replaceChildren(el("div", { class: "detail" }, parts));
}
function select(id) {
  selected = id;
  api("/api/jobs/" + id).then(renderDetail).catch(function (err) { toast(err.message); });
  refresh();
}

function refresh() {
  if (busy) return;
  busy = true;
  Promise.all([api("/api/status"), api("/api/jobs?limit=50")])
    .then(function (r) { renderStatus(r[0]); renderJobs(r[1]); })
    .catch(function () {
      document.getElementById("facts").replaceChildren(el("span", {}, [el("span", { class: "dot off" }), document.createTextNode("Server not reachable. Is it running? npm run status")]));
    })
    .finally(function () { busy = false; });
}

document.getElementById("pause").addEventListener("click", function () {
  var b = this; b.disabled = true;
  api(paused ? "/api/posting/resume" : "/api/posting/pause", true)
    .then(function (r) { toast(r.postingPaused ? "Posting paused" : "Posting resumed"); refresh(); })
    .catch(function (err) { toast(err.message); })
    .finally(function () { b.disabled = false; });
});
// A notification links to #job-<id>: open that review.
var linked = /^#job-(\\d+)$/.exec(location.hash);
if (linked) select(Number(linked[1])); else refresh();
setInterval(function () { refresh(); if (selected != null) api("/api/jobs/" + selected).then(renderDetail).catch(function () {}); }, 5000);
</script>
</body>
</html>`;
}
