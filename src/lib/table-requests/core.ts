/**
 * What a table request is, in words, and how long it has been waiting.
 *
 * Pure and free of `server-only`, so the wording and the waiting maths are
 * testable directly — see src/lib/env-helpers.ts for why that matters in
 * this project.
 *
 * The vocabulary lives here rather than in each component because three
 * surfaces say these words: the diner's buttons, the staff queue, and the
 * AI waiter's replies. They have to agree, and "Call waiter" in one place
 * with "Server requested" in another is how a product starts to feel like
 * two products.
 */

/** The two things a table can ask for. Mirrors the database's check constraint. */
export const REQUEST_KINDS = ["waiter", "bill"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export function isRequestKind(value: unknown): value is RequestKind {
  return (REQUEST_KINDS as readonly unknown[]).includes(value);
}

/** What the diner's button says. */
export const DINER_LABELS: Record<RequestKind, string> = {
  waiter: "Call a waiter",
  bill: "Ask for the bill",
};

/** What the diner is told once it is in. Present tense: it has happened. */
export const DINER_CONFIRMATIONS: Record<RequestKind, string> = {
  waiter: "Someone's on their way.",
  bill: "We've asked for your bill.",
};

/** What staff read in the queue. Short, because it is scanned, not read. */
export const STAFF_LABELS: Record<RequestKind, string> = {
  waiter: "Wants a waiter",
  bill: "Wants the bill",
};

/**
 * How long a request has been waiting, for the staff queue.
 *
 * Coarse on purpose. A queue that ticks every second invites staring at
 * it; what a floor manager needs is "this table has been waiting a while",
 * and the exact second is noise. Under a minute reads as "just now"
 * because a request that new has not been ignored by anyone.
 */
export function waitingLabel(createdAt: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "over an hour" : `over ${hours} hours`;
}

/**
 * Past this, a request is drawn as overdue.
 *
 * Five minutes is not a service-level promise; it is the point at which a
 * person sitting at a table starts wondering whether anyone saw them.
 */
export const OVERDUE_AFTER_MS = 5 * 60 * 1000;

export function isOverdue(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= OVERDUE_AFTER_MS;
}

/** How a table is named in the queue: the display name if set, else the number. */
export function tableLabel(
  tableNumber: string,
  displayName: string | null,
): string {
  const trimmed = displayName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `Table ${tableNumber}`;
}

/**
 * The database's error codes, as sentences.
 *
 * Every one of these is shown to a diner or to floor staff mid-service, so
 * none of them explains the system: "there is already an open request of
 * that kind" is a true sentence that helps nobody holding a phone.
 */
export function requestErrorMessage(message: string): string {
  if (message.includes("TABLE_REQUEST_NO_SESSION")) {
    return "Scan the QR code on your table first, so we know where to come.";
  }
  if (message.includes("TABLE_REQUEST_RATE_LIMITED")) {
    return "You've asked a few times already. Someone will be with you shortly.";
  }
  if (message.includes("TABLE_REQUEST_FORBIDDEN")) {
    return "That isn't yours to change.";
  }
  if (message.includes("TABLE_REQUEST_NOT_OPEN")) {
    return "Someone already dealt with that one.";
  }
  if (message.includes("TABLE_REQUEST_NOT_FOUND")) {
    return "That request is no longer there.";
  }
  if (message.includes("TABLE_REQUEST_INVALID_KIND")) {
    return "We can't ask for that.";
  }
  return "That didn't go through. Please try again.";
}
