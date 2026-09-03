/**
 * Redacting what a browser URL would otherwise leak to Sentry.
 *
 * Pure and free of `server-only` so it is directly testable — the same
 * extract-the-core convention as src/lib/observability/scrub.ts, which does
 * the equivalent job for server request headers.
 *
 * THE TABLE TOKEN IS THE WHOLE REASON THIS EXISTS
 *
 * A diner arrives at `/r/<slug>/table/<token>`, and that token is a bearer
 * of table access: anyone holding it can open a session at that table. The
 * browser SDK attaches the current URL to every event, so without this an
 * ordinary render error would hand a live table token to a third party —
 * and to anyone who can read the issue afterwards.
 *
 * Order ids are redacted for a weaker but real reason: they identify one
 * diner's order, and an error report is not a place to accumulate them.
 */

/** Path segments whose FOLLOWING segment is sensitive and must not leave the browser. */
const REDACT_AFTER = new Set(["table", "order", "receipt"]);

/**
 * Replaces sensitive path segments and drops the query string entirely.
 *
 * Query strings are dropped wholesale rather than filtered, for the same
 * reason scrub.ts drops them server-side: a per-parameter allowlist is
 * open by default, and this one carries Stripe session ids.
 *
 * Accepts an absolute or relative URL and never throws — it runs inside a
 * Sentry `beforeSend`, where an exception would lose the event it was
 * trying to sanitise.
 */
export function scrubUrl(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;

  try {
    // A base is supplied so relative paths parse; it is discarded unless
    // the input was genuinely absolute.
    const wasAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const url = new URL(raw, "http://scrub.invalid");

    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length - 1; i++) {
      if (REDACT_AFTER.has(segments[i]) && segments[i + 1]) {
        segments[i + 1] = "[redacted]";
      }
    }
    url.pathname = segments.join("/");

    const query = url.search ? "?[redacted]" : "";
    const path = `${url.pathname}${query}`;

    return wasAbsolute ? `${url.origin}${path}` : path;
  } catch {
    // Unparseable input: return a marker rather than the original, since
    // the original is exactly what might be carrying a token.
    return "[unparseable-url]";
  }
}
