import { describe, expect, it } from "vitest";
import { type DecideInput, decideFollowUp } from "../src/decide.ts";
import type { Finding, Verdict } from "../src/reviewer.ts";
import { defaultConfig } from "./helpers.ts";

const p = (id: string, severity: Finding["severity"], verdict: Verdict) => ({
  id,
  severity,
  verdict,
});

function decide(overrides: Partial<DecideInput> = {}) {
  return decideFollowUp({
    previous: [],
    newFindings: [],
    ownPr: false,
    round: 2,
    ci: "success",
    ciWaitOver: false,
    settings: defaultConfig.followUp,
    ...overrides,
  });
}

describe("decideFollowUp", () => {
  it("approves when every bug and risk is fixed or gone", () => {
    expect(
      decide({
        previous: [p("F1", "bug", "fixed"), p("F2", "bug", "no_longer_applies")],
      }),
    ).toMatchObject({ kind: "post", event: "APPROVE", submit: true, needsYou: null });
  });

  it("leaves an approval with an explained risk to you, unless trusted", () => {
    expect(decide({ previous: [p("F3", "risk", "explained")] })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "explained risk F3: accept the reason?",
    });
    const trusting = { ...defaultConfig.followUp, explainedRiskNeedsYou: false };
    expect(decide({ previous: [p("F3", "risk", "explained")], settings: trusting })).toMatchObject({
      event: "APPROVE",
      submit: true,
    });
  });

  it("leaves an approval to you when a verdict was flagged for your check", () => {
    const flagged = { ...p("F1", "bug", "fixed"), needsYou: "F1 fixed in another file" };
    expect(decide({ previous: [flagged] })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "F1 fixed in another file",
    });
  });

  it.each<Verdict>(["not_fixed", "partly_fixed"])("requests changes for a bug left %s", (v) => {
    expect(decide({ previous: [p("F1", "bug", "fixed"), p("F2", "risk", v)] })).toMatchObject({
      event: "REQUEST_CHANGES",
      submit: true,
      reason: "F2 still open",
    });
  });

  it("never blocks on nits and questions, whatever their verdict", () => {
    expect(
      decide({ previous: [p("F1", "nit", "not_fixed"), p("F2", "question", "partly_fixed")] }),
    ).toMatchObject({ event: "APPROVE" });
    expect(decide({ newFindings: [{ severity: "nit" }] })).toMatchObject({ event: "APPROVE" });
  });

  it("requests changes for a new bug or risk", () => {
    expect(decide({ newFindings: [{ severity: "risk" }] })).toMatchObject({
      event: "REQUEST_CHANGES",
      reason: "1 new blocking",
    });
  });

  it("only comments on your own PR", () => {
    expect(decide({ ownPr: true, previous: [p("F1", "bug", "not_fixed")] })).toMatchObject({
      event: "COMMENT",
      reason: "own PR",
    });
  });

  it("leaves an approval with an explained bug to you", () => {
    expect(decide({ previous: [p("F1", "bug", "explained")] })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "explained bug F1: accept the reason?",
    });
    const trusting = { ...defaultConfig.followUp, explainedBugNeedsYou: false };
    expect(decide({ previous: [p("F1", "bug", "explained")], settings: trusting })).toMatchObject({
      event: "APPROVE",
      submit: true,
    });
  });

  it("comments instead of approving on red CI", () => {
    expect(decide({ ci: "failure", previous: [p("F1", "bug", "fixed")] })).toMatchObject({
      event: "COMMENT",
      reason: "CI failing",
    });
  });

  it("waits for running CI, then comments when the wait is over", () => {
    expect(decide({ ci: "pending" })).toEqual({ kind: "wait", reason: "waiting for CI" });
    expect(decide({ ci: "pending", ciWaitOver: true })).toMatchObject({
      event: "COMMENT",
      reason: "CI still running",
    });
  });

  it("does not wait when there is no CI, or CI is not required", () => {
    expect(decide({ ci: "none" })).toMatchObject({ event: "APPROVE" });
    const noCi = { ...defaultConfig.followUp, requireGreenCi: false };
    expect(decide({ ci: "failure", settings: noCi })).toMatchObject({ event: "APPROVE" });
  });

  it("requesting changes does not wait for CI", () => {
    expect(decide({ ci: "pending", previous: [p("F1", "bug", "not_fixed")] })).toMatchObject({
      event: "REQUEST_CHANGES",
    });
  });

  it("stops deciding on its own after the last automatic round", () => {
    expect(decide({ round: 4 })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "round 4: past 3 automatic rounds",
    });
    expect(decide({ round: 4, previous: [p("F1", "bug", "not_fixed")] })).toMatchObject({
      event: "REQUEST_CHANGES",
      submit: false,
    });
    expect(decide({ round: 3 })).toMatchObject({ submit: true });
  });

  it("can leave every approval as a draft", () => {
    const pending = { ...defaultConfig.followUp, approve: "pending" as const };
    expect(decide({ settings: pending })).toMatchObject({ event: "APPROVE", submit: false });
    expect(decide({ settings: pending, previous: [p("F1", "bug", "not_fixed")] })).toMatchObject({
      event: "REQUEST_CHANGES",
      submit: true,
    });
  });
});
