import type { ResolvedModels } from "./model-settings-core";

/**
 * Admin Phase 7: which models a restaurant's waiter uses. A list set for
 * that restaurant wins, then one set for its plan, then the platform list
 * (saved on /admin, else AI_MODEL, else the built-in default). No
 * `server-only`: unit-tested directly.
 */

export type WaiterModelSource =
  "restaurant" | "plan" | ResolvedModels["source"];

export interface ResolvedWaiterModels {
  models: string[];
  source: WaiterModelSource;
}

export function resolveWaiterModels(input: {
  restaurant: readonly string[] | undefined;
  plan: readonly string[] | undefined;
  platform: ResolvedModels;
  /** Saved lists only apply on OpenRouter (Anthropic's model comes from Vercel). */
  overridesApply: boolean;
}): ResolvedWaiterModels {
  if (input.overridesApply) {
    if (input.restaurant?.length) {
      return { models: [...input.restaurant], source: "restaurant" };
    }
    if (input.plan?.length) {
      return { models: [...input.plan], source: "plan" };
    }
  }
  return { models: input.platform.models, source: input.platform.source };
}

export function waiterSourceLabel(source: WaiterModelSource): string {
  switch (source) {
    case "restaurant":
      return "Set for this restaurant";
    case "plan":
      return "Its plan's default";
    default:
      return "Same as everyone";
  }
}
