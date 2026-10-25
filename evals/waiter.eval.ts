import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The tool modules are server-only (they talk to Supabase in production);
// here they're only read for their names, descriptions and schemas.
vi.mock("server-only", () => ({}));

/**
 * The AI waiter's evaluation: every scenario in waiter/scenarios.ts,
 * played through the real waiter logic against a real model.
 *
 *   npm run eval:waiter
 *
 * Environment:
 *   OPENROUTER_API_KEY   required (read from .env.local by the npm script)
 *   EVAL_MODELS          comma-separated OpenRouter model ids; default: the
 *                        waiter's first built-in model (free)
 *   EVAL_ONLY            comma-separated scenario ids or categories
 *   EVAL_REPEAT          run each scenario N times (default 1), to see flakiness
 *   EVAL_CONCURRENCY     scenarios in flight at once (default 2; free models rate-limit)
 *   EVAL_MIN_PASS_RATE   fail the run below this percentage (default: report only)
 *
 * Writes evals/results/<timestamp>-<model>.json and .md.
 */

const apiKey = process.env.OPENROUTER_API_KEY;

describe.skipIf(!apiKey)("AI waiter evaluation", () => {
  it("runs every scenario and writes a report", async () => {
    const { SCENARIOS } = await import("./waiter/scenarios");
    const { runScenario } = await import("./waiter/runner");
    const { summarize, toMarkdown } = await import("./waiter/report");
    const { defaultWaiterModels } = await import("@/lib/ai/config");

    const models = (process.env.EVAL_MODELS ?? defaultWaiterModels()[0])
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const only = (process.env.EVAL_ONLY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const scenarios = only.length
      ? SCENARIOS.filter(
          (s) => only.includes(s.id) || only.includes(s.category),
        )
      : SCENARIOS;
    const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1));
    const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 2));
    const minPassRate = process.env.EVAL_MIN_PASS_RATE
      ? Number(process.env.EVAL_MIN_PASS_RATE)
      : null;

    const outDir = path.resolve(import.meta.dirname, "results");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    for (const model of models) {
      const queue = scenarios.flatMap((s) =>
        Array.from({ length: repeat }, () => s),
      );
      const results: Awaited<ReturnType<typeof runScenario>>[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < queue.length) {
            const scenario = queue[next++];
            const result = await runScenario(scenario, model, apiKey!);
            results.push(result);
            console.info(
              `${result.passed ? "✓" : result.infraError ? "?" : "✗"} ${model} ${scenario.id}` +
                (result.passed
                  ? ""
                  : ` — ${
                      result.infraError ??
                      result.checks
                        .filter((c) => !c.passed)
                        .map((c) => c.name)
                        .join("; ")
                    }`),
            );
          }
        }),
      );

      const order = new Map(scenarios.map((s, i) => [s.id, i]));
      results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const summary = summarize(model, results);
      const slug = model.replace(/[^a-z0-9]+/gi, "_");
      writeFileSync(
        path.join(outDir, `${stamp}-${slug}.json`),
        JSON.stringify({ summary, results }, null, 2),
      );
      writeFileSync(
        path.join(outDir, `${stamp}-${slug}.md`),
        toMarkdown(summary, results),
      );
      console.info(
        `\n${model}: ${summary.passed}/${summary.judged} passed (${summary.passRate}%), ${summary.infraErrors} unjudged\n`,
      );

      if (minPassRate !== null) {
        expect(summary.passRate, `${model} pass rate`).toBeGreaterThanOrEqual(
          minPassRate,
        );
      }
    }
  });
});
