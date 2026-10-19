import "server-only";
import {
  parseOpenRouterModels,
  type OpenRouterModelInfo,
} from "./model-catalogue";

/**
 * OpenRouter's public model list (no key needed): which model names exist
 * and what they cost. The Admin page uses it for price tags and to refuse
 * a misspelt name before it is tested or saved.
 *
 * Kept for a day per server instance, the way docs/admin.md promises
 * ("refreshed daily"). A failed fetch is kept for five minutes and reads
 * as null, which the page shows as "couldn't check" rather than guessing.
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_MS = 24 * 60 * 60 * 1000;
const ERROR_CACHE_MS = 5 * 60 * 1000;

let cache: {
  at: number;
  ttl: number;
  models: Map<string, OpenRouterModelInfo> | null;
} | null = null;

export async function getOpenRouterModels(): Promise<Map<
  string,
  OpenRouterModelInfo
> | null> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.models;
  try {
    const response = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = parseOpenRouterModels(await response.json());
    if (models.size === 0) throw new Error("empty model list");
    cache = { at: Date.now(), ttl: CACHE_MS, models };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "openrouter_models_fetch_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    cache = { at: Date.now(), ttl: ERROR_CACHE_MS, models: null };
  }
  return cache.models;
}
