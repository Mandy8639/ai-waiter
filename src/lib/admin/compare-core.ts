import { listProblem, formatSeconds } from "./model-test-core";

/**
 * The Admin page's side-by-side test (docs/admin.md, Phase 5): one diner
 * question to two waiter models, each alone (no backups, so the answer is
 * that model's own), on the sample menu, with their answers, speed and
 * cost next to each other. Nothing is saved or changed; it helps choose
 * a model before Change → Test → Save.
 */

export const MAX_COMPARE_QUESTION = 300;

/** Quick picks: the Test's two questions, then ones diners really ask. */
export const COMPARE_QUESTIONS = [
  "What's vegetarian and not too spicy?",
  "What do you recommend?",
  "Does the Chicken Chettinad have nuts?",
  "I'm really hungry, what should I get for two?",
] as const;

export interface CompareAnswer {
  model: string;
  /** What OpenRouter says answered, which can differ for an alias. */
  servedModel?: string;
  reply: string;
  /** Tools the model called, in order, each once. */
  tools: string[];
  /** It declined, or the guards gave up on it. */
  declined: boolean;
  ms: number;
  costUsd: number | null;
  error?: string;
  busy?: boolean;
}

/** Why these two can't be compared, or null. */
export function compareProblem(input: {
  models: readonly string[];
  question: string;
  provider: string;
  known: ReadonlySet<string> | null;
}): string | null {
  const question = input.question.trim();
  if (question === "") return "Type a question a diner might ask.";
  if (question.length > MAX_COMPARE_QUESTION) {
    return `Keep the question under ${MAX_COMPARE_QUESTION} characters.`;
  }
  const models = input.models.map((m) => m.trim());
  if (models.length !== 2 || models.some((m) => m === "")) {
    return "Choose two models.";
  }
  if (models[0] === models[1]) return "Choose two different models.";
  for (const model of models) {
    const problem = listProblem({
      job: "waiter",
      models: [model],
      provider: input.provider,
      known: input.known,
    });
    if (problem) return problem;
  }
  return null;
}

const MENU_TOOLS = new Set(["search_menu", "get_menu_item"]);

/**
 * A few plain observations under the two answers: who was faster, who
 * was cheaper, and whether only one looked the menu up. The judgment of
 * which answer is better is left to the reader.
 */
export function compareNotes(a: CompareAnswer, b: CompareAnswer): string[] {
  const notes: string[] = [];
  const name = (x: CompareAnswer) => x.model;
  const ok = (x: CompareAnswer) => !x.error;

  if (ok(a) && !ok(b)) notes.push(`Only ${name(a)} answered.`);
  if (ok(b) && !ok(a)) notes.push(`Only ${name(b)} answered.`);
  if (!ok(a) || !ok(b)) return notes;

  const gap = Math.abs(a.ms - b.ms);
  if (gap >= 500) {
    const [fast, slow] = a.ms < b.ms ? [a, b] : [b, a];
    notes.push(
      `${name(fast)} was ${formatSeconds(gap)} faster (${formatSeconds(fast.ms)} against ${formatSeconds(slow.ms)}).`,
    );
  }

  if (a.costUsd !== null && b.costUsd !== null && a.costUsd !== b.costUsd) {
    const cheaper = a.costUsd < b.costUsd ? a : b;
    notes.push(`${name(cheaper)} cost less.`);
  }

  const looked = (x: CompareAnswer) => x.tools.some((t) => MENU_TOOLS.has(t));
  if (looked(a) !== looked(b)) {
    const skipped = looked(a) ? b : a;
    notes.push(
      `${name(skipped)} answered without looking at the menu, so it may have guessed.`,
    );
  }

  for (const x of [a, b]) {
    if (x.declined) notes.push(`${name(x)} declined to answer.`);
  }
  return notes;
}
