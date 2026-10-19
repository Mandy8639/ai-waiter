import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  rankSafetyNet,
  type CheckStatus,
  type FreeModelCheck,
} from "./safety-net-core";

/**
 * The waiter's free safety net, read from the store (safety-net-core.ts
 * has the rules). Read with the service-role client, like
 * model-settings.ts, and kept for a minute per server instance: the net
 * is only needed when the waiter's own list is busy, and then it must not
 * add a slow database read. A failed read means "no safety net" for 15
 * seconds; the waiter then fails exactly as it would have without one.
 */

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

export interface SafetyNetState {
  enabled: boolean;
  checks: FreeModelCheck[];
}

interface CheckRow {
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
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { enabled: false, checks: [] };
  }
  try {
    const store = createAdminClient() as unknown as Store;
    const [switches, checks] = await Promise.all([
      store.from("platform_switches").select("name, enabled"),
      store
        .from("free_model_checks")
        .select("model, status, last_passed_at, pass_ms, checked_at"),
    ]);
    if (switches.error) throw switches.error;
    if (checks.error) throw checks.error;
    const row = (switches.data as { name: string; enabled: boolean }[]).find(
      (s) => s.name === "waiter_safety_net",
    );
    const state: SafetyNetState = {
      // No row means on: the switch exists to turn it off.
      enabled: row?.enabled ?? true,
      checks: (checks.data as CheckRow[]).map((r) => ({
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
    cache = {
      at: Date.now(),
      ttl: ERROR_CACHE_MS,
      state: { enabled: false, checks: [] },
    };
  }
  return cache.state;
}

/** The models the waiter falls back to, fastest first; empty when switched off. */
export async function getSafetyNetModels(): Promise<string[]> {
  const state = await getSafetyNetState();
  return state.enabled ? rankSafetyNet(state.checks, new Date()) : [];
}
