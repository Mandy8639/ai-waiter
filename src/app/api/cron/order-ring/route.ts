import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";
import { ringPendingOrders } from "@/lib/push/dispatch";

/**
 * "Keep ringing until accepted": one round of repeat alerts for orders
 * still waiting in the kitchen (src/lib/push/dispatch.ts,
 * ringPendingOrders).
 *
 * Called every 30 seconds by a Supabase pg_cron job
 * (20261012090000_order_ring.sql), and only while some order is actually
 * due a ring, with `Authorization: Bearer $ORDER_RING_SECRET`. The secret
 * lives in Vercel and, as the same value, in Supabase Vault. Anything else
 * is refused; with no ORDER_RING_SECRET set, everything is.
 *
 * Safe to call twice at once: claim_order_rings() stamps each order it
 * picks, so an overlapping call rings nothing a second time.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(request: Request) {
  if (
    !isAuthorizedCronRequest(
      request.headers.get("authorization"),
      process.env.ORDER_RING_SECRET,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await ringPendingOrders());
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "push_ring_failed",
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
