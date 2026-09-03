/**
 * Client-side observability, per
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md.
 *
 * This file runs before the app becomes interactive, which is the point:
 * an error thrown during the first render is exactly the kind that was
 * previously invisible, and initialising from a component would be too
 * late to catch it.
 *
 * Wrapped in try/catch on the framework's own advice — "this prevents
 * individual tracking failures from affecting other instrumentation
 * features" — and because nothing here is worth a blank page.
 */
import { initClientMonitoring } from "@/lib/observability/report-client";

try {
  initClientMonitoring();
} catch {
  // Monitoring must never be the reason a diner cannot order.
}
