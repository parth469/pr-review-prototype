import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openState, type SeenInput, type State } from "../src/state.ts";

const base: SeenInput = {
  repo: "acme/api",
  pr: 128,
  headSha: "3f9c2e1",
  title: "Add session refresh",
  url: "https://github.com/acme/api/pull/128",
  decision: { action: "queue" },
};

describe("state", () => {
  let state: State;
  beforeEach(() => {
    state = openState(":memory:");
  });
  afterEach(() => state.close());

  it("records a commit once", () => {
    expect(state.recordSeen(base)).toBe("new");
    expect(state.recordSeen(base)).toBe("known");
    expect(state.listByStatus("queued")).toHaveLength(1);
  });

  it("treats a new head SHA as a new job", () => {
    state.recordSeen(base);
    expect(state.recordSeen({ ...base, headSha: "9aa01bc" })).toBe("new");
    expect(state.listByStatus("queued")).toHaveLength(2);
  });

  it("requeues a skipped job that became eligible", () => {
    state.recordSeen({ ...base, decision: { action: "skip", reason: "draft" } });
    expect(state.listByStatus("skipped")[0]?.reason).toBe("draft");

    expect(state.recordSeen(base)).toBe("requeued");
    expect(state.listByStatus("skipped")).toHaveLength(0);
    expect(state.listByStatus("queued")[0]?.reason).toBeNull();
  });

  it("does not requeue a queued job that is now skipped", () => {
    state.recordSeen(base);
    const result = state.recordSeen({ ...base, decision: { action: "skip", reason: "draft" } });
    expect(result).toBe("known");
    expect(state.listByStatus("queued")).toHaveLength(1);
  });
});
