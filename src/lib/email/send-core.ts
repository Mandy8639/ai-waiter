/**
 * Owner email, the part with no network and no database (phase F). The
 * I/O is handed in, so the rules are unit-tested without Resend or
 * Supabase. src/lib/email/dispatch.ts supplies the real I/O.
 *
 * The rules:
 *   1. CLAIM, THEN SEND. Each (kind, dedupe key, recipient) is claimed in
 *      email_dispatches first; a claim that already exists means the
 *      email went out (or is going out), so this call sends nothing.
 *      Vercel's scheduler can deliver the same run twice and Stripe
 *      redelivers webhooks, so without this an owner would get doubles.
 *   2. THE SAME KEY TWICE. The claim key is also sent to Resend as its
 *      Idempotency-Key, so even a crash between claim and record cannot
 *      produce a second copy on Resend's side.
 *   3. ONE OWNER'S FAILURE IS NOT ANOTHER'S. Each recipient is sent and
 *      recorded independently.
 *   4. NEVER THROWS. Email is a side effect of a webhook or a scheduled
 *      job; nothing here may fail the thing that triggered it.
 */
import type { EmailMessage } from "./templates";

export type EmailKind =
  | "daily_summary"
  | "subscription_past_due"
  | "card_payments_disabled"
  | "diner_payment_failed"
  | "weekly_ai_cost";

export interface Recipient {
  userId: string;
  email: string;
}

export type ProviderResult =
  { ok: true; id: string } | { ok: false; error: string };

export interface EmailDeps {
  /** A dispatch id if this call claimed the email; null if it was already claimed. */
  claim: (recipient: Recipient) => Promise<string | null>;
  send: (
    to: string,
    message: EmailMessage,
    idempotencyKey: string,
  ) => Promise<ProviderResult>;
  record: (dispatchId: string, result: ProviderResult) => Promise<void>;
}

export interface EmailReport {
  sent: number;
  skipped: number;
  failed: number;
}

export function idempotencyKey(
  kind: EmailKind,
  dedupeKey: string,
  recipientUserId: string,
): string {
  // Resend accepts up to 256 characters; these are well under.
  return `${kind}:${dedupeKey}:${recipientUserId}`;
}

export async function sendToOwners(
  deps: EmailDeps,
  options: {
    kind: EmailKind;
    dedupeKey: string;
    recipients: Recipient[];
    message: EmailMessage;
  },
): Promise<EmailReport> {
  const report: EmailReport = { sent: 0, skipped: 0, failed: 0 };

  for (const recipient of options.recipients) {
    try {
      const dispatchId = await deps.claim(recipient);
      if (!dispatchId) {
        report.skipped += 1;
        continue;
      }
      let result: ProviderResult;
      try {
        result = await deps.send(
          recipient.email,
          options.message,
          idempotencyKey(options.kind, options.dedupeKey, recipient.userId),
        );
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await deps.record(dispatchId, result);
      if (result.ok) report.sent += 1;
      else report.failed += 1;
    } catch {
      report.failed += 1;
    }
  }

  return report;
}

// Days ------------------------------------------------------------------------

/**
 * The calendar date a restaurant is living in at `now`, as YYYY-MM-DD.
 * Intl rather than arithmetic on offsets, so daylight saving is the
 * platform's problem and not this file's.
 */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The restaurant's yesterday, as YYYY-MM-DD. */
export function localYesterday(now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  noon.setUTCDate(noon.getUTCDate() - 1);
  return noon.toISOString().slice(0, 10);
}

/** "Monday, September 28" for a YYYY-MM-DD, independent of the server's zone. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
