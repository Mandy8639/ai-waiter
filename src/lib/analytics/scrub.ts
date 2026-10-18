import { scrubUrl } from "@/lib/observability/scrub-url";

/**
 * The page address Vercel Web Analytics is allowed to record.
 *
 * Bearer tokens and ids in the path are redacted by the same rules as
 * error reports (scrubUrl: table, order, receipt, invitation and split-bill
 * links). The query string is dropped outright: it can hold a password-reset
 * token_hash, a Stripe session id or a search, and a "?[redacted]" marker
 * would only split one page into two in the reports.
 *
 * Never throws: it runs inside the analytics beforeSend, where an exception
 * would send the original URL.
 */
export function analyticsUrl(raw: string): string {
  const scrubbed = scrubUrl(raw);
  const queryAt = scrubbed.indexOf("?");
  return queryAt === -1 ? scrubbed : scrubbed.slice(0, queryAt);
}
