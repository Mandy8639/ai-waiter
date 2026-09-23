// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadOwnerPhotoState } from "@/lib/menu-images/owner-state";

/**
 * What the owner's photo panel is told about a dish.
 *
 * The important property is that "what diners see now" is decided by the
 * same resolver the diner pages use, so the owner is never shown a photo
 * as live that a diner cannot see, or vice versa.
 */

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const DISH = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";
const SUPABASE = "https://project.supabase.co";

const VARIANTS = {
  small: `${RESTAURANT}/${DISH}/${IMAGE}/small.webp`,
  medium: `${RESTAURANT}/${DISH}/${IMAGE}/medium.webp`,
};

/** A stub shaped like the two queries loadOwnerPhotoState makes. */
function supabaseStub(
  item: Record<string, unknown> | null,
  images: Array<Record<string, unknown>>,
) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: item }),
            order: async () => ({
              data: table === "menu_item_images" ? images : [],
            }),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof loadOwnerPhotoState>[0];
}

function load(
  item: Record<string, unknown> | null,
  images: Array<Record<string, unknown>> = [],
) {
  return loadOwnerPhotoState(
    supabaseStub(item, images),
    RESTAURANT,
    DISH,
    SUPABASE,
  );
}

const publishedItem = {
  active_image_id: IMAGE,
  image_source: "real",
  image_variants: VARIANTS,
  image_url: null,
};

describe("loadOwnerPhotoState", () => {
  it("reports no photo for a dish that has never had one", async () => {
    const state = await load({
      active_image_id: null,
      image_source: null,
      image_variants: null,
      image_url: null,
    });
    expect(state).toEqual({ current: null, pending: null, failed: null });
  });

  it("reports the published photo diners see", async () => {
    const state = await load(publishedItem);
    expect(state.current).toMatchObject({
      imageId: IMAGE,
      unverified: false,
      aiGenerated: false,
    });
    expect(state.current!.src).toContain("/public/menu-photos/");
    expect(state.pending).toBeNull();
  });

  it("surfaces a photo waiting to be accepted", async () => {
    const pendingId = "44444444-4444-4444-8444-444444444444";
    const state = await load(publishedItem, [
      { id: pendingId, status: "pending_review", error: null },
      { id: IMAGE, status: "active", error: null },
    ]);

    expect(state.pending).toEqual({ imageId: pendingId });
    // The published photo is still the one diners see — that is the whole
    // point of the review step.
    expect(state.current!.imageId).toBe(IMAGE);
  });

  it("does not resurrect a removed photo from the legacy column", async () => {
    const state = await load(
      {
        active_image_id: null,
        image_source: null,
        image_variants: null,
        image_url: "https://restaurant.example/old.jpg",
      },
      [{ id: IMAGE, status: "removed", error: null }],
    );
    expect(state.current).toBeNull();
  });

  it("marks a backfilled legacy image as not yet confirmed", async () => {
    const state = await load({
      active_image_id: IMAGE,
      image_source: "unverified",
      image_variants: null,
      image_url: "https://restaurant.example/dish.jpg",
    });
    expect(state.current).toMatchObject({
      unverified: true,
      src: "https://restaurant.example/dish.jpg",
    });
  });

  it("marks an AI-generated active image", async () => {
    const state = await load({
      ...publishedItem,
      image_source: "ai_generated",
    });
    expect(state.current!.aiGenerated).toBe(true);
  });

  it("reports the last failure so the owner learns why nothing appeared", async () => {
    const state = await load(publishedItem, [
      {
        id: "55555555-5555-4555-8555-555555555555",
        status: "failed",
        error: "That image is damaged or incomplete.",
      },
    ]);
    expect(state.failed).toEqual({
      imageId: "55555555-5555-4555-8555-555555555555",
      error: "That image is damaged or incomplete.",
    });
  });

  it("hides an old failure once a newer photo is waiting", async () => {
    const state = await load(publishedItem, [
      {
        id: "66666666-6666-4666-8666-666666666666",
        status: "pending_review",
        error: null,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        status: "failed",
        error: "broken",
      },
    ]);
    expect(state.failed).toBeNull();
    expect(state.pending).not.toBeNull();
  });

  it("returns an empty state for a dish the caller cannot see", async () => {
    // RLS makes another restaurant's dish absent rather than forbidden.
    const state = await load(null, []);
    expect(state.current).toBeNull();
  });

  it("ignores superseded and rejected rows entirely", async () => {
    const state = await load(publishedItem, [
      {
        id: "77777777-7777-4777-8777-777777777777",
        status: "superseded",
        error: null,
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        status: "rejected",
        error: null,
      },
    ]);
    expect(state.pending).toBeNull();
    expect(state.failed).toBeNull();
    expect(state.current!.imageId).toBe(IMAGE);
  });
});

describe("the owner panel cannot publish by accident", () => {
  it("only ever reports a pending photo, never activates one", async () => {
    // loadOwnerPhotoState is a read. Publishing is a separate explicit
    // action, and this test exists so that stays true.
    const source = (await import("node:fs")).readFileSync(
      "src/lib/menu-images/owner-state.ts",
      "utf8",
    );
    expect(source).not.toContain("publish");
    expect(source).not.toContain("rpc(");
  });
});

describe("preview of a pending photo", () => {
  it("never builds a public URL for private material", async () => {
    const actions = (await import("node:fs")).readFileSync(
      "src/lib/menu-images/actions.ts",
      "utf8",
    );
    // The preview goes through createSignedUrl on the bucket the image's
    // status implies, not through the public URL helper.
    expect(actions).toContain("createSignedUrl");
    expect(actions).toContain("bucketForVariants");
    expect(actions).not.toContain("object/public");
  });
});

vi.mock("server-only", () => ({}));
