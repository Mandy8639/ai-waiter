/**
 * The nightly watch's model vetting step (agents/nightly-watch.md).
 *
 *   npm run vet:models -- next --log <file>
 *       Prints the next free model worth evaluating as a waiter backup, or
 *       "none". Reads OpenRouter's public model list (no key needed).
 *   npm run vet:models -- record --log <file> --model <id> [--from <results.json>]
 *       Judges that model's newest evaluation in evals/results/ against
 *       evals/baseline.json, appends the verdict to the log, and prints it.
 *       Exits 0 if it passed, 2 if it didn't.
 *
 * The log lives outside main (the agent keeps it on its own branch), so a
 * model is tried at most once a month without anyone merging anything.
 * Free models only: anything without ":free" is refused, so a paid model
 * is never evaluated on the owner's bill.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TESTED_MODELS } from "../../src/lib/admin/model-catalogue";
import { NEVER_USE } from "../../src/lib/ai/safety-net-core";
import type { Baseline, EvalResult } from "../../evals/compare-core";
import {
  nextCandidate,
  parseModels,
  vettingVerdict,
  type VettingLog,
} from "../../evals/vetting-core";

const root = path.resolve(import.meta.dirname, "../..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const command = process.argv[2];
const logPath = arg("--log");
if (!logPath) throw new Error("--log <file> is required");

const readLog = (): VettingLog =>
  existsSync(logPath)
    ? (JSON.parse(readFileSync(logPath, "utf8")) as VettingLog)
    : { tested: [] };

async function next() {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`OpenRouter's model list: HTTP ${response.status}`);
  const candidate = nextCandidate({
    models: parseModels(await response.json()),
    vetted: TESTED_MODELS.waiter.map((t) => t.model),
    neverUse: Object.keys(NEVER_USE.waiter),
    log: readLog(),
    now: new Date(),
  });
  console.info(candidate ?? "none");
}

function record() {
  const model = arg("--model");
  if (!model?.endsWith(":free")) {
    throw new Error('Only free models (":free") are vetted.');
  }
  const resultsDir = path.join(root, "evals/results");
  const slug = model.replace(/[^a-z0-9]+/gi, "_");
  const file =
    arg("--from") ??
    readdirSync(resultsDir)
      .filter((f) => f.endsWith(`-${slug}.json`))
      .sort()
      .map((f) => path.join(resultsDir, f))
      .at(-1);
  if (!file) throw new Error(`No evaluation results for ${model}`);
  const { results } = JSON.parse(readFileSync(file, "utf8")) as {
    results: EvalResult[];
  };
  const baseline = JSON.parse(
    readFileSync(path.join(root, "evals/baseline.json"), "utf8"),
  ) as Baseline;

  const verdict = vettingVerdict(results, baseline);
  const log = readLog();
  log.tested.push({
    model,
    testedAt: new Date().toISOString(),
    passed: verdict.passed,
    passRate: verdict.passRate,
    reasons: verdict.reasons,
  });
  writeFileSync(logPath!, JSON.stringify(log, null, 2) + "\n");

  console.info(`### Model vetting: ${model}\n`);
  console.info(
    verdict.passed
      ? `Passed (${verdict.passRate}%): propose it as a waiter backup.`
      : `Not good enough (${verdict.passRate}%):\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`,
  );
  process.exit(verdict.passed ? 0 : 2);
}

async function main() {
  if (command === "next") await next();
  else if (command === "record") record();
  else throw new Error('Use "next" or "record"');
}

void main();
