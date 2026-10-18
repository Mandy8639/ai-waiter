import type { ShareImage } from "@/lib/seo/metadata";

/**
 * Search and link-preview text for a restaurant's public pages, built only
 * from what the restaurant itself entered. Nothing here describes a cuisine,
 * a rating or an offer it didn't state.
 */

interface RestaurantSeoFields {
  name: string;
  description: string | null;
  city: string | null;
  state: string | null;
  coverImageUrl: string | null;
}

/** Search snippets are cut around 160 characters; end on a word. */
export function trimForSnippet(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, "")}…`;
}

export function restaurantPlace(
  r: Pick<RestaurantSeoFields, "city" | "state">,
) {
  return [r.city, r.state].filter(Boolean).join(", ") || null;
}

/** The restaurant's own description, else its name and town. */
export function restaurantDescription(r: RestaurantSeoFields): string {
  if (r.description?.trim()) return trimForSnippet(r.description);
  const place = restaurantPlace(r);
  return `The menu at ${r.name}${place ? ` in ${place}` : ""}.`;
}

/** The restaurant's cover photo, when it has one; else the Tableside image. */
export function restaurantShareImage(
  r: RestaurantSeoFields,
): ShareImage | undefined {
  return r.coverImageUrl ? { url: r.coverImageUrl, alt: r.name } : undefined;
}
