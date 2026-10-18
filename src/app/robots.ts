import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/metadata";

/**
 * Crawler instructions. Not access control: the signed-in areas are
 * protected by src/proxy.ts and the database, and the pages below also say
 * noindex themselves (PRIVATE_PAGE_ROBOTS in src/lib/seo/metadata.ts).
 * This only saves crawlers the trip.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        // Signed in, or a step of signing in.
        "/dashboard",
        "/account",
        "/onboarding",
        "/login/verify",
        "/reset-password",
        "/forgot-password",
        "/join/",
        "/auth/",
        "/api/",
        // One diner's own visit: cart, orders, receipts, split bills, and
        // the table QR links themselves.
        "/r/*/cart",
        "/r/*/orders",
        "/r/*/order/",
        "/r/*/receipt/",
        "/r/*/split/",
        "/r/*/table/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
