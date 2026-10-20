"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { aiConfig } from "@/lib/ai/config";
import { clearWaiterModelCache } from "@/lib/ai/waiter-models";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import { listProblem, type ModelTestResult } from "./model-test-core";
import { runModelTest, runWaiterTestOnMenu } from "./model-test";
import { getOpenRouterModels } from "./openrouter-models";
import { loadTestMenu } from "./waiter-override-queries";

/**
 * Admin Phase 7 (docs/admin.md): a waiter model list for one restaurant or
 * one plan. Test → Save, as for the platform lists: a restaurant's list is
 * tested on that restaurant's own menu, a plan's on the sample menu, and
 * save_waiter_model_override() checks the Test again in the database.
 */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

const targetSchema = z.union([
  z.object({ restaurantId: z.uuid(), planId: z.undefined().optional() }),
  z.object({ planId: z.uuid(), restaurantId: z.undefined().optional() }),
]);
export type OverrideTarget = { restaurantId: string } | { planId: string };

const modelsSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(3);

type Store = {
  from: (t: "platform_model_tests") => {
    insert: (row: Record<string, unknown>) => {
      select: (c: "id") => {
        single: () => Promise<{ data: { id: string } | null; error: unknown }>;
      };
    };
  };
  rpc: (
    fn: "save_waiter_model_override",
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
};

function ids(target: OverrideTarget) {
  return {
    restaurantId: "restaurantId" in target ? target.restaurantId : null,
    planId: "planId" in target ? target.planId : null,
  };
}

export type OverrideTestResult =
  | { error: string }
  | { result: ModelTestResult; testId?: string; error?: string };

export async function testWaiterOverride(
  target: OverrideTarget,
  models: string[],
): Promise<OverrideTestResult> {
  const t = targetSchema.safeParse(target);
  const list = modelsSchema.safeParse(models);
  if (!t.success || !list.success) return { error: "That list isn't valid." };
  const user = await platformAdminForAction();
  if (!user) return { error: NOT_ALLOWED };

  const known = await getOpenRouterModels();
  const problem = listProblem({
    job: "waiter",
    models: list.data,
    provider: aiConfig.provider,
    known: known ? new Set(known.keys()) : null,
  });
  if (problem) return { error: problem };

  const { restaurantId } = ids(t.data as OverrideTarget);
  let result: ModelTestResult;
  if (restaurantId) {
    const menu = await loadTestMenu(restaurantId);
    if (!menu) {
      return {
        error:
          "This restaurant has no dishes on its menu yet, so there's nothing to test the waiter on.",
      };
    }
    result = await runWaiterTestOnMenu(list.data, menu, restaurantId);
  } else {
    result = await runModelTest("waiter", list.data);
  }

  const store = createAdminClient() as unknown as Store;
  const { data, error } = await store
    .from("platform_model_tests")
    .insert({
      job: "waiter",
      models: result.models,
      passed: result.passed,
      result,
      tested_by: user.id,
      restaurant_id: restaurantId,
    })
    .select("id")
    .single();
  if (error || !data) {
    return {
      result,
      error:
        "The test ran but couldn't be recorded, so it can't be saved. Run it again.",
    };
  }
  return { result, ...(result.passed ? { testId: data.id } : {}) };
}

const SAVE_ERRORS: Record<string, string> = {
  MODEL_TEST_REQUIRED:
    "Run Test on exactly this list, for this restaurant or plan, and save once it passes.",
  MODEL_TEST_STALE: "The test is more than 15 minutes old. Run it again.",
};

async function write(
  target: OverrideTarget,
  models: string[] | null,
  testId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = targetSchema.safeParse(target);
  if (!t.success) return { ok: false, error: "That isn't a valid target." };
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const { restaurantId, planId } = ids(t.data as OverrideTarget);

  const store = createAdminClient() as unknown as Store;
  const { error } = await store.rpc("save_waiter_model_override", {
    p_restaurant_id: restaurantId,
    p_plan_id: planId,
    p_models: models,
    p_test_id: testId,
    p_user: user.id,
  });
  if (error) {
    const code = Object.keys(SAVE_ERRORS).find((c) =>
      error.message.includes(c),
    );
    if (!code) {
      console.error(
        JSON.stringify({
          event: "waiter_override_save_failed",
          error: error.message,
        }),
      );
    }
    return {
      ok: false,
      error: code ? SAVE_ERRORS[code] : "Couldn't save. Please try again.",
    };
  }
  console.info(
    JSON.stringify({
      event: models ? "waiter_override_saved" : "waiter_override_cleared",
      restaurantId,
      planId,
      models,
    }),
  );
  // This instance at once; the others within a minute (waiter-models.ts).
  clearWaiterModelCache();
  revalidatePath("/admin");
  return { ok: true };
}

export async function saveWaiterOverride(
  target: OverrideTarget,
  models: string[],
  testId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const list = modelsSchema.safeParse(models);
  if (!list.success || !z.uuid().safeParse(testId).success) {
    return { ok: false, error: "That list isn't valid." };
  }
  return write(target, list.data, testId);
}

/** Back to the next level: the plan's list, or the platform's. */
export async function clearWaiterOverride(
  target: OverrideTarget,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return write(target, null, null);
}
