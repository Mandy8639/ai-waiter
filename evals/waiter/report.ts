import type { ScenarioResult } from "./runner";

/**
 * Turns a run into numbers: pass rate overall and per category, which
 * checks fail most, and the runs that couldn't be judged. Pure, so the
 * arithmetic is unit-tested (tests/unit/waiter-eval-checks.test.ts).
 */

export interface RunSummary {
  model: string;
  scenarios: number;
  judged: number;
  passed: number;
  /** passed / judged; infrastructure failures are excluded, not counted as fails. */
  passRate: number;
  infraErrors: number;
  byCategory: Record<
    string,
    { judged: number; passed: number; passRate: number }
  >;
  /** Failed checks, most frequent first. */
  topFailures: { check: string; count: number; scenarios: string[] }[];
  medianMs: number;
}

const rate = (passed: number, judged: number) =>
  judged === 0 ? 0 : Math.round((passed / judged) * 1000) / 10;

export function summarize(
  model: string,
  results: ScenarioResult[],
): RunSummary {
  const judged = results.filter((r) => !r.infraError);
  const byCategory: RunSummary["byCategory"] = {};
  for (const r of judged) {
    const c = (byCategory[r.category] ??= {
      judged: 0,
      passed: 0,
      passRate: 0,
    });
    c.judged += 1;
    if (r.passed) c.passed += 1;
  }
  for (const c of Object.values(byCategory))
    c.passRate = rate(c.passed, c.judged);

  const failures = new Map<string, Set<string>>();
  for (const r of judged) {
    for (const check of r.checks.filter((x) => !x.passed)) {
      const set = failures.get(check.name) ?? new Set<string>();
      set.add(r.id);
      failures.set(check.name, set);
    }
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);

  return {
    model,
    scenarios: results.length,
    judged: judged.length,
    passed: judged.filter((r) => r.passed).length,
    passRate: rate(judged.filter((r) => r.passed).length, judged.length),
    infraErrors: results.length - judged.length,
    byCategory,
    topFailures: [...failures.entries()]
      .map(([check, set]) => ({ check, count: set.size, scenarios: [...set] }))
      .sort((a, b) => b.count - a.count),
    medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
  };
}

export function toMarkdown(
  summary: RunSummary,
  results: ScenarioResult[],
): string {
  const lines = [
    `# Waiter evaluation: ${summary.model}`,
    "",
    `**${summary.passed}/${summary.judged} scenarios passed (${summary.passRate}%)**` +
      (summary.infraErrors
        ? ` · ${summary.infraErrors} couldn't be judged (model call failed)`
        : "") +
      ` · median ${Math.round(summary.medianMs / 1000)}s per scenario`,
    "",
    "| Category | Passed | Rate |",
    "| --- | --- | --- |",
    ...Object.entries(summary.byCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, c]) => `| ${name} | ${c.passed}/${c.judged} | ${c.passRate}% |`,
      ),
    "",
  ];
  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    lines.push("## Failures", "");
    for (const r of failed) {
      lines.push(`### ${r.id} (${r.category})`);
      if (r.infraError) lines.push(`- couldn't be judged: ${r.infraError}`);
      for (const c of r.checks.filter((x) => !x.passed))
        lines.push(`- ✗ ${c.name}: ${c.reason}`);
      for (const t of r.turns) {
        lines.push(`  - **Diner:** ${t.user}`);
        if (t.calls.length) {
          lines.push(
            `  - Tools: ${t.calls.map((c) => `${c.name}${c.ok ? "" : " ✗"}`).join(", ")}`,
          );
        }
        lines.push(
          `  - **Waiter:** ${t.reply.replace(/\n+/g, " ").slice(0, 400)}`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
