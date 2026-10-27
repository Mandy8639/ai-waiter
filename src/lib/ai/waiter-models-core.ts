import type { ResolvedModels } from "./model-settings-core";
import { NEVER_USE } from "./safety-net-core";

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
    const restaurant = usable(input.restaurant);
    if (restaurant.length) return { models: restaurant, source: "restaurant" };
    const plan = usable(input.plan);
    if (plan.length) return { models: plan, source: "plan" };
  }
  const platform = usable(input.platform.models);
  return {
    // Only if every saved model is one that went wrong: some waiter beats
    // no waiter, and /admin shows the list to fix.
    models: platform.length ? platform : [...input.platform.models],
    source: input.platform.source,
  };
}

/**
 * A list without the models that went wrong in real conversations here
 * (safety-net-core.ts NEVER_USE: one made up a recommendation, others
 * skipped the menu lookups). A saved list may predate that finding; the
 * busy-Saturday run still had one answering diners.
 */
function usable(models: readonly string[] | undefined): string[] {
  return (models ?? []).filter((m) => !(m in NEVER_USE.waiter));
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
