/**
 * Which models each AI job uses, and where that choice came from.
 *
 * Three sources, first one that gives a usable list wins:
 *   1. saved   — set on /admin (platform_settings), read by model-settings.ts
 *   2. env     — the job's Vercel variable, as before the Admin page
 *   3. default — the vetted list in src/lib/ai/config.ts
 *
 * A free-only job (menu suggestions, AI drafts) drops any paid model from
 * each source before deciding, so a paid model can never be the reason
 * the app spends money on drafting. No `server-only` and no I/O, so this
 * is unit-tested directly.
 */

import { isFreeModel } from "@/lib/translations/core";

export type AiJob =
  "waiter" | "staff_assistant" | "vision" | "suggestions" | "drafts";

export interface AiJobInfo {
  job: AiJob;
  label: string;
  description: string;
  /** The Vercel variable that sets it when nothing is saved on /admin. */
  envVar: string;
  /** Only free (":free") OpenRouter models are ever used for this job. */
  freeOnly: boolean;
}

export const AI_JOBS: readonly AiJobInfo[] = [
  {
    job: "waiter",
    label: "Diner's AI waiter",
    description: "Talks to diners about the menu and places their orders.",
    envVar: "AI_MODEL",
    freeOnly: false,
  },
  {
    job: "staff_assistant",
    label: "Staff assistant (“Waiter” button)",
    description: "Understands staff commands like “86 the salmon”.",
    envVar: "STAFF_ASSISTANT_MODEL",
    freeOnly: false,
  },
  {
    job: "vision",
    label: "Menu photo reader",
    description: "Reads menu photos into dishes and prices.",
    envVar: "MENU_IMPORT_VISION_MODEL",
    freeOnly: false,
  },
  {
    job: "suggestions",
    label: "Menu suggestions",
    description: "Drafts ingredients, allergens and spice levels for review.",
    envVar: "MENU_SUGGESTION_MODEL",
    freeOnly: true,
  },
  {
    job: "drafts",
    label: "AI drafts",
    description: "Nutrition estimates and menu translations, for review.",
    envVar: "AI_DRAFT_MODEL",
    freeOnly: true,
  },
];

export function jobInfo(job: AiJob): AiJobInfo {
  return AI_JOBS.find((j) => j.job === job)!;
}

export type ModelSource = "saved" | "env" | "default";

export interface ResolvedModels {
  models: string[];
  source: ModelSource;
}

/** "a, b ,,a" → ["a", "b"]: trimmed, blanks and repeats dropped, order kept. */
export function cleanModelList(list: readonly string[] | null | undefined) {
  return [
    ...new Set((list ?? []).map((m) => m.trim()).filter((m) => m !== "")),
  ];
}

export function parseEnvList(value: string | undefined): string[] {
  return cleanModelList((value ?? "").split(","));
}

export function resolveModels(input: {
  provider: string;
  freeOnly: boolean;
  /**
   * Whether a saved list may be used at all. The waiter on the Anthropic
   * provider takes one Anthropic model name, never an OpenRouter list, so
   * a saved list is ignored there rather than sent somewhere it can't work.
   */
  savedApplies: boolean;
  saved: readonly string[] | null | undefined;
  env: readonly string[];
  defaults: readonly string[];
}): ResolvedModels {
  const usable = (list: readonly string[] | null | undefined) => {
    const cleaned = cleanModelList(list);
    return input.freeOnly
      ? cleaned.filter((m) => isFreeModel(input.provider, m))
      : cleaned;
  };

  const saved = input.savedApplies ? usable(input.saved) : [];
  if (saved.length > 0) return { models: saved, source: "saved" };

  const env = usable(input.env);
  if (env.length > 0) return { models: env, source: "env" };

  return { models: usable(input.defaults), source: "default" };
}

/** Whether a model name will cost money (OpenRouter's ":free" suffix marks the ones that don't). */
export function isPaidModel(provider: string, model: string): boolean {
  return !isFreeModel(provider, model);
}
