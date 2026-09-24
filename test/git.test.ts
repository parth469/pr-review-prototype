import { describe, expect, it } from "vitest";
import { git, gitEnv } from "../src/git.ts";

describe("git", () => {
  it("runs a command", async () => {
    expect(await git(["--version"])).toMatch(/^git version/);
  });

  it("kills a command that hangs and says it timed out", async () => {
    const started = Date.now();
    // Waits forever for credential input on stdin.
    await expect(git(["credential", "fill"], { timeoutMs: 1500 })).rejects.toThrow(
      "git credential timed out after 2 s",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("never prompts and keeps the token off the command line", () => {
    const env = gitEnv("secret");
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    const header = Object.entries(env).find(
      ([k, v]) => k.startsWith("GIT_CONFIG_VALUE_") && v?.startsWith("AUTHORIZATION"),
    );
    expect(header?.[1]).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
    );
  });
});
