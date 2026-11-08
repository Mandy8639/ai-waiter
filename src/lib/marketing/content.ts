/**
 * Words and links shared across the public marketing pages. Kept in one
 * place so the header, footer and pages can't drift apart, and so a claim
 * is only ever stated once.
 *
 * Nothing here is invented: no customer names, ratings or numbers. Tableside
 * has no pilot restaurants yet, and the pages must not imply otherwise.
 */
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";
import { SUPPORT_PATH } from "@/lib/legal/support";
import { SECURITY_PATH } from "@/lib/legal/security";
import { TERMS_PATH } from "@/lib/legal/terms";

export const MARKETING_NAV = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/demo", label: "Live demo" },
  { href: SUPPORT_PATH, label: "Support" },
] as const;

/**
 * The staff app (Tableside for Restaurants): order alerts and the kitchen
 * board on the restaurant's own phones. Guests never need an app.
 */
export const STAFF_APP = {
  appStore: "https://apps.apple.com/us/app/id6826677708",
  googlePlay:
    "https://play.google.com/store/apps/details?id=menu.tableside.app",
} as const;

/** The notice Apple's and Google's badge rules ask for, shown in the footer. */
export const STORE_TRADEMARKS =
  "Apple and the Apple logo are trademarks of Apple Inc. App Store is a service mark of Apple Inc. Google Play and the Google Play logo are trademarks of Google LLC.";

export const FOOTER_GROUPS = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
      { href: "/demo", label: "Live demo" },
    ],
  },
  {
    title: "Get started",
    links: [
      { href: "/signup", label: "Create an account" },
      { href: "/login", label: "Sign in" },
      { href: SUPPORT_PATH, label: "Support" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: SECURITY_PATH, label: "Security" },
      { href: PRIVACY_POLICY_PATH, label: "Privacy policy" },
      { href: TERMS_PATH, label: "Terms" },
    ],
  },
] as const;

/**
 * The demo restaurant (scripts/create-demo-restaurant.ts). Fictional name,
 * fictional food. The /demo page only offers it once it exists.
 */
export const DEMO_RESTAURANT_SLUG = "lantern-table-demo";
