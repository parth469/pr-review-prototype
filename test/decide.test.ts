import { describe, expect, it } from "vitest";
import { type DecideInput, decideFollowUp } from "../src/decide.ts";
import type { Finding, Verdict } from "../src/reviewer.ts";
import { defaultConfig } from "./helpers.ts";

const p = (id: string, severity: Finding["severity"], verdict: Verdict, mustFix = true) => ({
  id,
  severity,
  mustFix,
  verdict,
});

function decide(overrides: Partial<DecideInput> = {}) {
  return decideFollowUp({
    previous: [],
    newFindings: [],
    ownPr: false,
    round: 2,
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

  it("approves an explained risk, unless set to wait for you", () => {
    expect(decide({ previous: [p("F3", "risk", "explained")] })).toMatchObject({
      event: "APPROVE",
      submit: true,
    });
    const strict = { ...defaultConfig.followUp, explainedRiskNeedsYou: true };
    expect(decide({ previous: [p("F3", "risk", "explained")], settings: strict })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "explained risk F3: accept the reason?",
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

  it("ignores a check flag on a finding that is not must-fix", () => {
    const flagged = { ...p("F1", "risk", "fixed", false), needsYou: "F1 fixed in another file" };
    expect(decide({ previous: [flagged] })).toMatchObject({ event: "APPROVE", submit: true });
  });

  it("approves with a minor risk still open or partly fixed", () => {
    expect(
      decide({
        previous: [p("F1", "bug", "fixed"), p("F2", "risk", "not_fixed", false)],
      }),
    ).toMatchObject({ event: "APPROVE", submit: true });
    expect(decide({ previous: [p("F2", "risk", "partly_fixed", false)] })).toMatchObject({
      event: "APPROVE",
    });
  });

  it("counts an old risk saved without a grade as minor, and a bug as must-fix", () => {
    const old = (severity: Finding["severity"]) => ({
      id: "F1",
      severity,
      verdict: "not_fixed" as const,
    });
    expect(decide({ previous: [old("risk")] })).toMatchObject({ event: "APPROVE" });
    expect(decide({ previous: [old("bug")] })).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  it("never blocks on nits and questions, whatever their verdict", () => {
    expect(
      decide({ previous: [p("F1", "nit", "not_fixed"), p("F2", "question", "partly_fixed")] }),
    ).toMatchObject({ event: "APPROVE" });
    expect(decide({ newFindings: [{ severity: "nit" }] })).toMatchObject({ event: "APPROVE" });
  });

  it("requests changes for a new bug or serious risk, not a minor one", () => {
    expect(decide({ newFindings: [{ severity: "bug" }] })).toMatchObject({
      event: "REQUEST_CHANGES",
      reason: "1 new must-fix",
    });
    expect(decide({ newFindings: [{ severity: "risk", mustFix: true }] })).toMatchObject({
      event: "REQUEST_CHANGES",
    });
    expect(decide({ newFindings: [{ severity: "risk", mustFix: false }] })).toMatchObject({
      event: "APPROVE",
      submit: true,
    });
  });

  it("only comments on your own PR", () => {
    expect(decide({ ownPr: true, previous: [p("F1", "bug", "not_fixed")] })).toMatchObject({
      event: "COMMENT",
      reason: "own PR",
    });
  });

  it("approves an explained bug, unless set to wait for you", () => {
    expect(decide({ previous: [p("F1", "bug", "explained")] })).toMatchObject({
      event: "APPROVE",
      submit: true,
    });
    const strict = { ...defaultConfig.followUp, explainedBugNeedsYou: true };
    expect(decide({ previous: [p("F1", "bug", "explained")], settings: strict })).toMatchObject({
      event: "APPROVE",
      submit: false,
      needsYou: "explained bug F1: accept the reason?",
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
