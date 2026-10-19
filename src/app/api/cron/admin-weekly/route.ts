import { NextResponse } from "next/server";
import { runWeeklyAiCostEmail } from "@/lib/admin/weekly-email";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";

/**
 * The platform admins' Monday email: last week's AI cost per restaurant
 * (src/lib/admin/weekly-email.ts). Run by Vercel Cron (vercel.json) with
 * the same CRON_SECRET check as the daily summary. Safe to run twice:
 * each admin's email for a week is claimed before it is sent.
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
    const run = await runWeeklyAiCostEmail();
    return NextResponse.json(run, {
      status: run.status === "report_failed" ? 500 : 200,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_weekly_email_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
