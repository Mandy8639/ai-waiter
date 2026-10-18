import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_IMAGE,
  PRIVATE_PAGE_ROBOTS,
  publicPageMetadata,
} from "@/lib/seo/metadata";
import {
  restaurantDescription,
  restaurantShareImage,
  trimForSnippet,
} from "@/lib/seo/restaurant";

/**
 * What search engines and link previews are told about public pages. The
 * restaurant text may only use what the restaurant entered: nothing is
 * invented when a field is empty.
 */

describe("publicPageMetadata", () => {
  const meta = publicPageMetadata({
    title: "Privacy policy — Tableside",
    description: "What Tableside collects.",
    path: "/privacy",
  });

  it("names the page's own path as canonical", () => {
    expect(meta.alternates).toEqual({ canonical: "/privacy" });
  });

  it("gives Open Graph and X the same title, text, page and image", () => {
    expect(meta.openGraph).toMatchObject({
      type: "website",
      siteName: "Tableside",
      title: "Privacy policy — Tableside",
      description: "What Tableside collects.",
      url: "/privacy",
      images: [DEFAULT_SHARE_IMAGE],
    });
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Privacy policy — Tableside",
      images: [DEFAULT_SHARE_IMAGE.url],
    });
  });

  it("uses a page's own image when given", () => {
    const image = { url: "https://cdn.example/cover.jpg", alt: "Nashta" };
    const withImage = publicPageMetadata({
      title: "t",
      description: "d",
      path: "/r/x",
      image,
    });
    expect(withImage.openGraph?.images).toEqual([image]);
  });

  it("private pages are not to be listed", () => {
    expect(PRIVATE_PAGE_ROBOTS).toEqual({ index: false, follow: false });
  });
});

const base = {
  name: "Nashta",
  description: null,
  city: null,
  state: null,
  coverImageUrl: null,
};

describe("restaurant text", () => {
  it("uses the restaurant's own description first", () => {
    expect(
      restaurantDescription({
        ...base,
        description: "  Vegetarian street food.  ",
      }),
    ).toBe("Vegetarian street food.");
  });

  it("otherwise says only its name and, if known, its town", () => {
    expect(restaurantDescription(base)).toBe("The menu at Nashta.");
    expect(
      restaurantDescription({ ...base, city: "Edison", state: "NJ" }),
    ).toBe("The menu at Nashta in Edison, NJ.");
  });

  it("uses the cover photo only when there is one", () => {
    expect(restaurantShareImage(base)).toBeUndefined();
    expect(
      restaurantShareImage({ ...base, coverImageUrl: "https://x/c.jpg" }),
    ).toEqual({ url: "https://x/c.jpg", alt: "Nashta" });
  });
});

describe("trimForSnippet", () => {
  it("leaves short text alone and tidies spaces", () => {
    expect(trimForSnippet("A  short\n line.")).toBe("A short line.");
  });

  it("cuts long text at a word, under the limit", () => {
    const long = "word ".repeat(60);
    const out = trimForSnippet(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});
