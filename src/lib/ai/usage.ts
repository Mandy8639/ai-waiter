import "server-only";
import { getOpenRouterModels } from "@/lib/admin/openrouter-models";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiJob } from "./model-settings-core";
import { tallyCost, type UsageTally } from "./usage-core";

/**
 * Writes one AI use to ai_usage (docs/admin.md, Phase 4; usage-core.ts
 * adds it up). Never throws and never fails the AI use itself: a lost
 * usage row costs a figure on the Admin page, a thrown error would cost a
 * diner their answer. Skipped when there is no secret key (local
 * development, unit tests) or nothing was called.
 */

type Store = {
  from: (t: "ai_usage") => {
    insert: (
      row: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
};

/** AI jobs with a model list, plus dish images (one model, MENU_IMAGE_MODEL). */
export type UsageJob = AiJob | "images";

export async function recordAiUsage(input: {
  tally: UsageTally;
  job: UsageJob;
  restaurantId?: string | null;
  source?: "app" | "admin_test" | "safety_check";
}): Promise<void> {
  const { tally } = input;
  if (tally.calls === 0 || !process.env.SUPABASE_SECRET_KEY) return;
  try {
    let price = null;
    if (tally.unpricedIn + tally.unpricedOut > 0 && tally.model) {
      price = (await getOpenRouterModels())?.get(tally.model) ?? null;
    }
    const { costUsd, estimated } = tallyCost(tally, price);
    const store = createAdminClient() as unknown as Store;
    const { error } = await store.from("ai_usage").insert({
      restaurant_id: input.restaurantId ?? null,
      job: input.job,
      source: input.source ?? "app",
      model: tally.model,
      calls: tally.calls,
      tokens_in: tally.tokensIn,
      tokens_out: tally.tokensOut,
      cost_usd: costUsd,
      cost_estimated: estimated,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ai_usage_record_failed",
        job: input.job,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
