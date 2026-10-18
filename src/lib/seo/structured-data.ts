import { SITE_NAME, SITE_URL } from "@/lib/seo/metadata";

/**
 * Schema.org data for public pages. Each one describes only what the page
 * itself shows, and leaves out what isn't known: no invented cuisine,
 * hours, prices, ratings or reviews.
 */

export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/brand/png/tableside-icon-512.png`,
  };
}

interface RestaurantJsonLdInput {
  name: string;
  slug: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  coverImageUrl: string | null;
}

/** For a restaurant's home page (/r/<slug>), which shows all of these. */
export function restaurantJsonLd(r: RestaurantJsonLdInput) {
  const hasAddress = Boolean(r.address || r.city || r.state);
  return {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: r.name,
    url: `${SITE_URL}/r/${r.slug}`,
    hasMenu: `${SITE_URL}/r/${r.slug}/menu`,
    // The page offers "Book a table" to everyone.
    acceptsReservations: true,
    ...(r.description?.trim() && { description: r.description.trim() }),
    ...(r.phone && { telephone: r.phone }),
    ...(r.coverImageUrl && { image: r.coverImageUrl }),
    ...(hasAddress && {
      address: {
        "@type": "PostalAddress",
        ...(r.address && { streetAddress: r.address }),
        ...(r.city && { addressLocality: r.city }),
        ...(r.state && { addressRegion: r.state }),
      },
    }),
  };
}

/** A trail of [name, path] pairs, ending at the current page. */
export function breadcrumbJsonLd(trail: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: `${SITE_URL}${crumb.path}`,
    })),
  };
}
