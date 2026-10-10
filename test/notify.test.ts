import { describe, expect, it } from "vitest";
import {
  buildToastScript,
  buildToastXml,
  createNotifier,
  escapeXml,
  notificationFor,
} from "../src/notify.ts";
import type { ReviewRun } from "../src/reviewer.ts";
import type { Job } from "../src/state.ts";
import { silentLog } from "./helpers.ts";

const job = {
  repo: "acme/api",
  pr: 128,
  title: "Fix session refresh",
  url: "https://github.com/acme/api/pull/128",
} as Job;
const run = {
  review: {
    summary: "s",
    verdict: "request_changes",
    findings: [
      { path: "a", line: 1, severity: "bug", body: "x" },
      { path: "a", line: 2, severity: "bug", body: "x" },
      { path: "a", line: 3, severity: "nit", body: "x" },
    ],
  },
} as ReviewRun;

describe("toast", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml(`a & <b> "c" 'd'`)).toBe("a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;");
  });

  it("opens the URL on click", () => {
    const xml = buildToastXml({ title: "T & t", body: "B", url: "https://x/?a=1&b=2" });
    expect(xml).toContain(`activationType="protocol" launch="https://x/?a=1&amp;b=2"`);
    expect(xml).toContain("<text>T &amp; t</text>");
  });

  it("leaves out the click action without a URL", () => {
    expect(buildToastXml({ title: "T", body: "B" })).not.toContain("launch=");
  });

  it("puts the XML in a literal PowerShell here-string", () => {
    const script = buildToastScript({ title: "$(Remove-Item x)", body: "B" });
    expect(script.startsWith("$xml = @'\n")).toBe(true);
    expect(script).toContain("<text>$(Remove-Item x)</text>");
    expect(script).toContain("</toast>\n'@\n");
    expect(script).toContain("CreateToastNotifier(");
  });
});

describe("notificationFor", () => {
  it("summarises a posted review and links to it", () => {
    expect(
      notificationFor({
        type: "posted",
        job,
        run,
        review: { id: 1, url: "https://r", state: "CHANGES_REQUESTED" },
      }),
    ).toEqual({
      title: "Requested changes · acme/api#128",
      body: "2 bugs · 1 nit — Fix session refresh",
      url: "https://r",
    });
  });

  it("counts verdicts for a follow-up and says when it approved", () => {
    const followUp = {
      ...run,
      review: { ...run.review, findings: [run.review.findings[0]] },
      followUp: {
        previous: [{ verdict: "fixed" }, { verdict: "fixed" }, { verdict: "not_fixed" }],
      },
    } as ReviewRun;
    expect(
      notificationFor({
        type: "posted",
        job,
        run: followUp,
        review: { id: 1, url: "https://r", state: "APPROVED" },
      }),
    ).toEqual({
      title: "Approved · acme/api#128",
      body: "2 fixed · 1 open · new: 1 bug — Fix session refresh",
      url: "https://r",
    });
  });

  it("asks for your OK when a follow-up waits as a draft", () => {
    expect(
      notificationFor({
        type: "posted",
        job,
        run,
        review: { id: 1, url: "https://r", state: "PENDING" },
        needsYou: "explained bug F2: accept the reason?",
      }),
    ).toMatchObject({
      title: "Needs your OK · acme/api#128",
      body: "explained bug F2: accept the reason? — Fix session refresh",
    });
  });

  it("asks for your OK when a review waits before requesting changes", () => {
    const held = notificationFor(
      { type: "held", job: { ...job, id: 7 }, run, until: new Date("2026-10-09T10:30:00") },
      { statusUrl: "http://localhost:4777" },
    );
    expect(held).toMatchObject({
      title: "Needs your OK · acme/api#128",
      url: "http://localhost:4777/#job-7",
    });
    expect(held.body).toMatch(/^Would request changes: 2 bugs · 1 nit · posts at 10:30 — Fix/);
  });

  it("says when a held review waits for you, and links to the PR without a status page", () => {
    const held = notificationFor({ type: "held", job, run, until: null });
    expect(held.body).toContain("· waits for you —");
    expect(held.url).toBe(job.url);
  });

  it("says a review was posted after the wait ran out", () => {
    expect(
      notificationFor({
        type: "posted",
        job,
        run,
        review: { id: 1, url: "https://r", state: "CHANGES_REQUESTED" },
        afterTimer: true,
      }).title,
    ).toBe("Requested changes after the wait · acme/api#128");
  });

  it("links a failure to the PR", () => {
    expect(notificationFor({ type: "failed", job, step: "posting", error: "GitHub 502" })).toEqual({
      title: "Review failed · acme/api#128",
      body: "Could not post: GitHub 502",
      url: job.url,
    });
  });
});

describe("createNotifier", () => {
  it("runs the script on Windows and never throws", async () => {
    const scripts: string[] = [];
    const ok = createNotifier({ enabled: true }, silentLog, async (s) => void scripts.push(s));
    await ok.notify({ title: "T", body: "B" });
    expect(scripts).toHaveLength(process.platform === "win32" ? 1 : 0);

    const broken = createNotifier({ enabled: true }, silentLog, async () => {
      throw new Error("no toast");
    });
    await expect(broken.notify({ title: "T", body: "B" })).resolves.toBeUndefined();
  });

  it("does nothing when disabled", async () => {
    let calls = 0;
    await createNotifier({ enabled: false }, silentLog, async () => void calls++).notify({
      title: "T",
      body: "B",
    });
    expect(calls).toBe(0);
  });
});
