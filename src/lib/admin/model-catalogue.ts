/**
 * The Admin page's model dropdowns (docs/admin.md, Phase 2): the models
 * this app has tested for each job, with what the testing found, plus
 * price tags from OpenRouter's public model list. Pure, so it is
 * unit-tested; src/lib/admin/openrouter-models.ts fetches the list.
 *
 * The notes come from the vetting written up in src/lib/ai/config.ts.
 * When a model is re-vetted, update both. Anything else can still be
 * chosen with "Other…", and must pass the same Test before it is saved.
 */

import type { AiJob } from "@/lib/ai/model-settings-core";

export interface TestedModel {
  model: string;
  note: string;
}

const DOTS = "dots-studio/dots-3-note-preview:free";
const NORTH = "cohere/north-mini-code:free";
const SUPER = "nvidia/nemotron-3-super-120b-a12b:free";
const SUPER_VL = "nvidia/nemotron-3.5-super-vl:free";
const NANO_OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

const SUGGESTER_NOTES: TestedModel[] = [
  { model: DOTS, note: "25 of 25 real dishes described, 2026-10-18" },
  { model: NORTH, note: "25 of 25 real dishes described, 2026-10-18" },
  { model: SUPER, note: "25 of 25 real dishes described, 2026-10-18" },
];

export const TESTED_MODELS: Record<AiJob, TestedModel[]> = {
  waiter: [
    {
      model: DOTS,
      note: "Held a real conversation 2026-09-05: tool calls and prices right",
    },
    {
      model: "cohere/north-mini-code:free",
      note: "Passed the waiter evaluation (92%) on 2026-10-28, nightly watch",
    },
    {
      model: "nvidia/nemotron-3.5-super-vl:free",
      note: "Passed the waiter evaluation (96%) on 2026-11-03, nightly watch",
    },
  ],
  staff_assistant: SUGGESTER_NOTES,
  vision: [
    { model: DOTS, note: "Every price on the test board, 2026-10-18" },
    { model: SUPER_VL, note: "11 of 12 prices, invented none, 2026-10-18" },
    { model: NANO_OMNI, note: "12 of 12 in 2026-09; often busy since" },
  ],
  suggestions: SUGGESTER_NOTES,
  drafts: [
    { model: DOTS, note: "Drafts translations and nutrition today" },
    { model: NORTH, note: "Vetted for short text to strict JSON" },
    { model: SUPER, note: "Vetted for short text to strict JSON" },
  ],
};

/** What OpenRouter's public list says about one model. Prices in US dollars per token. */
export interface OpenRouterModelInfo {
  id: string;
  name: string;
  promptPrice: number;
  completionPrice: number;
  imageInput: boolean;
  tools: boolean;
}

/** OpenRouter's GET /api/v1/models body, as far as this app reads it. Anything malformed is skipped. */
export function parseOpenRouterModels(
  body: unknown,
): Map<string, OpenRouterModelInfo> {
  const out = new Map<string, OpenRouterModelInfo>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const raw of data) {
    const m = raw as {
      id?: unknown;
      name?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
      architecture?: { input_modalities?: unknown };
      supported_parameters?: unknown;
    };
    if (typeof m.id !== "string" || m.id === "") continue;
    const price = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    out.set(m.id, {
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      promptPrice: price(m.pricing?.prompt),
      completionPrice: price(m.pricing?.completion),
      imageInput:
        Array.isArray(m.architecture?.input_modalities) &&
        m.architecture.input_modalities.includes("image"),
      tools:
        Array.isArray(m.supported_parameters) &&
        m.supported_parameters.includes("tools"),
    });
  }
  return out;
}

/** "$0.80 in · $4.00 out per million tokens", or "Free". */
export function priceLabel(info: OpenRouterModelInfo | undefined): string {
  if (!info) return "Not on OpenRouter now";
  if (info.promptPrice === 0 && info.completionPrice === 0) return "Free";
  const perMillion = (p: number) => `$${(p * 1_000_000).toFixed(2)}`;
  return `${perMillion(info.promptPrice)} in · ${perMillion(info.completionPrice)} out per million tokens`;
}

export interface CatalogueOption {
  model: string;
  note: string;
  price: string;
  /** On OpenRouter's list today. A model that isn't can't be saved. */
  available: boolean;
}

/**
 * The dropdown for one job: its tested models, then whatever is saved or
 * in use now that isn't among them (so the current choice always shows).
 * `known` is OpenRouter's list; null when it couldn't be fetched, in which
 * case nothing is marked unavailable, since that isn't known.
 */
export function catalogueFor(
  job: AiJob,
  current: readonly string[],
  known: ReadonlyMap<string, OpenRouterModelInfo> | null,
): CatalogueOption[] {
  const option = (model: string, note: string): CatalogueOption => ({
    model,
    note,
    price: known ? priceLabel(known.get(model)) : "",
    available: known ? known.has(model) : true,
  });
  const tested = TESTED_MODELS[job].map((t) => option(t.model, t.note));
  const extra = current
    .filter((m) => !tested.some((t) => t.model === m))
    .map((m) => option(m, "In use now; not in the tested list"));
  return [...tested, ...extra];
}
