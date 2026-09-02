import type { Instrumentation } from "next";

/**
 * Server-side observability, per
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md.
 *
 * Both hooks import the reporter lazily. @sentry/node needs Node APIs the
 * Edge runtime does not have, and this file is loaded in both runtimes —
 * a top-level import would break the Edge bundle rather than simply doing
 * nothing there.
 *
 * `onRequestError` catches what escapes. That is genuinely less than it
 * sounds: this codebase catches its own payment failures and returns a
 * message for the diner, so those never reach here. The explicit
 * reportError() calls at those catch sites do the heavy lifting — see the
 * second rule in src/lib/observability/report.ts.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initMonitoring } = await import("./lib/observability/report");
  initMonitoring();
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reportRequestError, flushMonitoring } =
    await import("./lib/observability/report");
  reportRequestError(err, request, context);

  // Awaited here rather than deferred through after(): Next awaits this
  // hook, and an error escaping a request is exactly the moment the
  // invocation is about to end. Waiting a moment for the event to leave is
  // cheaper than losing the report of a crash.
  await flushMonitoring();
};
