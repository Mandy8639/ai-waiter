/**
 * Pure logic for whether tests/e2e/ai-waiter-flow.spec.ts's real-AI test
 * can run, and why not if it can't — split out from the spec file so it's
 * unit-testable (see tests/unit/ai-e2e-provider-gate.test.ts) without
 * needing a Playwright run. Mirrors src/lib/ai/config.ts's own
 * AI_PROVIDER handling, except an unrecognized provider value is treated
 * as "no real AI provider available" (skip) rather than silently
 * defaulting to anthropic — a typo'd AI_PROVIDER in CI should never
 * masquerade as a legitimately-skipped real-credential test.
 */

export interface AiProviderGateResult {
  hasRealAiProvider: boolean;
  skipReason: string;
}

const AI_CREDENTIAL_ENV_VAR: Record<
  string,
  "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY"
> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function resolveAiProviderGate(env: {
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}): AiProviderGateResult {
  const provider = env.AI_PROVIDER;
  const credentialEnvVar = provider
    ? AI_CREDENTIAL_ENV_VAR[provider]
    : undefined;

  if (!credentialEnvVar) {
    return {
      hasRealAiProvider: false,
      skipReason: `Requires a real Supabase test project AND a configured AI provider — AI_PROVIDER=${JSON.stringify(provider ?? "")} is not "anthropic" or "openrouter".`,
    };
  }

  const credential = env[credentialEnvVar];
  return {
    hasRealAiProvider: !!credential,
    skipReason: `Requires a real Supabase test project AND a real ${credentialEnvVar} (AI_PROVIDER=${provider}).`,
  };
}
