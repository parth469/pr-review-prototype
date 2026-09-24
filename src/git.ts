import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitOptions {
  cwd?: string;
  /** GitHub token for https fetches. Sent as a header through env, never on the command line. */
  token?: string;
  /** Kill git (and its helpers) after this long. A stuck fetch must not freeze the queue. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Env for a git process that can never stop to ask for input or run LFS downloads. */
export function gitEnv(token?: string): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    // Empty value resets the helper list, so Git Credential Manager never opens a login window.
    ["credential.helper", ""],
    ["core.longpaths", "true"],
  ];
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Kill a process and everything it started. On Windows killing git.exe alone leaves helpers. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(
      () => undefined, // already gone
    );
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function git(
  args: string[],
  { cwd, token, timeoutMs = DEFAULT_TIMEOUT_MS }: GitOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    const child = execFile(
      "git",
      args,
      { cwd, env: gitEnv(token), windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`));
        } else if (err) {
          reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid);
      else child.kill("SIGKILL");
    }, timeoutMs);
  });
}
