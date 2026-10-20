"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { aiConfig } from "@/lib/ai/config";
import { clearModelSettingsCache } from "@/lib/ai/model-settings";
import { AI_JOBS, jobInfo, type AiJob } from "@/lib/ai/model-settings-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import { getHistoryEntry, getSavedLists } from "./history";
import { undoPlan } from "./history-core";
import { listProblem, type ModelTestResult } from "./model-test-core";
import { compareWaiterAnswer, runModelTest } from "./model-test";
import { compareProblem, type CompareAnswer } from "./compare-core";
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
    fn: "save_platform_models" | "clear_platform_models",
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
};

/** Keeps a Test run, so Save (or Undo) can prove it passed. Null when it couldn't be recorded. */
async function recordTest(
  result: ModelTestResult,
  userId: string,
): Promise<string | null> {
  const store = createAdminClient() as unknown as AdminStore;
  const { data, error } = await store
    .from("platform_model_tests")
    .insert({
      job: result.job,
      models: result.models,
      passed: result.passed,
      result,
      tested_by: userId,
    })
    .select("id")
    .single();
  return error || !data ? null : data.id;
}

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

  const testId = await recordTest(result, user.id);
  if (!testId) {
    return {
      result,
      error:
        "The test ran but couldn't be recorded, so it can't be saved. Run it again.",
    };
  }
  return { result, ...(result.passed ? { testId } : {}) };
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
  if (error) return { ok: false, error: saveError(parsed.data.job, error) };

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

function saveError(job: AiJob, error: { message: string }): string {
  const code = Object.keys(SAVE_ERRORS).find((c) => error.message.includes(c));
  if (!code) {
    console.error(
      JSON.stringify({
        event: "admin_model_save_failed",
        job,
        error: error.message,
      }),
    );
  }
  return code ? SAVE_ERRORS[code] : "Couldn't save. Please try again.";
}

export type UndoResult =
  | { ok: true; message: string }
  | { ok: false; error: string; result?: ModelTestResult };

/**
 * Undo one change from the history (docs/admin.md, Phase 3): put the
 * list it replaced back. An earlier list is tested again first, exactly
 * as Save would, and only saved if it passes today; going back to
 * "nothing saved" needs no Test. Recorded as a change of its own.
 */
export async function undoChange(historyId: string): Promise<UndoResult> {
  if (!z.uuid().safeParse(historyId).success) {
    return { ok: false, error: "That change isn't valid." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const entry = await getHistoryEntry(historyId);
  if (!entry) return { ok: false, error: "That change wasn't found." };
  const saved = await getSavedLists();
  const plan = undoPlan(
    entry,
    entry.job === "all" ? null : (saved.get(entry.job) ?? null),
  );
  if (!plan) {
    return { ok: false, error: "There's nothing to undo: it's already back." };
  }

  const store = createAdminClient() as unknown as AdminStore;
  let message: string;
  if (plan.kind === "clear") {
    const { error } = await store.rpc("clear_platform_models", {
      p_job: plan.job,
      p_user: user.id,
    });
    if (error) return { ok: false, error: saveError(plan.job, error) };
    message = `${jobInfo(plan.job).label} is back on its Vercel variable or built-in default.`;
  } else {
    const problem = await problemWith(plan.job, plan.models);
    if (problem) return { ok: false, error: problem };
    const result = await runModelTest(plan.job, plan.models);
    const testId = await recordTest(result, user.id);
    if (!result.passed) {
      return {
        ok: false,
        error:
          "The earlier list failed its Test today, so it wasn't put back. Nothing changed.",
        result,
      };
    }
    if (!testId) {
      return { ok: false, error: "The test couldn't be recorded. Try again." };
    }
    const { error } = await store.rpc("save_platform_models", {
      p_job: plan.job,
      p_models: plan.models,
      p_test_id: testId,
      p_user: user.id,
      p_action: "undo",
    });
    if (error) return { ok: false, error: saveError(plan.job, error) };
    message = `${jobInfo(plan.job).label} is back on ${plan.models[0]}.`;
  }

  console.info(
    JSON.stringify({ event: "admin_model_undone", historyId, job: plan.job }),
  );
  clearModelSettingsCache();
  revalidatePath("/admin");
  return { ok: true, message };
}

/**
 * The Emergency reset: clear every saved list, so every job is back on
 * its Vercel variable or built-in default. No Test: those are what the
 * app ran on before anything was saved here. Recorded in the history.
 */
export async function resetAllModels(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const store = createAdminClient() as unknown as AdminStore;
  const { error } = await store.rpc("clear_platform_models", {
    p_job: null,
    p_user: user.id,
  });
  if (error) {
    console.error(
      JSON.stringify({ event: "admin_reset_failed", error: error.message }),
    );
    return { ok: false, error: "Couldn't reset. Please try again." };
  }
  console.warn(JSON.stringify({ event: "admin_models_reset", by: user.id }));
  clearModelSettingsCache();
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * The side-by-side test (docs/admin.md, Phase 5): the same diner question
 * to two waiter models at once. Changes nothing; a paid model spends a
 * little credit, as a Test does.
 */
export async function compareModels(
  models: string[],
  question: string,
): Promise<{ error: string } | { answers: [CompareAnswer, CompareAnswer] }> {
  const parsed = z
    .object({
      models: z.array(z.string().max(200)).length(2),
      question: z.string().max(1000),
    })
    .safeParse({ models, question });
  if (!parsed.success) return { error: "Choose two models and a question." };
  const user = await platformAdminForAction();
  if (!user) return { error: NOT_ALLOWED };

  const known = await getOpenRouterModels();
  const problem = compareProblem({
    models: parsed.data.models,
    question: parsed.data.question,
    provider: aiConfig.provider,
    known: known ? new Set(known.keys()) : null,
  });
  if (problem) return { error: problem };

  const [a, b] = parsed.data.models.map((m) => m.trim());
  const q = parsed.data.question.trim();
  const answers = await Promise.all([
    compareWaiterAnswer(a, q),
    compareWaiterAnswer(b, q),
  ]);
  console.info(
    JSON.stringify({
      event: "admin_model_compare",
      models: [a, b],
      ms: answers.map((x) => x.ms),
      costUsd: answers.map((x) => x.costUsd),
    }),
  );
  return { answers: [answers[0], answers[1]] };
}
