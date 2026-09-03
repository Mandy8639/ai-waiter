"use client";

import * as Sentry from "@sentry/browser";
import { scrubUrl } from "./scrub-url";

/**
 * Browser-side error reporting.
 *
 * The server half (src/lib/observability/report.ts) has never seen a single
 * client error: a React render crash, a failed fetch, a component throwing
 * in a diner's browser were all invisible. This is that half.
 *
 * The same two rules apply, for the same reasons.
 *
 * NEVER BREAK WHAT IT OBSERVES. Every entry point swallows its own errors.
 * A monitoring vendor being unreachable must not stop a diner ordering.
 *
 * IT IS A DISCLOSURE PATH. The browser SDK attaches the current URL to
 * every event, and a diner's URL carries a table token — a bearer of table
 * access. `beforeSend` scrubs it; see ./scrub-url.ts.
 */

/** Public by design: a DSN is meant to ship in a browser bundle. It identifies a project, it does not authorise reading one. */
export function isClientMonitoringConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

let started = false;

export function initClientMonitoring(): void {
  if (started || !isClientMonitoringConfigured()) return;

  try {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
      // Errors only, matching the server. Tracing samples successful page
      // loads, costs quota, and answers a question nobody is asking yet.
      tracesSampleRate: 0,
      // Defence in depth behind beforeSend: without this the SDK attaches
      // IP address and other identifying request data on its own.
      sendDefaultPii: false,
      beforeSend(event) {
        try {
          if (event.request?.url) {
            event.request.url = scrubUrl(event.request.url);
          }
          // Breadcrumbs record every navigation, so a token would survive
          // in the trail even after the top-level URL was cleaned.
          for (const crumb of event.breadcrumbs ?? []) {
            if (typeof crumb.data?.to === "string") {
              crumb.data.to = scrubUrl(crumb.data.to);
            }
            if (typeof crumb.data?.from === "string") {
              crumb.data.from = scrubUrl(crumb.data.from);
            }
            if (typeof crumb.data?.url === "string") {
              crumb.data.url = scrubUrl(crumb.data.url);
            }
          }
        } catch {
          // Losing the event is worse than sending a slightly less tidy
          // one — but an unscrubbed URL is worse than both, so drop it.
          return null;
        }
        return event;
      },
    });
    started = true;
  } catch {
    // A malformed DSN must not stop the page becoming interactive.
  }
}

/**
 * Reports an error a React error boundary caught.
 *
 * Boundaries already console.error; this adds the half that leaves the
 * browser. Both are kept: the console is what a developer sees with the
 * page open, and it works with no DSN configured.
 */
export function reportClientError(
  error: unknown,
  context: { scope: string; digest?: string },
): void {
  if (!isClientMonitoringConfigured()) return;

  try {
    Sentry.captureException(error, {
      tags: { scope: context.scope },
      extra: { digest: context.digest },
    });
  } catch {
    // See the first rule above.
  }
}
