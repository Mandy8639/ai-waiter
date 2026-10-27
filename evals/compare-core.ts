/**
 * The nightly watch's eval comparison (agents/nightly-watch.md): last
 * night's waiter evaluation against the committed baseline
 * (evals/baseline.json). Pure, so it's unit-tested
 * (tests/unit/eval-compare.test.ts); scripts/watch/compare-evals.ts reads
 * the files.
 *
 * A regression is a scenario that passed in the baseline and failed now,
 * with the checks that broke. A scenario the model couldn't be asked
 * (rate limit, timeout: `infraError`) is unjudged, never a regression:
 * free models get busy, and an alarm for that would teach everyone to
 * ignore the alarm.
 */

export interface EvalResult {
  id: string;
  category: string;
  passed: boolean;
  infraError?: string | null;
  checks: { name: string; passed: boolean }[];
}

export interface Baseline {
  model: string;
  /** When the baseline run happened (ISO). */
  recordedAt: string;
  scenarios: Record<string, { passed: boolean; category: string }>;
}

export interface Comparison {
  model: string;
  regressions: { id: string; failedChecks: string[] }[];
  fixed: string[];
  stillFailing: string[];
  unjudged: { id: string; reason: string }[];
  /** In the run but not the baseline: new scenarios, judged but not compared. */
  added: { id: string; passed: boolean }[];
  /** In the baseline but not the run (EVAL_ONLY, or a removed scenario). */
  missing: string[];
  passRateBefore: number;
  passRateAfter: number;
}

const rate = (passed: number, judged: number) =>
  judged === 0 ? 0 : Math.round((passed / judged) * 1000) / 10;

export function compareRuns(
  baseline: Baseline,
  model: string,
  results: EvalResult[],
): Comparison {
  const out: Comparison = {
    model,
    regressions: [],
    fixed: [],
    stillFailing: [],
    unjudged: [],
    added: [],
    missing: [],
    passRateBefore: 0,
    passRateAfter: 0,
  };
  const seen = new Set<string>();
  for (const r of results) {
    seen.add(r.id);
    if (r.infraError) {
      out.unjudged.push({ id: r.id, reason: r.infraError });
      continue;
    }
    const before = baseline.scenarios[r.id];
    if (!before) {
      out.added.push({ id: r.id, passed: r.passed });
    } else if (before.passed && !r.passed) {
      out.regressions.push({
        id: r.id,
        failedChecks: r.checks.filter((c) => !c.passed).map((c) => c.name),
      });
    } else if (!before.passed && r.passed) {
      out.fixed.push(r.id);
    } else if (!before.passed && !r.passed) {
      out.stillFailing.push(r.id);
    }
  }
  out.missing = Object.keys(baseline.scenarios).filter((id) => !seen.has(id));

  const all = Object.values(baseline.scenarios);
  out.passRateBefore = rate(all.filter((s) => s.passed).length, all.length);
  const judged = results.filter((r) => !r.infraError);
  out.passRateAfter = rate(
    judged.filter((r) => r.passed).length,
    judged.length,
  );
  return out;
}

/** True when the night needs a human: something that worked stopped working. */
export function needsAttention(c: Comparison): boolean {
  return c.regressions.length > 0 || c.added.some((a) => !a.passed);
}

export function baselineFrom(
  model: string,
  results: EvalResult[],
  recordedAt: string,
): Baseline {
  const scenarios: Baseline["scenarios"] = {};
  for (const r of results) {
    // An unjudged scenario has no verdict to keep.
    if (r.infraError) continue;
    scenarios[r.id] = { passed: r.passed, category: r.category };
  }
  return { model, recordedAt, scenarios };
}

export function comparisonMarkdown(c: Comparison): string {
  const lines = [
    `### Waiter evaluation: ${c.model}`,
    "",
    `Pass rate ${c.passRateAfter}% (baseline ${c.passRateBefore}%).`,
    "",
  ];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`**${title}**`, "", ...items.map((i) => `- ${i}`), "");
  };
  section(
    "Regressions (passed in the baseline, failed now)",
    c.regressions.map(
      (r) => `\`${r.id}\`: ${r.failedChecks.join("; ") || "failed"}`,
    ),
  );
  section(
    "New scenarios",
    c.added.map((a) => `\`${a.id}\`: ${a.passed ? "passed" : "FAILED"}`),
  );
  section(
    "Fixed since the baseline",
    c.fixed.map((id) => `\`${id}\``),
  );
  section(
    "Still failing (known)",
    c.stillFailing.map((id) => `\`${id}\``),
  );
  section(
    "Not judged (the model was busy or timed out)",
    c.unjudged.map((u) => `\`${u.id}\`: ${u.reason}`),
  );
  if (!needsAttention(c)) lines.push("Nothing got worse.");
  return lines.join("\n").trimEnd() + "\n";
}
