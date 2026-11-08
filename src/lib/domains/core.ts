/**
 * Tableside's addresses. tableside.menu is the one site (primary since
 * 2026-09-24). order.beacondigitalconsulting.org served the same app
 * before that; since 2026-11-08 its pages redirect here, permanently and
 * path intact, so an old QR code or link lands on the same page.
 *
 * Pages only. Its /api/ addresses keep answering in place: machines call
 * those (Stripe retrying a delivery queued before the webhooks moved,
 * a kitchen printer configured with the old host), and machines often
 * don't follow redirects, so a redirect would quietly break them.
 *
 * Pure (tests/unit/domains-core.test.ts); src/proxy.ts applies it.
 */

export const PRIMARY_ORIGIN = "https://tableside.menu";

const OLD_APP_HOSTS = new Set(["order.beacondigitalconsulting.org"]);

/** Where an old-host page request goes, or null to serve it as usual. */
export function oldHostRedirect(
  host: string | null,
  pathname: string,
  search: string,
): string | null {
  if (!host) return null;
  const name = host.toLowerCase().split(":")[0];
  if (!OLD_APP_HOSTS.has(name)) return null;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  return `${PRIMARY_ORIGIN}${pathname}${search}`;
}
