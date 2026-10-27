import "server-only";
import { TESTED_MODELS } from "@/lib/admin/model-catalogue";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  rankSafetyNet,
  VETTED_ONLY_JOBS,
  SAFETY_NET_JOBS,
  switchName,
  type CheckStatus,
  type FreeModelCheck,
  type SafetyNetJob,
} from "./safety-net-core";

/**
 * The free safety net for each live job, read from the store (safety-net-core.ts
 * has the rules). Read with the service-role client, like
 * model-settings.ts, and kept for a minute per server instance: the net
 * is only needed when a job's own list is busy, and then it must not add
 * a slow database read. A failed read means "no safety net" for 15
 * seconds; the job then fails exactly as it would have without one.
 */

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

export interface SafetyNetState {
  enabled: Record<SafetyNetJob, boolean>;
  checks: FreeModelCheck[];
}

const OFF: SafetyNetState = {
  enabled: { waiter: false, staff_assistant: false },
  checks: [],
};

interface CheckRow {
  job: SafetyNetJob;
  model: string;
  status: CheckStatus;
  last_passed_at: string | null;
  pass_ms: number | null;
  checked_at: string;
}

/** The store is newer than database.types.ts, so it is reached through this narrow shape. */
type Store = {
  from: (t: "free_model_checks" | "platform_switches") => {
    select: (c: string) => Promise<{ data: unknown[] | null; error: unknown }>;
  };
};

let cache: { at: number; ttl: number; state: SafetyNetState } | null = null;

export function clearSafetyNetCache(): void {
  cache = null;
}

export async function getSafetyNetState(): Promise<SafetyNetState> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.state;
  if (!process.env.SUPABASE_SECRET_KEY) return OFF;
  try {
    const store = createAdminClient() as unknown as Store;
    const [switches, checks] = await Promise.all([
      store.from("platform_switches").select("name, enabled"),
      store
        .from("free_model_checks")
        .select("job, model, status, last_passed_at, pass_ms, checked_at"),
    ]);
    if (switches.error) throw switches.error;
    if (checks.error) throw checks.error;
    const rows = switches.data as { name: string; enabled: boolean }[];
    const state: SafetyNetState = {
      // No row means on: the switch exists to turn it off.
      enabled: Object.fromEntries(
        SAFETY_NET_JOBS.map((job) => [
          job,
          rows.find((s) => s.name === switchName(job))?.enabled ?? true,
        ]),
      ) as Record<SafetyNetJob, boolean>,
      checks: (checks.data as CheckRow[]).map((r) => ({
        job: r.job,
        model: r.model,
        status: r.status,
        lastPassedAt: r.last_passed_at,
        passMs: r.pass_ms,
        checkedAt: r.checked_at,
      })),
    };
    cache = { at: Date.now(), ttl: CACHE_MS, state };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "safety_net_read_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    cache = { at: Date.now(), ttl: ERROR_CACHE_MS, state: OFF };
  }
  return cache.state;
}

/** The models vetted for a job (the Admin page's catalogue), which its net tries first. */
export function preferredFor(job: SafetyNetJob): string[] {
  return TESTED_MODELS[job].map((t) => t.model);
}

/** One job's checks. */
export function checksFor(
  state: SafetyNetState,
  job: SafetyNetJob,
): FreeModelCheck[] {
  return state.checks.filter((c) => c.job === job);
}

/** The models a job falls back to, vetted ones first (only vetted ones, for the waiter); empty when switched off. */
export async function getSafetyNetModels(job: SafetyNetJob): Promise<string[]> {
  const state = await getSafetyNetState();
  return state.enabled[job]
    ? rankSafetyNet(
        checksFor(state, job),
        new Date(),
        preferredFor(job),
        VETTED_ONLY_JOBS.has(job),
      )
    : [];
}
