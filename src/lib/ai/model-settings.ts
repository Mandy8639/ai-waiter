import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  aiConfig,
  DEFAULT_SUGGESTION_MODELS,
  DEFAULT_VISION_MODELS,
  defaultWaiterModels,
} from "./config";
import {
  AI_JOBS,
  jobInfo,
  parseEnvList,
  resolveModels,
  type AiJob,
  type ResolvedModels,
} from "./model-settings-core";

/**
 * The models an AI job uses right now: saved on /admin, else its Vercel
 * variable, else the built-in default (model-settings-core.ts).
 *
 * Saved lists are read with the service-role client, because
 * platform_settings has no policy for any signed-in role, and kept for a
 * minute per server instance, so a change made on /admin reaches the next
 * reply within about a minute without a database read per message. A
 * failed read is kept for 15 seconds and treated as "nothing saved": the
 * waiter carries on with its Vercel variable instead of going down.
 */

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

let cache: { at: number; ttl: number; saved: Map<string, string[]> } | null =
  null;

async function savedLists(): Promise<Map<string, string[]>> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.saved;

  // No secret key (local development, unit tests): there is no store to
  // read, so everything comes from Vercel variables and defaults.
  if (!process.env.SUPABASE_SECRET_KEY) {
    cache = { at: Date.now(), ttl: CACHE_MS, saved: new Map() };
    return cache.saved;
  }

  try {
    const admin = createAdminClient() as unknown as {
      from: (t: string) => {
        select: (c: string) => Promise<{
          data: { job: string; models: string[] }[] | null;
          error: unknown;
        }>;
      };
    };
    const { data, error } = await admin
      .from("platform_settings")
      .select("job, models");
    if (error) throw error;
    cache = {
      at: Date.now(),
      ttl: CACHE_MS,
      saved: new Map((data ?? []).map((r) => [r.job, r.models])),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "platform_settings_read_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    cache = { at: Date.now(), ttl: ERROR_CACHE_MS, saved: new Map() };
  }
  return cache.saved;
}

/** Forget the cached lists, so the next read sees a change made just now. */
export function clearModelSettingsCache(): void {
  cache = null;
}

function defaultsFor(job: AiJob): string[] {
  switch (job) {
    case "waiter":
      return defaultWaiterModels();
    case "staff_assistant":
    case "suggestions":
      return DEFAULT_SUGGESTION_MODELS;
    case "vision":
      return DEFAULT_VISION_MODELS;
    case "drafts":
      // The waiter's own list first, as before drafts had a list of their
      // own, then the vetted suggestion models. The free-only filter keeps
      // whichever of those cost nothing, so a paid waiter model no longer
      // switches drafting off.
      return [
        ...parseEnvList(process.env.AI_MODEL),
        ...defaultWaiterModels(),
        ...DEFAULT_SUGGESTION_MODELS,
      ];
  }
}

export async function getModelsFor(job: AiJob): Promise<ResolvedModels> {
  const info = jobInfo(job);
  const saved = await savedLists();
  return resolveModels({
    provider: aiConfig.provider,
    freeOnly: info.freeOnly,
    savedApplies: !(job === "waiter" && aiConfig.provider === "anthropic"),
    saved: saved.get(job),
    env: parseEnvList(process.env[info.envVar]),
    defaults: defaultsFor(job),
  });
}

/** Every job at once, for the Admin page. */
export async function getAllModelSettings(): Promise<
  Array<{ job: AiJob; resolved: ResolvedModels }>
> {
  return Promise.all(
    AI_JOBS.map(async ({ job }) => ({
      job,
      resolved: await getModelsFor(job),
    })),
  );
}
