import { execFile } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { killTree } from "./git.ts";
import { isAlive, readLock } from "./lock.ts";
import { createLogger } from "./log.ts";
import { createNotifier, escapeXml } from "./notify.ts";
import { type JobStatus, openState } from "./state.ts";
import { SUPERVISOR_LOCK } from "./supervisor.ts";

const execFileAsync = promisify(execFile);

export const TASK_NAME = "Proxy Reviewer";

export interface TaskSpec {
  user: string; // DOMAIN\user
  nodePath: string;
  projectDir: string;
  conhostPath: string;
}

/** Task Scheduler definition: at logon, as you, no window, no time limit, restart on failure. */
export function buildTaskXml({ user, nodePath, projectDir, conhostPath }: TaskSpec): string {
  const supervisor = join("src", "supervisor.ts");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Proxy Reviewer: reviews GitHub PRs that request your review and posts the review.</Description>
    <URI>\\${escapeXml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(conhostPath)}</Command>
      <Arguments>--headless "${escapeXml(nodePath)}" ${escapeXml(supervisor)}</Arguments>
      <WorkingDirectory>${escapeXml(projectDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Pull "Key: value" pairs out of `schtasks /Query /V /FO LIST` output. */
export function parseTaskList(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^:]+):\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined && !(match[1].trim() in fields)) {
      fields[match[1].trim()] = match[2].trim();
    }
  }
  return fields;
}

async function schtasks(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("schtasks.exe", args, { windowsHide: true });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function install(): Promise<void> {
  const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  const conhostPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
  const xml = buildTaskXml({ user, nodePath: process.execPath, projectDir, conhostPath });
  const file = join(projectDir, "data", "task.xml");
  // Task Scheduler expects UTF-16 with a byte order mark, matching the XML declaration.
  writeFileSync(file, `\ufeff${xml}`, "utf16le");
  console.log(await schtasks(["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]));
  console.log(await schtasks(["/Run", "/TN", TASK_NAME]));
  console.log(`Installed. It starts at every logon. Check it with: npm run status`);
}

function newestLog(logDir: string): string | undefined {
  try {
    return readdirSync(logDir)
      .filter((f) => f.startsWith("proxy-reviewer") && f.endsWith(".log"))
      .map((f) => join(logDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/**
 * Ending the task only kills conhost; the node processes under it keep running.
 * So stop the supervisor's whole process tree (which includes the server) directly.
 */
async function stop(): Promise<void> {
  const config = await loadConfig(join(projectDir, "config.json"));
  const dataDir = resolve(projectDir, config.dataDir);
  await schtasks(["/End", "/TN", TASK_NAME]).catch(() => "");

  const pids = [SUPERVISOR_LOCK, "server.lock"]
    .map((file) => readLock(join(dataDir, file))?.pid)
    .filter((pid): pid is number => pid !== undefined && isAlive(pid));
  for (const pid of pids) await killTree(pid);
  for (let i = 0; i < 20 && pids.some(isAlive); i++) await sleep(250);

  const left = pids.filter(isAlive);
  if (left.length > 0) throw new Error(`Could not stop process ${left.join(", ")}`);
  console.log(pids.length > 0 ? `Stopped (pid ${pids.join(", ")}).` : "Not running.");
}

async function status(): Promise<void> {
  const config = await loadConfig(join(projectDir, "config.json"));
  const dataDir = resolve(projectDir, config.dataDir);

  try {
    const task = parseTaskList(await schtasks(["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]));
    console.log(
      `Task:        ${task.Status ?? "?"} · last run ${task["Last Run Time"] ?? "?"} · result ${task["Last Result"] ?? "?"}`,
    );
  } catch {
    console.log("Task:        not installed (npm run service -- install)");
  }

  const supervisor = readLock(join(dataDir, SUPERVISOR_LOCK));
  const lock = readLock(join(dataDir, "server.lock"));
  console.log(
    supervisor && isAlive(supervisor.pid)
      ? `Supervisor:  running · pid ${supervisor.pid}`
      : "Supervisor:  not running",
  );
  console.log(
    lock && isAlive(lock.pid)
      ? `Server:      running · pid ${lock.pid} · since ${lock.startedAt}`
      : "Server:      not running",
  );

  const state = openState(join(dataDir, "state.db"));
  const statuses: JobStatus[] = [
    "queued",
    "preparing",
    "reviewing",
    "reviewed",
    "posting",
    "done",
    "failed",
    "skipped",
  ];
  const counts = statuses.map((s) => [s, state.listByStatus(s)] as const);
  console.log(
    `Jobs:        ${
      counts
        .filter(([, j]) => j.length)
        .map(([s, j]) => `${j.length} ${s}`)
        .join(" · ") || "none"
    }`,
  );
  const recent = counts
    .flatMap(([, jobs]) => jobs)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);
  for (const job of recent) {
    const where = job.review_url ?? job.reason ?? job.error ?? "";
    console.log(
      `  ${job.updated_at.slice(0, 16).replace("T", " ")}  ${job.status.padEnd(9)} ${job.repo}#${job.pr}  ${where}`.trimEnd(),
    );
  }
  state.close();

  console.log(`Log:         ${newestLog(resolve(projectDir, config.logDir)) ?? "none yet"}`);
}

async function testNotify(): Promise<void> {
  const log = createLogger("info");
  await createNotifier({ enabled: true }, log).notify({
    title: "Proxy Reviewer",
    body: "Notifications work. Click to open your GitHub notifications.",
    url: "https://github.com/notifications",
  });
  console.log("Sent a test notification.");
}

const USAGE = "Usage: npm run service -- <install|uninstall|start|stop|status|test-notify>";

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (process.platform !== "win32" && command !== "status") {
      throw new Error("The background service is set up with Windows Task Scheduler only.");
    }
    switch (command) {
      case "install":
        await install();
        break;
      case "uninstall":
        await stop();
        console.log(await schtasks(["/Delete", "/TN", TASK_NAME, "/F"]));
        break;
      case "start":
        console.log(await schtasks(["/Run", "/TN", TASK_NAME]));
        break;
      case "stop":
        await stop();
        break;
      case "status":
        await status();
        break;
      case "test-notify":
        await testNotify();
        break;
      default:
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
