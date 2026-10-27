import { describe, expect, it } from "vitest";
import {
  baselineFrom,
  compareRuns,
  comparisonMarkdown,
  needsAttention,
  type EvalResult,
} from "../../evals/compare-core";

// The nightly watch's eval comparison (agents/nightly-watch.md): what
// counts as getting worse, and what never raises an alarm.

const result = (
  id: string,
  passed: boolean,
  extra: Partial<EvalResult> = {},
): EvalResult => ({
  id,
  category: "facts",
  passed,
  checks: passed
    ? [{ name: "a check", passed: true }]
    : [
        { name: "a check", passed: true },
        { name: "sends them to staff", passed: false },
      ],
  ...extra,
});

const baseline = baselineFrom(
  "free/model:free",
  [
    result("allergy", true),
    result("pairing", true),
    result("halal", false),
    result("busy-then", true),
    result("retired", true),
  ],
  "2026-10-27T18:00:00Z",
);

describe("comparing a night's evaluation with the baseline", () => {
  const c = compareRuns(baseline, "free/model:free", [
    result("allergy", false),
    result("pairing", true),
    result("halal", true),
    result("busy-then", false, { infraError: "rate limited" }),
    result("new-one", true),
  ]);

  it("calls a scenario that stopped passing a regression, with what broke", () => {
    expect(c.regressions).toEqual([
      { id: "allergy", failedChecks: ["sends them to staff"] },
    ]);
    expect(needsAttention(c)).toBe(true);
  });

  it("never counts a busy model as a regression", () => {
    expect(c.unjudged).toEqual([{ id: "busy-then", reason: "rate limited" }]);
    expect(c.regressions.map((r) => r.id)).not.toContain("busy-then");
  });

  it("notes fixes, new scenarios and ones not run", () => {
    expect(c.fixed).toEqual(["halal"]);
    expect(c.added).toEqual([{ id: "new-one", passed: true }]);
    expect(c.missing).toEqual(["retired"]);
  });

  it("is quiet when nothing got worse", () => {
    const quiet = compareRuns(baseline, "free/model:free", [
      result("allergy", true),
      result("halal", false),
    ]);
    expect(needsAttention(quiet)).toBe(false);
    expect(comparisonMarkdown(quiet)).toContain("Nothing got worse.");
  });

  it("raises a new scenario that fails", () => {
    const c2 = compareRuns(baseline, "free/model:free", [
      result("brand-new", false),
    ]);
    expect(needsAttention(c2)).toBe(true);
  });

  it("keeps no verdict for a scenario the baseline run couldn't judge", () => {
    const b = baselineFrom(
      "m",
      [result("x", true), result("y", false, { infraError: "timeout" })],
      "2026-10-27T00:00:00Z",
    );
    expect(Object.keys(b.scenarios)).toEqual(["x"]);
  });
});
