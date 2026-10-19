import { NextResponse } from "next/server";
import { runAllSafetyNetChecks } from "@/lib/admin/safety-net-check";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";

/**
 * The free safety net: once a day, each live job's Test (the staff
 * assistant's, then the waiter's) on each free model that could do it
 * (src/lib/admin/safety-net-check.ts). Run by Vercel
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
    const summary = await runAllSafetyNetChecks();
    const failed = Object.values(summary).some((s) => s.error);
    return NextResponse.json(summary, { status: failed ? 500 : 200 });
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
