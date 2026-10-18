// @vitest-environment jsdom
//
// Structured data says only what the page shows (missing fields are left
// out, never filled in), and restaurant-entered text can't end the script
// tag it sits in.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonLd } from "@/components/seo/json-ld";
import { breadcrumbJsonLd, restaurantJsonLd } from "@/lib/seo/structured-data";

const bare = {
  name: "Nashta",
  slug: "my-restaurant",
  description: null,
  address: null,
  city: null,
  state: null,
  phone: null,
  coverImageUrl: null,
};

describe("restaurantJsonLd", () => {
  it("leaves out everything the restaurant hasn't entered", () => {
    expect(restaurantJsonLd(bare)).toEqual({
      "@context": "https://schema.org",
      "@type": "Restaurant",
      name: "Nashta",
      url: "https://tableside.menu/r/my-restaurant",
      hasMenu: "https://tableside.menu/r/my-restaurant/menu",
      acceptsReservations: true,
    });
  });

  it("includes what it has entered, as entered", () => {
    const full = restaurantJsonLd({
      ...bare,
      description: "Vegetarian street food.",
      address: "1 Main St",
      city: "Edison",
      state: "NJ",
      phone: "+1 732 555 0100",
      coverImageUrl: "https://cdn.example/cover.webp",
    });
    expect(full).toMatchObject({
      description: "Vegetarian street food.",
      telephone: "+1 732 555 0100",
      image: "https://cdn.example/cover.webp",
      address: {
        "@type": "PostalAddress",
        streetAddress: "1 Main St",
        addressLocality: "Edison",
        addressRegion: "NJ",
      },
    });
    for (const invented of [
      "servesCuisine",
      "aggregateRating",
      "review",
      "openingHours",
      "priceRange",
    ]) {
      expect(full).not.toHaveProperty(invented);
    }
  });
});

describe("breadcrumbJsonLd", () => {
  it("numbers the trail from 1 with full URLs", () => {
    expect(
      breadcrumbJsonLd([
        { name: "Menu", path: "/r/x/menu" },
        { name: "Dosa", path: "/r/x/item/1" },
      ]).itemListElement,
    ).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Menu",
        item: "https://tableside.menu/r/x/menu",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Dosa",
        item: "https://tableside.menu/r/x/item/1",
      },
    ]);
  });
});

describe("JsonLd", () => {
  it("escapes < so restaurant text can't close the script tag", () => {
    const html = renderToStaticMarkup(
      <JsonLd data={{ description: "</script><script>alert(1)</script>" }} />,
    );
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
  });
});
