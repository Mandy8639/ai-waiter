/**
 * Delivery policy for the POS outbox — when to retry, and when to stop.
 *
 * Pure and `server-only`-free so it is directly unit testable, like
 * order-confirmation.ts and prep-estimate.ts. No connector exists yet;
 * this is the half of one that can be written and proven now, and it is
 * the half that is easy to get quietly wrong.
 */

export type OutboxStatus = "pending" | "delivered" | "failed" | "abandoned";

/**
 * Exponential, with a ceiling.
 *
 * A POS that is down is usually down for minutes, not milliseconds, so
 * the early retries are seconds apart and the later ones are not. The cap
 * matters more than the curve: without it the eighth retry is hours away,
 * and an order that reached the till three hours after the diner ate is
 * not a recovered order, it is a confusing one.
 */
const BASE_DELAY_SECONDS = 15;
const MAX_DELAY_SECONDS = 15 * 60;

/**
 * After this many failures the row is abandoned and a human is the
 * fallback. Chosen so the total window is roughly an hour — long enough
 * to ride out a POS restart or a network blip, short enough that staff
 * find out during the same service rather than the next morning.
 */
export const MAX_ATTEMPTS = 8;

export function retryDelaySeconds(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw = BASE_DELAY_SECONDS * 2 ** (n - 1);
  return Math.min(raw, MAX_DELAY_SECONDS);
}

export interface DeliveryOutcome {
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/**
 * What to write back after one delivery attempt.
 *
 * Failure is 'pending' with a later next_attempt_at until the attempts
 * run out, and only then 'abandoned'. 'failed' is deliberately not used
 * for a retryable error — a row that says "failed" while it is still
 * going to be retried tells whoever reads the dashboard the opposite of
 * the truth.
 */
export function afterAttempt(params: {
  ok: boolean;
  attemptsBefore: number;
  error?: string;
  now?: Date;
}): DeliveryOutcome {
  const now = params.now ?? new Date();
  const attempts = params.attemptsBefore + 1;

  if (params.ok) {
    return {
      status: "delivered",
      attempts,
      nextAttemptAt: null,
      lastError: null,
    };
  }

  // The error is stored so a human can see WHY it never arrived. Bounded,
  // because a POS returning an HTML error page would otherwise put a
  // whole document in a column somebody reads in a dashboard.
  const lastError = (params.error ?? "Unknown error").slice(0, 500);

  if (attempts >= MAX_ATTEMPTS) {
    return { status: "abandoned", attempts, nextAttemptAt: null, lastError };
  }

  const next = new Date(now.getTime() + retryDelaySeconds(attempts) * 1000);
  return {
    status: "pending",
    attempts,
    nextAttemptAt: next.toISOString(),
    lastError,
  };
}

/**
 * Whether a row is due. Kept next to the policy rather than expressed
 * only as SQL, so the worker and the tests agree on one definition.
 */
export function isClaimable(
  row: { status: OutboxStatus; nextAttemptAt: string },
  now: Date = new Date(),
): boolean {
  if (row.status !== "pending") return false;
  const due = Date.parse(row.nextAttemptAt);
  // An unparseable timestamp is treated as due rather than stuck: a row
  // that can never be claimed is an order the POS silently never gets.
  if (!Number.isFinite(due)) return true;
  return due <= now.getTime();
}
