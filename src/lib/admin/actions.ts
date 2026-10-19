"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { aiConfig } from "@/lib/ai/config";
import { clearModelSettingsCache } from "@/lib/ai/model-settings";
import { AI_JOBS, type AiJob } from "@/lib/ai/model-settings-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import { listProblem, type ModelTestResult } from "./model-test-core";
import { runModelTest } from "./model-test";
import { getOpenRouterModels } from "./openrouter-models";

/**
 * The Admin page's editor (docs/admin.md, Phase 2): Test a model list for
 * one job, then Save it. Save works only after a passing Test of exactly
 * that list, by the same person, in the last 15 minutes; the database
 * function save_platform_models() checks that again.
 */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

const inputSchema = z.object({
  job: z.enum(AI_JOBS.map((j) => j.job) as [AiJob, ...AiJob[]]),
  models: z.array(z.string().max(200)).max(3),
});

function clean(models: string[]): string[] {
  return models.map((m) => m.trim()).filter((m) => m !== "");
}

async function problemWith(job: AiJob, models: string[]) {
  const known = await getOpenRouterModels();
  return listProblem({
    job,
    models,
    provider: aiConfig.provider,
    known: known ? new Set(known.keys()) : null,
  });
}

/**
 * The store is server-only and newer than database.types.ts, so it is
 * reached through this narrow shape rather than the generated types.
 */
type AdminStore = {
  from: (t: "platform_model_tests") => {
    insert: (row: Record<string, unknown>) => {
      select: (c: "id") => {
        single: () => Promise<{ data: { id: string } | null; error: unknown }>;
      };
    };
  };
  rpc: (
    fn: "save_platform_models",
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
};

export type TestModelsResult =
  | { error: string }
  | { result: ModelTestResult; testId?: string; error?: string };

export async function testModelList(
  job: AiJob,
  models: string[],
): Promise<TestModelsResult> {
  const parsed = inputSchema.safeParse({ job, models });
  if (!parsed.success) return { error: "That list isn't valid." };
  const user = await platformAdminForAction();
  if (!user) return { error: NOT_ALLOWED };

  const list = clean(parsed.data.models);
  const problem = await problemWith(parsed.data.job, list);
  if (problem) return { error: problem };

  const result = await runModelTest(parsed.data.job, list);
  console.info(
    JSON.stringify({
      event: "admin_model_test",
      job: result.job,
      models: result.models,
      passed: result.passed,
      ms: result.ms,
      costUsd: result.costUsd,
    }),
  );

  const store = createAdminClient() as unknown as AdminStore;
  const { data, error } = await store
    .from("platform_model_tests")
    .insert({
      job: result.job,
      models: result.models,
      passed: result.passed,
      result,
      tested_by: user.id,
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
    "Run Test on exactly this list, and save once it passes.",
  MODEL_TEST_STALE: "The test is more than 15 minutes old. Run it again.",
  MODEL_NOT_FREE: "This job only uses free models.",
};

export async function saveModelList(
  job: AiJob,
  models: string[],
  testId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = inputSchema.safeParse({ job, models });
  if (!parsed.success || !z.uuid().safeParse(testId).success) {
    return { ok: false, error: "That list isn't valid." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const list = clean(parsed.data.models);
  const problem = await problemWith(parsed.data.job, list);
  if (problem) return { ok: false, error: problem };

  const store = createAdminClient() as unknown as AdminStore;
  const { error } = await store.rpc("save_platform_models", {
    p_job: parsed.data.job,
    p_models: list,
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
          event: "admin_model_save_failed",
          job: parsed.data.job,
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
      event: "admin_model_saved",
      job: parsed.data.job,
      models: list,
    }),
  );
  // This server instance uses the new list at once; the others within a
  // minute, when their cache runs out (src/lib/ai/model-settings.ts).
  clearModelSettingsCache();
  revalidatePath("/admin");
  return { ok: true };
}
