import "server-only";
import { emailConfig } from "@/lib/email/config";
import { sendWithResend } from "@/lib/email/resend";
import { sendToOwners, type EmailReport } from "@/lib/email/send-core";
import { renderWeeklyAiCost } from "@/lib/email/templates";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseAdminEmails } from "./access-core";
import { getCostReport } from "./cost-report";
import {
  costTotals,
  formatSpend,
  weekBounds,
  weekKey,
  weekLabel,
  weeklySubject,
} from "./cost-report-core";

/**
 * The Monday email to platform admins (docs/admin.md, Phase 4): last
 * week's AI cost, per restaurant. Sent by Vercel Cron
 * (/api/cron/admin-weekly) through the same Resend setup and the same
 * claim-then-send rule as the owners' daily summary
 * (src/lib/email/send-core.ts), with its own once-only log, because
 * email_dispatches belongs to a restaurant and this email to none.
 */

type Store = {
  from: (t: "platform_email_dispatches") => {
    upsert: (
      row: Record<string, unknown>,
      o: { onConflict: string; ignoreDuplicates: boolean },
    ) => {
      select: (c: "id") => Promise<{
        data: { id: string }[] | null;
        error: { message: string } | null;
      }>;
    };
    update: (row: Record<string, unknown>) => {
      eq: (c: "id", v: string) => Promise<unknown>;
    };
  };
};

export type WeeklyRun =
  | { status: "not_configured" | "no_recipients" | "report_failed" }
  | { status: "done"; week: string; report: EmailReport };

export async function runWeeklyAiCostEmail(
  now = new Date(),
): Promise<WeeklyRun> {
  const config = emailConfig();
  if (!config) return { status: "not_configured" };
  const emails = [...parseAdminEmails(process.env.PLATFORM_ADMIN_EMAILS)];
  if (emails.length === 0) return { status: "no_recipients" };

  const { lastWeek } = weekBounds(now);
  const rows = await getCostReport(lastWeek);
  if (!rows) return { status: "report_failed" };

  const totals = costTotals(rows);
  const message = renderWeeklyAiCost({
    subject: weeklySubject(totals),
    weekLabel: weekLabel(lastWeek),
    totalCost: formatSpend(totals.costUsd),
    waiterChats: totals.waiterChats,
    restaurants: totals.restaurants,
    perChat: totals.perChatUsd === null ? null : formatSpend(totals.perChatUsd),
    rows: rows.map((r) => ({
      name: r.name,
      chats: r.waiterChats,
      cost: formatSpend(r.costUsd),
    })),
    unpriced: totals.unpriced,
    adminUrl: `${config.appUrl}/admin`,
  });

  const week = weekKey(lastWeek);
  const store = createAdminClient() as unknown as Store;
  const report = await sendToOwners(
    {
      claim: async (recipient) => {
        const { data, error } = await store
          .from("platform_email_dispatches")
          .upsert(
            {
              kind: "weekly_ai_cost",
              dedupe_key: week,
              recipient: recipient.email,
            },
            { onConflict: "kind,dedupe_key,recipient", ignoreDuplicates: true },
          )
          .select("id");
        if (error) throw new Error(error.message);
        return data?.[0]?.id ?? null;
      },
      send: (to, msg, idempotencyKey) =>
        sendWithResend({
          apiKey: config.apiKey,
          from: config.from,
          to,
          message: msg,
          idempotencyKey,
        }),
      record: async (id, result) => {
        await store
          .from("platform_email_dispatches")
          .update(
            result.ok
              ? {
                  sent_at: new Date().toISOString(),
                  provider_message_id: result.id,
                }
              : { error: result.error.slice(0, 500) },
          )
          .eq("id", id);
      },
    },
    {
      kind: "weekly_ai_cost",
      dedupeKey: week,
      // The email address stands in for a user id: admins are listed by email.
      recipients: emails.map((email) => ({ userId: email, email })),
      message,
    },
  );
  console.info(
    JSON.stringify({ event: "admin_weekly_email", week, ...report }),
  );
  return { status: "done", week, report };
}
