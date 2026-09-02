/**
 * What may leave this process, and what may not.
 *
 * Kept out of any module importing `server-only` so it is directly
 * testable — the same extract-the-core convention as
 * src/lib/payments/tip.ts.
 *
 * Error reporting sends data to a third party, which makes it a
 * disclosure path as much as a debugging tool. Everything here exists to
 * keep that path from carrying something it shouldn't: a session cookie
 * would let a reader impersonate the diner whose payment failed, and an
 * API key in a URL would be worse. Sentry never needs either to group a
 * stack trace.
 *
 * The rule is an allowlist rather than a denylist. A denylist is wrong by
 * default — it leaks every header nobody thought of — and headers arrive
 * from the client, so "nobody thought of it" includes headers an attacker
 * chose the name of.
 */

/** Headers worth having for debugging and safe to send. Everything else is dropped. */
const HEADER_ALLOWLIST = new Set([
  "user-agent",
  "referer",
  "content-type",
  "accept-language",
  "x-forwarded-for",
  "x-vercel-id",
]);

/**
 * Query strings can carry a table token (`/r/x/table/<token>`, a bearer of
 * table access) or a Stripe session id. The path is kept because it is how
 * you find the route; the query is dropped wholesale rather than filtered,
 * since a per-parameter allowlist has the same default-open flaw.
 */
export function scrubPath(path: string): string {
  const queryStart = path.indexOf("?");
  return queryStart === -1 ? path : `${path.slice(0, queryStart)}?[redacted]`;
}

export function scrubHeaders(
  // Values are optional: Next types the incoming headers as a dictionary
  // whose entries may be absent, so a present key does not guarantee a
  // present value.
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  if (!headers) return {};

  const safe: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    if (value === undefined) continue;
    safe[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return safe;
}

/**
 * Turns anything thrown into a real Error.
 *
 * Code can throw a string, a Supabase error object, or undefined. Sentry
 * groups by stack trace, so a non-Error arrives with no stack and every
 * such report collapses into one useless cluster. Wrapping preserves the
 * message and gives the report a stack from the capture site, which is at
 * least the right file.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;

  if (typeof thrown === "object" && thrown !== null) {
    const maybeMessage = (thrown as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      const error = new Error(maybeMessage);
      // Supabase errors carry a code that is far more useful for grouping
      // than the message, which often embeds an id.
      const code = (thrown as { code?: unknown }).code;
      if (typeof code === "string") error.name = `PostgresError(${code})`;
      return error;
    }
  }

  return new Error(typeof thrown === "string" ? thrown : "Unknown error");
}
