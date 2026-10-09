import "server-only";
import { freeModelDraft } from "@/lib/ai/free-draft";
import {
  estimatePrompt,
  parseEstimateReply,
  type EstimateDish,
  type Nutrition,
} from "./core";

export type EstimateResult =
  | { ok: true; estimates: Map<string, Nutrition> }
  | { ok: false; reason: "not_free" | "not_configured" | "failed" };

/**
 * Asks the free model for rough nutrition estimates for one batch of
 * dishes (phase M), retrying when the free router doesn't answer or
 * answers with nothing usable (src/lib/ai/free-draft-core.ts). Drafts
 * only: nothing here reaches a diner until a person confirms it.
 */
export async function estimateNutrition(
  dishes: EstimateDish[],
): Promise<EstimateResult> {
  const { system, user } = estimatePrompt(dishes);
  const result = await freeModelDraft({
    system,
    user,
    maxTokens: 3000,
    parse: (reply) => parseEstimateReply(reply, dishes),
    usable: (estimates) => estimates.size > 0,
  });
  return result.ok ? { ok: true, estimates: result.value } : result;
}
