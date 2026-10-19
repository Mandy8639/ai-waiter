import { NextResponse } from "next/server";
import { runSafetyNetCheck } from "@/lib/admin/safety-net-check";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";

/**
 * The waiter's free safety net: once a day, the waiter Test on each free
 * tool-calling model (src/lib/admin/safety-net-check.ts). Run by Vercel
 * Cron (vercel.json), with the same CRON_SECRET check as the daily
 * summary: anything else is refused, and everything is when the secret
 * is unset. Free models only, so a stray run costs nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (
    !isAuthorizedCronRequest(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runSafetyNetCheck();
    return NextResponse.json(summary, { status: summary.error ? 500 : 200 });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "safety_net_check_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
