/**
 * Pure env-var parsing helpers, deliberately kept free of `import
 * "server-only"` so they're unit-testable directly — `server-only` throws
 * unconditionally outside of Next.js's RSC bundling (it relies on
 * webpack/Turbopack's `react-server` export condition to resolve to a
 * no-op instead), which Vitest doesn't set, so no test file in this
 * project imports a `server-only`-guarded module directly — see
 * tests/integration/db/*.test.ts, which for the same reason exercise the
 * SQL/RLS layer directly rather than importing src/lib/* application code.
 *
 * Shared by every feature that reads a tunable from the environment with a
 * fallback (src/lib/ai/config.ts, src/lib/customer/rate-limit.ts,
 * src/lib/orders/rate-limit.ts) — not AI-specific despite originating
 * there in Batch 7.
 */

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
