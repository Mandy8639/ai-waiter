import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isAiConfigured } from "@/lib/ai/client";
import { apnsReady } from "@/lib/push/apns-core";
import { squareReady, squareWebhookReady } from "@/lib/pos/square/oauth-core";

/**
 * High-level readiness signal for uptime monitoring/deployment checks
 * (Batch 8, spec section 29) — booleans only, never a secret value, a
 * connection string, or any config detail beyond "is this configured."
 * Deliberately a config check, not a live database round trip: a health
 * endpoint that queries Supabase on every hit adds latency/load to
 * whatever's polling it for no real benefit here, since Supabase's own
 * status is Supabase's to report — see docs/production-audit.md for the
 * reasoning. `supabaseConfigured` specifically distinguishes "a real-looking
 * URL" from this project's own local-build placeholder value (see
 * .env.example) — env.ts already throws at boot if the vars are missing or
 * malformed entirely, so a request never reaches this handler in that case.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseConfigured =
    !env.NEXT_PUBLIC_SUPABASE_URL.includes("placeholder");

  return NextResponse.json({
    status: "ok",
    supabaseConfigured,
    aiConfigured: isAiConfigured(),
    // iPhone kitchen alerts: the APNS_* settings are there and the key signs.
    iosPushConfigured: apnsReady(process.env),
    // Square connection (Settings → Point of sale): app keys and a valid
    // token encryption key are set.
    squareConfigured: squareReady(process.env),
    // Square payments can settle: its webhook signature key and URL are set.
    squareWebhookConfigured: squareWebhookReady(process.env),
  });
}
