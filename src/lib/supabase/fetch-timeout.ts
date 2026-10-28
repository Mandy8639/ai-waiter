/**
 * A fetch for the Supabase clients that gives up after `timeoutMs`.
 *
 * Without it a request to an overloaded Supabase can hang until Node's own
 * limit (300 s for the response headers). Found in the 2026-10-28
 * busy-night simulation: the kitchen board's refresh is a server action,
 * a browser sends its server actions one at a time (Next.js "sequential
 * dispatch"), so one hung request froze that tablet's board, and every
 * tap behind it, for five to six minutes while orders waited.
 *
 * The database already stops a statement after 8 s (Supabase's
 * statement_timeout for signed-in users), so a request still waiting
 * after 20 s is stuck, not slow. No `server-only`: unit-tested
 * (tests/unit/supabase-fetch-timeout.test.ts).
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 20_000;

export function fetchWithTimeout(
  timeoutMs: number,
  base: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return base(input, { ...init, signal });
  };
}
