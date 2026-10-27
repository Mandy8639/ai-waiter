/**
 * The nightly watch's eval step (agents/nightly-watch.md): compares the
 * newest waiter evaluation in evals/results/ with evals/baseline.json and
 * prints a Markdown summary. Exits 1 when something that passed in the
 * baseline fails now (or a new scenario fails), so the agent knows to
 * look; 0 otherwise.
 *
 *   npm run eval:compare                     compare the newest run
 *   npm run eval:compare -- --update-baseline  record the newest run as the baseline
 *   ... -- --from <file>                       use that results file instead of the newest
 *
 * Reads files only: no network, no database.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  baselineFrom,
  compareRuns,
  comparisonMarkdown,
  needsAttention,
  type Baseline,
  type EvalResult,
} from "../../evals/compare-core";

const root = path.resolve(import.meta.dirname, "../..");
const resultsDir = path.join(root, "evals/results");
const baselinePath = path.join(root, "evals/baseline.json");

function newestRun(): { file: string; model: string; results: EvalResult[] } {
  const from = process.argv.indexOf("--from");
  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const file =
    from > -1 ? path.basename(process.argv[from + 1] ?? "") : files.at(-1);
  if (!file)
    throw new Error("No evaluation results yet: run npm run eval:waiter");
  const body = JSON.parse(
    readFileSync(path.join(resultsDir, file), "utf8"),
  ) as {
    summary: { model: string };
    results: EvalResult[];
  };
  return { file, model: body.summary.model, results: body.results };
}

const run = newestRun();

if (process.argv.includes("--update-baseline")) {
  const baseline = baselineFrom(
    run.model,
    run.results,
    new Date().toISOString(),
  );
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.info(
    `Baseline recorded from ${run.file}: ${Object.keys(baseline.scenarios).length} scenarios.`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
const comparison = compareRuns(baseline, run.model, run.results);
console.info(
  `_From ${run.file}, against the baseline of ${baseline.recordedAt.slice(0, 10)}._\n`,
);
console.info(comparisonMarkdown(comparison));
process.exit(needsAttention(comparison) ? 1 : 0);
