/**
 * The Google review link: what an owner may paste, and what diners see.
 * Pure and free of `server-only` (tests/unit/reviews-core.test.ts).
 *
 * Every diner is offered the same link whatever their private rating:
 * Google's review policy forbids asking only happy customers ("review
 * gating"). Nothing here takes a rating, so nothing can gate on one.
 */

/** Hosts Google uses for review links. Mirrors the database's check. */
const GOOGLE_HOSTS = new Set([
  "g.page",
  "search.google.com",
  "www.google.com",
  "google.com",
  "maps.google.com",
  "maps.app.goo.gl",
  "goo.gl",
]);

export const GOOGLE_REVIEW_URL_MAX = 500;

export type ReviewLinkResult =
  { ok: true; url: string | null } | { ok: false; error: string };

/**
 * An owner's pasted link, cleaned: blank clears it; otherwise it must be
 * an https link on one of Google's hosts. `http://` is upgraded, since
 * that's how links copied from some phones arrive.
 */
export function parseGoogleReviewUrl(input: string): ReviewLinkResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, url: null };

  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed.replace(/^http:\/\//i, "https://")
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a link." };
  }

  const host = url.hostname.toLowerCase();
  const allowed =
    url.protocol === "https:" &&
    GOOGLE_HOSTS.has(host) &&
    // goo.gl only redirects to Maps; its other short links went away.
    (host !== "goo.gl" || url.pathname.startsWith("/maps/"));
  if (!allowed) {
    return {
      ok: false,
      error:
        "Use the review link from your Google Business Profile. It starts with g.page or google.com.",
    };
  }

  const clean = url.toString();
  if (clean.length > GOOGLE_REVIEW_URL_MAX) {
    return { ok: false, error: "That link is too long." };
  }
  return { ok: true, url: clean };
}

/**
 * Whether the bottom-of-page link shows: the food has been served and the
 * feedback panel, which carries its own link, isn't on the page.
 */
export function showStandaloneReviewLink(input: {
  hasLink: boolean;
  status: string;
  feedbackPanelShown: boolean;
}): boolean {
  return (
    input.hasLink && input.status === "served" && !input.feedbackPanelShown
  );
}
