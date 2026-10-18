import type { Metadata } from "next";

/**
 * Search and link-preview metadata for public pages.
 *
 * SITE_URL is the production domain (tableside.menu, primary since
 * 2026-09-24). order.beacondigitalconsulting.org serves the same app and
 * must keep serving it (printed QR codes and Stripe webhooks), so every
 * public page names its tableside.menu address as canonical: search
 * engines then treat the two hosts as one site rather than duplicates.
 *
 * Next.js replaces a parent's `openGraph` and `twitter` objects outright
 * rather than merging them (generate-metadata.md, "Merging"), so pages
 * build theirs here instead of inheriting a partial set from the layout.
 */
export const SITE_URL = "https://tableside.menu";
export const SITE_NAME = "Tableside";

/** Made by scripts/make-og-image.cjs. */
export const DEFAULT_SHARE_IMAGE = {
  url: "/brand/og/tableside-og.png",
  width: 1200,
  height: 630,
  alt: "Tableside: an AI waiter for restaurants",
};

export interface ShareImage {
  url: string;
  width?: number;
  height?: number;
  alt: string;
}

export function publicPageMetadata({
  title,
  description,
  path,
  image = DEFAULT_SHARE_IMAGE,
}: {
  title: string;
  description: string;
  /** The page's own path, e.g. "/privacy". */
  path: string;
  image?: ShareImage;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_US",
      title,
      description,
      url: path,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image.url],
    },
  };
}

/**
 * For pages that only make sense to the person who opened them: a diner's
 * cart, orders and receipts, sign-in steps, and everything signed in.
 * Search engines are asked not to list them. robots.txt keeps crawlers out
 * of the signed-in areas too; neither is access control.
 */
export const PRIVATE_PAGE_ROBOTS: Metadata["robots"] = {
  index: false,
  follow: false,
};
