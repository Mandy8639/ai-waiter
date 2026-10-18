"use client";

import { Analytics } from "@vercel/analytics/next";
import { analyticsUrl } from "@/lib/analytics/scrub";

/**
 * Vercel Web Analytics: page views only (the Hobby plan has no custom
 * events). No cookies and no personal data, so no consent banner (see
 * /privacy). Every address is scrubbed before it leaves the browser.
 *
 * The owner journey reads off pages only a step in it can reach:
 * / (landing) → /signup → /onboarding (account created, no restaurant
 * yet) → /dashboard. Vercel counts each visitor once a day, so a refresh
 * doesn't count twice.
 */
export function WebAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => ({ ...event, url: analyticsUrl(event.url) })}
    />
  );
}
