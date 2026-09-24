import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitOptions {
  cwd?: string;
  /** GitHub token for https fetches. Sent as a header through env, never on the command line. */
  token?: string;
}

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

export async function git(args: string[], { cwd, token }: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: gitEnv(token),
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}
