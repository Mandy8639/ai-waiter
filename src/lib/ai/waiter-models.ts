import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiConfig } from "./config";
import { getModelsFor } from "./model-settings";
import {
  resolveWaiterModels,
  type ResolvedWaiterModels,
} from "./waiter-models-core";

/**
 * The waiter models for one restaurant (waiter-models-core.ts has the
 * order). Overrides and plan assignments are read with the service role
 * and kept for a minute, like the platform lists in model-settings.ts, so
 * a change on /admin reaches diners within about a minute and a waiter
 * reply adds no database read. Any failed read falls back to the platform
 * list: a broken override must never leave a restaurant with no waiter.
 */

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

interface Overrides {
  byRestaurant: Map<string, string[]>;
  byPlan: Map<string, string[]>;
  defaultPlanId: string | null;
}

const EMPTY: Overrides = {
  byRestaurant: new Map(),
  byPlan: new Map(),
  defaultPlanId: null,
};

type Rows = Promise<{ data: unknown[] | null; error: unknown }>;
type Store = {
  from: (t: string) => {
    select: (c: string) => Rows & {
      eq: (c: string, v: string | boolean) => Rows;
    };
  };
};

let overridesCache: { at: number; ttl: number; value: Overrides } | null = null;
const planCache = new Map<string, { at: number; planId: string | null }>();

export function clearWaiterModelCache(): void {
  overridesCache = null;
  planCache.clear();
}

async function overrides(): Promise<Overrides> {
  if (overridesCache && Date.now() - overridesCache.at < overridesCache.ttl) {
    return overridesCache.value;
  }
  if (!process.env.SUPABASE_SECRET_KEY) return EMPTY;
  try {
    const store = createAdminClient() as unknown as Store;
    const [rows, plans] = await Promise.all([
      store
        .from("waiter_model_overrides")
        .select("restaurant_id, plan_id, models"),
      store.from("platform_plans").select("id").eq("is_default", true),
    ]);
    if (rows.error) throw rows.error;
    const value: Overrides = {
      byRestaurant: new Map(),
      byPlan: new Map(),
      defaultPlanId:
        ((plans.data ?? [])[0] as { id: string } | undefined)?.id ?? null,
    };
    for (const r of rows.data as Array<{
      restaurant_id: string | null;
      plan_id: string | null;
      models: string[];
    }>) {
      if (r.restaurant_id) value.byRestaurant.set(r.restaurant_id, r.models);
      else if (r.plan_id) value.byPlan.set(r.plan_id, r.models);
    }
    overridesCache = { at: Date.now(), ttl: CACHE_MS, value };
    return value;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "waiter_overrides_read_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    overridesCache = { at: Date.now(), ttl: ERROR_CACHE_MS, value: EMPTY };
    return EMPTY;
  }
}

/** The restaurant's plan: its own row in restaurant_plans, else the default plan. */
async function planOf(
  restaurantId: string,
  defaultPlanId: string | null,
): Promise<string | null> {
  const hit = planCache.get(restaurantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.planId ?? defaultPlanId;
  try {
    const store = createAdminClient() as unknown as Store;
    const { data, error } = await store
      .from("restaurant_plans")
      .select("plan_id")
      .eq("restaurant_id", restaurantId);
    if (error) throw error;
    const planId =
      ((data ?? [])[0] as { plan_id: string } | undefined)?.plan_id ?? null;
    planCache.set(restaurantId, { at: Date.now(), planId });
    return planId ?? defaultPlanId;
  } catch {
    return defaultPlanId;
  }
}

export async function getWaiterModels(
  restaurantId?: string,
): Promise<ResolvedWaiterModels> {
  const platform = await getModelsFor("waiter");
  const overridesApply = aiConfig.provider === "openrouter";
  if (!restaurantId || !overridesApply) {
    return resolveWaiterModels({
      restaurant: undefined,
      plan: undefined,
      platform,
      overridesApply,
    });
  }
  const o = await overrides();
  const restaurant = o.byRestaurant.get(restaurantId);
  const plan = restaurant
    ? undefined
    : o.byPlan.size > 0
      ? o.byPlan.get((await planOf(restaurantId, o.defaultPlanId)) ?? "")
      : undefined;
  return resolveWaiterModels({ restaurant, plan, platform, overridesApply });
}
