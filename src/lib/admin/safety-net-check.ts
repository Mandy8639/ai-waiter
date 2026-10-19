import "server-only";
import { clearSafetyNetCache, getSafetyNetState } from "@/lib/ai/safety-net";
import {
  nextCheck,
  safetyNetCandidates,
  type CheckStatus,
} from "@/lib/ai/safety-net-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { runModelTest } from "./model-test";
import { getOpenRouterModels } from "./openrouter-models";

/**
 * The safety net's daily check (docs/admin.md): the Admin page's waiter
 * Test, run on each free tool-calling model OpenRouter lists, with the
 * results written to free_model_checks. Run by Vercel Cron
 * (/api/cron/free-model-check) and by "Check now" on /admin.
 *
 * Free models only, so it costs nothing. A few run at once, to finish
 * inside the time limit without tripping the free tier's per-minute cap.
 */

const AT_ONCE = 6;

export interface SafetyNetCheckSummary {
  checked: number;
  passed: number;
  failed: number;
  busy: number;
  error?: string;
}

type Store = {
  from: (t: "free_model_checks") => {
    upsert: (
      rows: Record<string, unknown>[],
    ) => Promise<{ error: { message: string } | null }>;
  };
};

export async function runSafetyNetCheck(): Promise<SafetyNetCheckSummary> {
  const empty = { checked: 0, passed: 0, failed: 0, busy: 0 };
  if (!process.env.OPENROUTER_API_KEY) {
    return { ...empty, error: "OPENROUTER_API_KEY isn't set." };
  }
  const known = await getOpenRouterModels();
  if (!known) {
    return { ...empty, error: "Couldn't load OpenRouter's model list." };
  }
  const candidates = safetyNetCandidates(known.values());
  const previous = new Map(
    (await getSafetyNetState()).checks.map((c) => [c.model, c]),
  );

  const rows: Record<string, unknown>[] = [];
  const counts = { passed: 0, failed: 0, busy: 0 };
  for (let i = 0; i < candidates.length; i += AT_ONCE) {
    const batch = candidates.slice(i, i + AT_ONCE);
    const results = await Promise.all(
      batch.map((model) => runModelTest("waiter", [model])),
    );
    for (const [j, result] of results.entries()) {
      const model = batch[j];
      const status: CheckStatus = result.passed
        ? "passed"
        : result.busy
          ? "busy"
          : "failed";
      counts[status] += 1;
      const check = nextCheck(
        previous.get(model),
        model,
        { status, ms: result.ms },
        new Date(),
      );
      rows.push({
        model,
        status: check.status,
        last_passed_at: check.lastPassedAt,
        pass_ms: check.passMs,
        checked_at: check.checkedAt,
        result: {
          checks: result.checks,
          reply: result.reply,
          ms: result.ms,
          ...(result.error ? { error: result.error } : {}),
        },
      });
    }
  }

  if (rows.length > 0) {
    const store = createAdminClient() as unknown as Store;
    const { error } = await store.from("free_model_checks").upsert(rows);
    if (error) {
      return {
        checked: rows.length,
        ...counts,
        error: `Couldn't save the results: ${error.message}`,
      };
    }
  }
  clearSafetyNetCache();
  const summary = { checked: rows.length, ...counts };
  console.info(JSON.stringify({ event: "safety_net_checked", ...summary }));
  return summary;
}
