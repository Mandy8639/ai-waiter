/**
 * The retry rule for owner-side AI drafting on free models (translation
 * drafts, nutrition estimates), with no network: unit-tested.
 *
 * Why it exists: the free OpenRouter router is uneven. In a live check on
 * 2026-10-08 the same request was answered in 1.5 s, in 44 s, not at all,
 * and once by a content-safety model that replied "User Safety: safe". A
 * single attempt fails often enough that owners stop trusting the button,
 * so each batch gets a few attempts inside a time budget, and a reply
 * with nothing usable in it counts as a failure worth retrying.
 */

export type DraftAttempt<T> =
  { ok: true; value: T } | { ok: false; reason: "failed" };

export interface RetryOptions<T> {
  /** Whether a successful reply actually contains something to save. */
  usable: (value: T) => boolean;
  maxAttempts?: number;
  /** Total time one batch may take across all its attempts. */
  budgetMs?: number;
  /** The longest a single attempt may run. */
  perAttemptMs?: number;
  /** Don't start an attempt with less than this left of the budget. */
  minAttemptMs?: number;
  now?: () => number;
}

export const FREE_DRAFT_DEFAULTS = {
  maxAttempts: 3,
  budgetMs: 45_000,
  perAttemptMs: 30_000,
  minAttemptMs: 5_000,
} as const;

/**
 * Runs `attempt` until it returns a usable value, the attempts run out, or
 * the budget does. Returns the last result: a usable value, an ok-but-empty
 * value (the model answered and nothing in it passed the checks), or a
 * failure.
 */
export async function retryDraft<T>(
  attempt: (timeoutMs: number) => Promise<DraftAttempt<T>>,
  options: RetryOptions<T>,
): Promise<DraftAttempt<T>> {
  const {
    usable,
    maxAttempts = FREE_DRAFT_DEFAULTS.maxAttempts,
    budgetMs = FREE_DRAFT_DEFAULTS.budgetMs,
    perAttemptMs = FREE_DRAFT_DEFAULTS.perAttemptMs,
    minAttemptMs = FREE_DRAFT_DEFAULTS.minAttemptMs,
    now = Date.now,
  } = options;

  const started = now();
  let last: DraftAttempt<T> = { ok: false, reason: "failed" };
  for (let i = 0; i < maxAttempts; i += 1) {
    const remaining = budgetMs - (now() - started);
    if (remaining < minAttemptMs) break;
    last = await attempt(Math.min(remaining, perAttemptMs));
    if (last.ok && usable(last.value)) return last;
  }
  return last;
}
