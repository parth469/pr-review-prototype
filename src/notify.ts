import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./log.ts";
import { countFindings } from "./publish.ts";
import type { ReviewRun, Verdict } from "./reviewer.ts";
import type { WorkerEvent } from "./worker.ts";

const execFileAsync = promisify(execFile);

export interface Notification {
  title: string;
  body: string;
  /** Opened in the browser when the notification is clicked. */
  url?: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

// Windows PowerShell's app id: toasts shown under it need no app registration of our own.
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildToastXml({ title, body, url }: Notification): string {
  const launch = url ? ` activationType="protocol" launch="${escapeXml(url)}"` : "";
  return (
    `<toast${launch}><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
    `<text placement="attribution">Proxy Reviewer</text>` +
    `</binding></visual></toast>`
  );
}

/** PowerShell that shows the toast through the built-in WinRT API; no extra modules needed. */
export function buildToastScript(notification: Notification): string {
  // Single-quoted here-string: nothing inside is expanded, and escaped XML never starts a line with '@.
  return [
    "$xml = @'",
    buildToastXml(notification),
    "'@",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml($xml)",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join("\n");
}

const POSTED_TITLE: Record<string, string> = {
  CHANGES_REQUESTED: "Requested changes",
  COMMENTED: "Commented",
  APPROVED: "Approved",
  PENDING: "Draft review ready",
};

const VERDICT_WORD: Record<Verdict, string> = {
  fixed: "fixed",
  explained: "explained",
  no_longer_applies: "gone",
  partly_fixed: "partly fixed",
  not_fixed: "open",
};

/** "3 fixed · 1 open · 1 new risk" for a follow-up. */
function followUpCounts(run: ReviewRun): string {
  const counts = new Map<string, number>();
  for (const p of run.followUp?.previous ?? []) {
    const word = VERDICT_WORD[p.verdict];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = [...counts].map(([word, n]) => `${n} ${word}`);
  const fresh = countFindings(run.review.findings);
  if (fresh) parts.push(`new: ${fresh}`);
  return parts.join(" · ") || "Nothing left to check";
}

const clock = (d: Date) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The desktop notification for a worker event. `statusUrl`: the status page, if it runs. */
export function notificationFor(
  event: WorkerEvent,
  { statusUrl }: { statusUrl?: string | undefined } = {},
): Notification {
  const ref = `${event.job.repo}#${event.job.pr}`;
  if (event.type === "held") {
    const counts = event.run.followUp
      ? followUpCounts(event.run)
      : countFindings(event.run.review.findings);
    const when = event.until ? `posts at ${clock(event.until)}` : "waits for you";
    return {
      title: `Needs your OK · ${ref}`,
      body: `Would request changes: ${counts} · ${when} — ${event.job.title}`.slice(0, 250),
      url: statusUrl ? `${statusUrl}/#job-${event.job.id}` : event.job.url,
    };
  }
  if (event.type === "posted") {
    const counts = event.run.followUp
      ? followUpCounts(event.run)
      : countFindings(event.run.review.findings) || "No issues found";
    if (event.needsYou) {
      return {
        title: `Needs your OK · ${ref}`,
        body: `${event.needsYou} — ${event.job.title}`.slice(0, 250),
        url: event.review.url,
      };
    }
    const title = POSTED_TITLE[event.review.state] ?? "Reviewed";
    return {
      title: `${event.afterTimer ? `${title} after the wait` : title} · ${ref}`,
      body: `${counts} — ${event.job.title}`,
      url: event.review.url,
    };
  }
  return {
    title: `Review failed · ${ref}`,
    body: `${event.step === "posting" ? "Could not post" : "Could not review"}: ${event.error}`.slice(
      0,
      250,
    ),
    url: event.job.url,
  };
}

export type RunScript = (script: string) => Promise<void>;

const runPowerShell: RunScript = async (script) => {
  // -EncodedCommand takes UTF-16LE base64, which sidesteps every quoting problem.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { windowsHide: true, timeout: 30_000 },
  );
};

export function createNotifier(
  { enabled }: { enabled: boolean },
  log: Logger,
  run: RunScript = runPowerShell,
): Notifier {
  return {
    async notify(notification) {
      if (!enabled || process.platform !== "win32") return;
      try {
        await run(buildToastScript(notification));
      } catch (err) {
        // A missed notification must never break a review.
        log.warn({ err, title: notification.title }, "could not show notification");
      }
    },
  };
}
