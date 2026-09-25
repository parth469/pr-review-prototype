import { describe, expect, it } from "vitest";
import { combineCi } from "../src/github.ts";

const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });

describe("combineCi", () => {
  it("is none without checks or statuses", () => {
    expect(combineCi([], [])).toBe("none");
  });

  it("is success when everything passed or was skipped", () => {
    expect(
      combineCi(
        [run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")],
        [{ state: "success" }],
      ),
    ).toBe("success");
  });

  it("is pending while anything runs", () => {
    expect(combineCi([run("completed", "success"), run("in_progress")], [])).toBe("pending");
    expect(combineCi([], [{ state: "pending" }])).toBe("pending");
  });

  it("fails on any failed check or status, even while others run", () => {
    expect(combineCi([run("in_progress"), run("completed", "failure")], [])).toBe("failure");
    expect(combineCi([run("completed", "timed_out")], [])).toBe("failure");
    expect(combineCi([], [{ state: "error" }])).toBe("failure");
  });
});
