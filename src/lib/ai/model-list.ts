/**
 * OpenRouter refuses a `models` preference list longer than three: the
 * whole request fails with 400 "'models' array must have 3 items or
 * fewer" (found 2026-10-18, when the suggester's four-model list had been
 * failing every call). Every call that sends a list goes through this, so
 * a longer list in config or an env override degrades to its first three
 * instead of breaking the feature. No `server-only`: unit-tested.
 */
export const OPENROUTER_MAX_MODELS = 3;

export function openRouterModels(list: readonly string[]): string[] {
  return [...new Set(list.filter(Boolean))].slice(0, OPENROUTER_MAX_MODELS);
}
