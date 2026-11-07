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
