import { describe, expect, it } from "vitest";
import {
  publishedUrl,
  resolveDinerImage,
  type ResolveInput,
} from "@/lib/menu-images/resolve";

/**
 * The rules a diner's view depends on. Two matter more than the rest: only
 * a published image renders, and a removed photo never comes back through
 * the legacy image_url column that phase 1 deliberately leaves in place.
 */

const SUPABASE = "https://project.supabase.co";
const PREFIX = "rest-1/dish-1/img-1";
const IMAGE_ID = "33333333-3333-4333-8333-333333333333";

const VARIANTS = {
  small: `${PREFIX}/small.webp`,
  medium: `${PREFIX}/medium.webp`,
  large: `${PREFIX}/large.webp`,
};

function resolve(over: Partial<ResolveInput> = {}) {
  return resolveDinerImage({
    activeImageId: null,
    imageSource: null,
    imageVariants: null,
    legacyImageUrl: null,
    supabaseUrl: SUPABASE,
    ...over,
  });
}

/** A dish with a published, processed restaurant photo. */
function published(over: Partial<ResolveInput> = {}) {
  return resolve({
    activeImageId: IMAGE_ID,
    imageSource: "real",
    imageVariants: VARIANTS,
    ...over,
  });
}

describe("resolveDinerImage", () => {
  it("renders a published photo with a full srcset, smallest first", () => {
    const image = published();

    expect(image).not.toBeNull();
    expect(image!.srcSet).toBe(
      [
        `${publishedUrl(SUPABASE, VARIANTS.small)} 400w`,
        `${publishedUrl(SUPABASE, VARIANTS.medium)} 800w`,
        `${publishedUrl(SUPABASE, VARIANTS.large)} 1600w`,
      ].join(", "),
    );
    // A browser ignoring srcset gets the middle size, not the 1600px file.
    expect(image!.src).toBe(publishedUrl(SUPABASE, VARIANTS.medium));
  });

  it("serves published objects from the public bucket, never the private one", () => {
    const image = published();
    expect(image!.src).toContain("/storage/v1/object/public/menu-photos/");
    expect(image!.srcSet).not.toContain("menu-photos-private");
  });

  it("copes with a source that produced only a small variant", () => {
    const image = published({ imageVariants: { small: VARIANTS.small } });
    expect(image!.srcSet).toBe(
      `${publishedUrl(SUPABASE, VARIANTS.small)} 400w`,
    );
    expect(image!.src).toBe(publishedUrl(SUPABASE, VARIANTS.small));
  });

  it("ignores a variant name phase 2 does not produce", () => {
    const image = published({
      imageVariants: { small: VARIANTS.small, huge: `${PREFIX}/huge.webp` },
    });
    expect(image!.srcSet).not.toContain("huge");
  });

  it("tolerates a trailing slash on the Supabase URL", () => {
    const image = published({ supabaseUrl: `${SUPABASE}/` });
    expect(image!.src).not.toContain("//storage");
  });

  describe("only a published image is diner-facing", () => {
    it("shows nothing when there is no active image", () => {
      // The pointer is set only by publish_menu_item_image() and cleared
      // only by remove_menu_item_image(), so pending, rejected, failed and
      // superseded images are all covered by this one case.
      expect(resolve()).toBeNull();
    });

    it("does not show a replacement that is still awaiting review", () => {
      // The dish still points at the OLD image while a replacement sits in
      // pending_review, so the old one renders and the new one does not.
      const image = published();
      expect(image!.src).toBe(publishedUrl(SUPABASE, VARIANTS.medium));
    });

    it("shows nothing when the pointer is cleared, even with variants left behind", () => {
      expect(
        resolve({ activeImageId: null, imageVariants: VARIANTS }),
      ).toBeNull();
    });
  });

  describe("the legacy image_url column", () => {
    it("does NOT resurrect a removed photo", () => {
      // remove_menu_item_image() clears the pointer and deliberately leaves
      // image_url in place. Falling back to it would put the photo the
      // owner just took down straight back on the menu.
      expect(
        resolve({
          activeImageId: null,
          legacyImageUrl: "https://restaurant.example/dish.jpg",
        }),
      ).toBeNull();
    });

    it("renders a backfilled legacy image, which has a pointer but no variants", () => {
      const image = resolve({
        activeImageId: IMAGE_ID,
        imageSource: "unverified",
        imageVariants: null,
        legacyImageUrl: "https://restaurant.example/dish.jpg",
      });
      expect(image!.src).toBe("https://restaurant.example/dish.jpg");
      expect(image!.srcSet).toBe("");
      expect(image!.unverified).toBe(true);
    });

    it("is ignored once a processed photo has been published", () => {
      const image = published({
        legacyImageUrl: "https://restaurant.example/old.jpg",
      });
      expect(image!.src).toContain("menu-photos");
      expect(image!.src).not.toContain("restaurant.example");
    });
  });

  describe("provenance", () => {
    it("marks an AI-generated image for labelling", () => {
      const image = published({ imageSource: "ai_generated" });
      expect(image!.aiGenerated).toBe(true);
      expect(image!.unverified).toBe(false);
    });

    it("marks a restaurant's own photo as neither", () => {
      const image = published({ imageSource: "real" });
      expect(image!.aiGenerated).toBe(false);
      expect(image!.unverified).toBe(false);
    });

    it("treats a confirmed legacy image as a real photo", () => {
      const image = resolve({
        activeImageId: IMAGE_ID,
        imageSource: "real",
        imageVariants: null,
        legacyImageUrl: "https://restaurant.example/old.jpg",
      });
      expect(image!.unverified).toBe(false);
      expect(image!.src).toBe("https://restaurant.example/old.jpg");
    });
  });

  it("shows nothing rather than a broken image when there is nothing to show", () => {
    expect(
      resolve({
        activeImageId: IMAGE_ID,
        imageSource: "real",
        imageVariants: null,
        legacyImageUrl: null,
      }),
    ).toBeNull();
  });

  it("ignores a non-string variant value", () => {
    const image = published({
      imageVariants: {
        small: VARIANTS.small,
        medium: null as unknown as string,
      },
    });
    expect(image!.srcSet).toBe(
      `${publishedUrl(SUPABASE, VARIANTS.small)} 400w`,
    );
  });
});
