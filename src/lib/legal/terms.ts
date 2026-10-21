/**
 * The Terms of Service (src/app/terms/page.tsx), linked from sign-up, the
 * landing footer and the sitemap.
 *
 * Prices and the free period are NOT written into the terms: the page
 * reads them from the plans set on /admin (getPublicPricing), so the terms
 * can never disagree with what a restaurant is actually charged.
 */
export const TERMS_PATH = "/terms";

/** Shown as "Last updated". Change it whenever the terms' substance changes. */
export const TERMS_UPDATED = "October 21, 2026";

/** The company that operates Tableside. */
export const LEGAL_ENTITY = "Beacon Digital Consulting LLC";
