import "server-only";

import * as Sentry from "@sentry/node";
import { after } from "next/server";
import { scrubHeaders, scrubPath, toError } from "./scrub";

/**
 * Reporting a failure.
 *
 * Two rules govern everything here.
 *
 * FIRST: reporting must never be able to break the thing it observes. Every
 * entry point swallows its own errors. A monitoring tool that takes the
 * site down when its vendor has an outage is worse than no monitoring, and
 * this one sits directly in the payment paths.
 *
 * SECOND: on Vercel this runs serverless, and a captured event is only
 * queued — the transport sends it asynchronously. Once the response is
 * returned the runtime can freeze, dropping whatever had not gone out yet,
 * so a report can be captured perfectly and still never arrive.
 * `@sentry/nextjs` handles that automatically; choosing `@sentry/node` to
 * avoid staking the build on a fork-incompatible plugin means handling it
 * here instead. `after()` is the framework's own answer — work scheduled
 * after the response, without blocking it.
 *
 * THIRD: the interesting failures do not throw. Next's `onRequestError`
 * only fires for errors that escape, and this codebase deliberately
 * catches its payment failures and returns a sentence for the diner —
 * `parsePaymentError()` exists for exactly that. So the framework hook is
 * necessary but far from sufficient, and the explicit `reportError()` calls
 * at those catch sites are where the real coverage comes from. Without
 * them, a Stripe refusal or a database rule rejection is invisible: the
 * customer is told politely that something went wrong, and nobody is told
 * what.
 */

/** How long to wait for queued events before giving up. Long enough for a normal send, short enough not to hold a serverless invocation open. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Pushes queued events out before the runtime can freeze.
 *
 * Scheduled through `after()` so it never delays the response a diner or
 * staff member is waiting on. Outside a request — during `register()`, or
 * in a script — `after()` throws, so that case falls back to a
 * fire-and-forget flush rather than losing the event or the caller.
 */
function scheduleFlush(): void {
  try {
    after(async () => {
      try {
        await Sentry.flush(FLUSH_TIMEOUT_MS);
      } catch {
        // Reporting must never break what it observes.
      }
    });
  } catch {
    void Sentry.flush(FLUSH_TIMEOUT_MS).catch(() => {});
  }
}

/** Sentry is optional. Without a DSN this module is inert — which is what local development and CI want. */
export function isMonitoringConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

let started = false;

/**
 * Called once from instrumentation.ts. Safe to call more than once.
 *
 * Node runtime only: @sentry/node depends on Node APIs the Edge runtime
 * does not provide, so the caller guards on NEXT_RUNTIME rather than
 * letting an import blow up middleware.
 */
export function initMonitoring(): void {
  if (started || !isMonitoringConfigured()) return;

  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      // Ties a report to the deploy that produced it. Without this, a stack
      // trace points at line numbers from whichever build you happen to be
      // reading, which is rarely the one that failed.
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      // Errors only. Tracing samples ordinary successful requests, which
      // costs quota and answers a question nobody here is asking yet.
      tracesSampleRate: 0,
      // Defence in depth behind the explicit scrubbing below: the SDK's own
      // collectors can otherwise attach cookies and request bodies.
      sendDefaultPii: false,
    });
    started = true;
  } catch {
    // A malformed DSN must not stop the server from booting.
  }
}

/**
 * Awaits the queued events directly, for callers that already sit at the
 * end of an invocation — instrumentation.ts's onRequestError, which Next
 * awaits. Inert without a DSN, and never throws.
 */
export async function flushMonitoring(): Promise<void> {
  if (!isMonitoringConfigured()) return;
  try {
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  } catch {
    // As above: reporting must never break what it observes.
  }
}

export interface ErrorContext {
  /** Where this came from, e.g. "payments.refund". Becomes a searchable tag. */
  scope: string;
  /** Extra detail worth having in the report. Must never carry card data, tokens, or anything identifying a diner. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Reports a failure that was handled — the case the framework hook cannot
 * see.
 *
 * Always logs, whether or not Sentry is configured, so a failure is
 * recoverable from platform logs alone and local development still shows
 * something. `console.error` is deliberate: on Vercel it is captured, and
 * it is the one sink that cannot itself be misconfigured.
 */
export function reportError(thrown: unknown, context: ErrorContext): void {
  const error = toError(thrown);

  try {
    console.error(
      JSON.stringify({
        level: "error",
        scope: context.scope,
        name: error.name,
        message: error.message,
        ...context.extra,
      }),
    );
  } catch {
    // Circular structure in `extra`, or a console that is gone. Nothing
    // here is worth failing a payment over.
  }

  if (!isMonitoringConfigured()) return;

  try {
    Sentry.captureException(error, {
      tags: { scope: context.scope },
      extra: context.extra,
    });
    scheduleFlush();
  } catch {
    // Sentry unreachable or not initialised. See the first rule above.
  }
}

/**
 * Reports an error that escaped to the framework, from
 * instrumentation.ts's onRequestError.
 *
 * Request details are scrubbed before they leave: see ./scrub.ts for why
 * headers are an allowlist and query strings are dropped whole.
 */
export function reportRequestError(
  thrown: unknown,
  request: {
    path?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
  },
  context: { routePath?: string; routeType?: string },
): void {
  const error = toError(thrown);

  // A digest is React's identifier for an error thrown during Server
  // Component rendering, where the real error is replaced before it gets
  // here. It is the only way to tie this report to the server log entry
  // holding the actual cause.
  const digest =
    typeof thrown === "object" && thrown !== null && "digest" in thrown
      ? String((thrown as { digest: unknown }).digest)
      : undefined;

  try {
    console.error(
      JSON.stringify({
        level: "error",
        scope: `request.${context.routeType ?? "unknown"}`,
        name: error.name,
        message: error.message,
        path: request.path ? scrubPath(request.path) : undefined,
        method: request.method,
        routePath: context.routePath,
        digest,
      }),
    );
  } catch {
    // As above.
  }

  if (!isMonitoringConfigured()) return;

  try {
    Sentry.captureException(error, {
      tags: {
        scope: `request.${context.routeType ?? "unknown"}`,
        routePath: context.routePath,
      },
      extra: {
        path: request.path ? scrubPath(request.path) : undefined,
        method: request.method,
        digest,
        headers: scrubHeaders(request.headers),
      },
    });
    scheduleFlush();
  } catch {
    // As above.
  }
}
