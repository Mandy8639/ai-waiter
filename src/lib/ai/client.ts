import "server-only";

/**
 * Batch 9: the real client construction (both Anthropic and OpenRouter)
 * moved into src/lib/ai/providers/ alongside the provider abstraction.
 * This file now only re-exports `isAiConfigured` so
 * src/lib/ai/actions.ts's existing `import { isAiConfigured } from
 * "./client"` keeps working unchanged — see docs/ai.md#provider-and-configuration.
 */
export { isAiConfigured } from "./providers";
