import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";
import { runDailySummaries } from "@/lib/email/dispatch";

/**
 * The owners' daily summary email (phase F), run once a day by Vercel Cron
 * (vercel.json).
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` with every scheduled
 * call. Anything else is refused — with no CRON_SECRET set, everything is,
 * so a deployment that forgot the secret sends nothing rather than letting
 * the public trigger it.
 *
 * Safe to call twice: Vercel's scheduler occasionally delivers a run more
 * than once, and every email is claimed in email_dispatches before it is
 * sent (src/lib/email/send-core.ts).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const run = await runDailySummaries();
    return NextResponse.json(run);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "email_daily_summary_failed",
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
