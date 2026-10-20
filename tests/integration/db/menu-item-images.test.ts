// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  fullRestaurantFixture,
} from "./helpers";

/**
 * Menu photos, phase 1 (supabase/migrations/20260919100000_menu_item_images.sql).
 *
 * The properties that matter, in order:
 *   1. A diner-facing "AI-generated" label can't be removed by accident or
 *      on purpose — source is stored, and only the image functions write it.
 *   2. The current image is never lost before its replacement is published.
 *   3. AI generation attempts are capped in the database, counting
 *      attempts rather than successes.
 *   4. Only owners and managers of the dish's own restaurant can do any of it.
 */
describe("menu item images", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    // Production allows 300 a day (20261103090000); the cap's behaviour is
    // tested at 10 so the fixtures stay small.
    await db.admin.query(
      "update public.menu_image_generation_limits set attempts_per_restaurant_per_day = 10 where id;",
    );
  });

  it("allows 300 generations per restaurant per day in production", async () => {
    const fresh = await createTestDb();
    try {
      const { rows } = await fresh.admin.query<{ n: number }>(
        "select attempts_per_restaurant_per_day as n from public.menu_image_generation_limits;",
      );
      expect(rows[0].n).toBe(300);
    } finally {
      await fresh.close();
    }
  });

  afterAll(async () => {
    await db.close();
  });

  const variants = (restaurantId: string, itemId: string, imageId: string) => ({
    card: `${restaurantId}/${itemId}/${imageId}/card.webp`,
    detail: `${restaurantId}/${itemId}/${imageId}/detail.webp`,
  });

  async function beginUpload(userId: string, itemId: string): Promise<string> {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "select public.begin_menu_item_image_upload($1) as id;",
        [itemId],
      ),
    );
    return rows[0].id;
  }

  async function beginGeneration(
    userId: string,
    itemId: string,
  ): Promise<string> {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "select public.begin_menu_item_image_generation($1) as id;",
        [itemId],
      ),
    );
    return rows[0].id;
  }

  async function complete(
    userId: string,
    restaurantId: string,
    itemId: string,
    imageId: string,
    generation: object | null = null,
  ): Promise<void> {
    await db.asUser(userId, (c) =>
      c.query(
        "select public.complete_menu_item_image($1, $2, $3, 1200, 900, 150000, 'image/webp', 'abc', $4);",
        [
          imageId,
          `${restaurantId}/${itemId}/${imageId}/original`,
          JSON.stringify(variants(restaurantId, itemId, imageId)),
          generation === null ? null : JSON.stringify(generation),
        ],
      ),
    );
  }

  async function publish(userId: string, imageId: string): Promise<void> {
    await db.asUser(userId, (c) =>
      c.query("select public.publish_menu_item_image($1);", [imageId]),
    );
  }

  async function itemImage(itemId: string) {
    const { rows } = await db.admin.query<{
      active_image_id: string | null;
      image_source: string | null;
      image_variants: Record<string, string> | null;
      image_url: string | null;
    }>(
      "select active_image_id, image_source, image_variants, image_url from public.menu_items where id = $1;",
      [itemId],
    );
    return rows[0];
  }

  async function imageStatus(imageId: string): Promise<string> {
    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.menu_item_images where id = $1;",
      [imageId],
    );
    return rows[0].status;
  }

  /**
   * The attempt ledger is append-only for every role, the admin included,
   * so a test that needs "yesterday's" attempts switches that one trigger
   * off for exactly this update — visibly, here, rather than weakening it.
   */
  async function backdateAttempts(
    where: string,
    params: unknown[],
    interval: string,
  ): Promise<void> {
    await db.admin.exec(
      "alter table public.menu_image_generation_attempts disable trigger trg_menu_image_generation_attempts_append_only;",
    );
    try {
      await db.admin.query(
        `update public.menu_image_generation_attempts set started_at = now() - interval '${interval}' where ${where};`,
        params,
      );
    } finally {
      await db.admin.exec(
        "alter table public.menu_image_generation_attempts enable trigger trg_menu_image_generation_attempts_append_only;",
      );
    }
  }

  const aiMetadata = {
    provider: "openrouter",
    model: "recraft/recraft-v3:free",
    prompt_version: 1,
    input_hash: "hash",
  };

  describe("real photo lifecycle", () => {
    it("goes from no image to a published restaurant photo", async () => {
      const f = await fullRestaurantFixture(db);
      expect((await itemImage(f.menuItemId)).active_image_id).toBeNull();

      const imageId = await beginUpload(f.userId, f.menuItemId);
      expect(await imageStatus(imageId)).toBe("uploading");
      // Nothing visible to diners until it is published.
      expect((await itemImage(f.menuItemId)).active_image_id).toBeNull();

      await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
      expect(await imageStatus(imageId)).toBe("pending_review");
      expect((await itemImage(f.menuItemId)).active_image_id).toBeNull();

      await publish(f.userId, imageId);
      const item = await itemImage(f.menuItemId);
      expect(item.active_image_id).toBe(imageId);
      expect(item.image_source).toBe("real");
      expect(item.image_variants).toEqual(
        variants(f.restaurantId, f.menuItemId, imageId),
      );
    });

    it("keeps the current photo until the replacement is published", async () => {
      const f = await fullRestaurantFixture(db);
      const first = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, first);
      await publish(f.userId, first);

      const second = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, second);
      // Uploaded and processed, but not yet chosen: the first is still live.
      expect((await itemImage(f.menuItemId)).active_image_id).toBe(first);
      expect(await imageStatus(first)).toBe("active");

      await publish(f.userId, second);
      expect((await itemImage(f.menuItemId)).active_image_id).toBe(second);
      expect(await imageStatus(first)).toBe("superseded");

      const { rows } = await db.admin.query<{ count: number }>(
        "select count(*)::int as count from public.menu_item_images where menu_item_id = $1 and status = 'active';",
        [f.menuItemId],
      );
      expect(rows[0].count).toBe(1);
    });

    it("leaves the current photo untouched when an upload fails or is rejected", async () => {
      const f = await fullRestaurantFixture(db);
      const live = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, live);
      await publish(f.userId, live);

      const failed = await beginUpload(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'Not a photo.');", [
          failed,
        ]),
      );
      const rejected = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, rejected);
      await db.asUser(f.userId, (c) =>
        c.query("select public.reject_menu_item_image($1);", [rejected]),
      );

      expect(await imageStatus(failed)).toBe("failed");
      expect(await imageStatus(rejected)).toBe("rejected");
      expect((await itemImage(f.menuItemId)).active_image_id).toBe(live);
      expect(await imageStatus(live)).toBe("active");
    });

    it("refuses to publish anything that has not been reviewed", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await expect(publish(f.userId, imageId)).rejects.toThrow(
        /MENU_IMAGE_INVALID_STATE/,
      );
    });

    it("removes the active image, keeping the row for retention", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
      await publish(f.userId, imageId);

      await db.asUser(f.userId, (c) =>
        c.query("select public.remove_menu_item_image($1);", [f.menuItemId]),
      );
      const item = await itemImage(f.menuItemId);
      expect(item.active_image_id).toBeNull();
      expect(item.image_source).toBeNull();
      expect(await imageStatus(imageId)).toBe("removed");
    });

    it("records when a row changed status, for the 30-day retention window", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await db.admin.query(
        "update public.menu_item_images set status_changed_at = now() - interval '40 days' where id = $1;",
        [imageId],
      );
      await db.asUser(f.userId, (c) =>
        c.query("select public.reject_menu_item_image($1);", [imageId]),
      );
      const { rows } = await db.admin.query<{ recent: boolean }>(
        "select status_changed_at > now() - interval '1 minute' as recent from public.menu_item_images where id = $1;",
        [imageId],
      );
      expect(rows[0].recent).toBe(true);
    });
  });

  describe("paths", () => {
    it("refuses files outside the image's own folder", async () => {
      const f = await fullRestaurantFixture(db);
      const other = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);

      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "select public.complete_menu_item_image($1, $2, $3, 10, 10, 10, 'image/webp', 'x');",
            [
              imageId,
              `${other.restaurantId}/${f.menuItemId}/${imageId}/original`,
              JSON.stringify(variants(f.restaurantId, f.menuItemId, imageId)),
            ],
          ),
        ),
      ).rejects.toThrow(/MENU_IMAGE_INVALID_PATH/);

      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "select public.complete_menu_item_image($1, $2, $3, 10, 10, 10, 'image/webp', 'x');",
            [
              imageId,
              `${f.restaurantId}/${f.menuItemId}/${imageId}/original`,
              JSON.stringify({
                card: `${other.restaurantId}/x/${imageId}/card.webp`,
              }),
            ],
          ),
        ),
      ).rejects.toThrow(/MENU_IMAGE_INVALID_PATH/);
    });
  });

  describe("AI-generated images", () => {
    it("are published only after review, and stay labelled ai_generated", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginGeneration(f.userId, f.menuItemId);
      expect(await imageStatus(imageId)).toBe("generating");

      await complete(
        f.userId,
        f.restaurantId,
        f.menuItemId,
        imageId,
        aiMetadata,
      );
      expect((await itemImage(f.menuItemId)).active_image_id).toBeNull();

      await publish(f.userId, imageId);
      expect((await itemImage(f.menuItemId)).image_source).toBe("ai_generated");
    });

    it("require provider and model metadata before review", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginGeneration(f.userId, f.menuItemId);
      await expect(
        complete(f.userId, f.restaurantId, f.menuItemId, imageId, null),
      ).rejects.toThrow(/MENU_IMAGE_GENERATION_METADATA_REQUIRED/);
    });

    it("refuse generation metadata on a real photo", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await expect(
        complete(f.userId, f.restaurantId, f.menuItemId, imageId, aiMetadata),
      ).rejects.toThrow(/MENU_IMAGE_GENERATION_METADATA_NOT_ALLOWED/);
    });

    it("are replaced by a real photo only when the real photo is published", async () => {
      const f = await fullRestaurantFixture(db);
      const ai = await beginGeneration(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, ai, aiMetadata);
      await publish(f.userId, ai);

      const real = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, real);
      expect((await itemImage(f.menuItemId)).image_source).toBe("ai_generated");

      await publish(f.userId, real);
      expect((await itemImage(f.menuItemId)).image_source).toBe("real");
      expect(await imageStatus(ai)).toBe("superseded");
    });

    it("can never be confirmed as a restaurant photo", async () => {
      const f = await fullRestaurantFixture(db);
      const ai = await beginGeneration(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, ai, aiMetadata);
      await publish(f.userId, ai);

      await expect(
        db.asUser(f.userId, (c) =>
          c.query("select public.confirm_menu_item_image_authentic($1);", [
            f.menuItemId,
          ]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_NOT_UNVERIFIED/);
      expect((await itemImage(f.menuItemId)).image_source).toBe("ai_generated");
    });
  });

  describe("generation limits", () => {
    it("allows one pending generation per dish", async () => {
      const f = await fullRestaurantFixture(db);
      await beginGeneration(f.userId, f.menuItemId);
      await expect(beginGeneration(f.userId, f.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_GENERATION_PENDING_EXISTS/,
      );
    });

    it("allows 2 attempts per dish per day, counting failures", async () => {
      const f = await fullRestaurantFixture(db);
      const first = await beginGeneration(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'Provider error.');", [
          first,
        ]),
      );
      const second = await beginGeneration(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.reject_menu_item_image($1);", [second]),
      );
      // Both ended without an image, and both still count.
      await expect(beginGeneration(f.userId, f.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_GENERATION_ITEM_LIMIT/,
      );
    });

    it("allows 10 attempts per restaurant per day", async () => {
      const f = await fullRestaurantFixture(db);
      const items: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        items.push(await createMenuItem(db, f.restaurantId, f.categoryId));
      }
      let started = 0;
      for (const itemId of items) {
        for (let attempt = 0; attempt < 2 && started < 10; attempt += 1) {
          const id = await beginGeneration(f.userId, itemId);
          await db.asUser(f.userId, (c) =>
            c.query("select public.fail_menu_item_image($1, 'x');", [id]),
          );
          started += 1;
        }
      }
      expect(started).toBe(10);
      await expect(beginGeneration(f.userId, items[5])).rejects.toThrow(
        /MENU_IMAGE_GENERATION_RESTAURANT_LIMIT/,
      );

      const { rows } = await db.asUser(f.userId, (c) =>
        c.query<{ restaurant_attempts: number; restaurant_limit: number }>(
          "select * from public.get_menu_image_generation_quota($1);",
          [f.restaurantId],
        ),
      );
      expect(rows[0].restaurant_attempts).toBe(10);
      expect(rows[0].restaurant_limit).toBe(10);
    });

    it("forgets attempts older than 24 hours", async () => {
      const f = await fullRestaurantFixture(db);
      const a = await beginGeneration(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'x');", [a]),
      );
      const b = await beginGeneration(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'x');", [b]),
      );
      await backdateAttempts("menu_item_id = $1", [f.menuItemId], "25 hours");
      await expect(
        beginGeneration(f.userId, f.menuItemId),
      ).resolves.toBeTruthy();
    });

    it("frees a slot held by a generation that timed out, but still counts it", async () => {
      const f = await fullRestaurantFixture(db);
      const stuck = await beginGeneration(f.userId, f.menuItemId);
      await db.admin.query(
        "update public.menu_item_images set created_at = now() - interval '10 minutes' where id = $1;",
        [stuck],
      );

      const next = await beginGeneration(f.userId, f.menuItemId);
      expect(next).not.toBe(stuck);
      expect(await imageStatus(stuck)).toBe("failed");
      // Two attempts used: the timed-out one and this one.
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'x');", [next]),
      );
      await expect(beginGeneration(f.userId, f.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_GENERATION_ITEM_LIMIT/,
      );
    });

    it("reads its limits from the configuration row", async () => {
      const f = await fullRestaurantFixture(db);
      await db.admin.query(
        "update public.menu_image_generation_limits set attempts_per_item_per_day = 1;",
      );
      try {
        const id = await beginGeneration(f.userId, f.menuItemId);
        await db.asUser(f.userId, (c) =>
          c.query("select public.fail_menu_item_image($1, 'x');", [id]),
        );
        await expect(beginGeneration(f.userId, f.menuItemId)).rejects.toThrow(
          /MENU_IMAGE_GENERATION_ITEM_LIMIT/,
        );
      } finally {
        await db.admin.query(
          "update public.menu_image_generation_limits set attempts_per_item_per_day = 2;",
        );
      }
    });
  });

  describe("permissions and tenant isolation", () => {
    it.each(["kitchen", "staff"] as const)(
      "refuses a %s member",
      async (role) => {
        const f = await fullRestaurantFixture(db);
        const member = await db.createAuthUser();
        await addMember(db, f.restaurantId, member, role);
        await expect(beginUpload(member, f.menuItemId)).rejects.toThrow(
          /MENU_IMAGE_FORBIDDEN/,
        );
        await expect(beginGeneration(member, f.menuItemId)).rejects.toThrow(
          /MENU_IMAGE_FORBIDDEN/,
        );
      },
    );

    it("lets a manager do everything an owner can", async () => {
      const f = await fullRestaurantFixture(db);
      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");
      const imageId = await beginUpload(manager, f.menuItemId);
      await complete(manager, f.restaurantId, f.menuItemId, imageId);
      await publish(manager, imageId);
      expect((await itemImage(f.menuItemId)).image_source).toBe("real");
    });

    it("refuses an owner of a different restaurant, for every action", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      const imageId = await beginUpload(a.userId, a.menuItemId);
      await complete(a.userId, a.restaurantId, a.menuItemId, imageId);

      await expect(beginUpload(b.userId, a.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_FORBIDDEN/,
      );
      await expect(publish(b.userId, imageId)).rejects.toThrow(
        /MENU_IMAGE_FORBIDDEN/,
      );
      await expect(
        db.asUser(b.userId, (c) =>
          c.query("select public.reject_menu_item_image($1);", [imageId]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_FORBIDDEN/);
      await expect(
        db.asUser(b.userId, (c) =>
          c.query("select * from public.get_menu_image_generation_quota($1);", [
            a.restaurantId,
          ]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_FORBIDDEN/);
    });

    it("refuses an anonymous caller", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asAnon((c) =>
          c.query("select public.begin_menu_item_image_upload($1);", [
            f.menuItemId,
          ]),
        ),
      ).rejects.toThrow();
    });

    it("hides image rows from other restaurants and from diners", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await beginUpload(a.userId, a.menuItemId);

      const own = await db.asUser(a.userId, (c) =>
        c.query(
          "select id from public.menu_item_images where restaurant_id = $1;",
          [a.restaurantId],
        ),
      );
      expect(own.rows.length).toBeGreaterThan(0);

      const foreign = await db.asUser(b.userId, (c) =>
        c.query(
          "select id from public.menu_item_images where restaurant_id = $1;",
          [a.restaurantId],
        ),
      );
      expect(foreign.rows).toHaveLength(0);

      const anon = await db.asAnon((c) =>
        c.query("select id from public.menu_item_images;"),
      );
      expect(anon.rows).toHaveLength(0);
    });

    it("rejects an image row pointing at another restaurant's dish, even for the admin", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await expect(
        db.admin.query(
          "insert into public.menu_item_images (restaurant_id, menu_item_id, source, status) values ($1, $2, 'real', 'uploading');",
          [a.restaurantId, b.menuItemId],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("rejects pointing a dish at another dish's image, even for the admin", async () => {
      const f = await fullRestaurantFixture(db);
      const otherItem = await createMenuItem(
        db,
        f.restaurantId,
        await createCategory(db, f.restaurantId),
      );
      const imageId = await beginUpload(f.userId, otherItem);
      await expect(
        db.admin.query(
          "update public.menu_items set active_image_id = $1, image_source = 'real' where id = $2;",
          [imageId, f.menuItemId],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe("no direct writes", () => {
    it("stops an owner relabelling an AI image through the ordinary menu update", async () => {
      const f = await fullRestaurantFixture(db);
      const ai = await beginGeneration(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, ai, aiMetadata);
      await publish(f.userId, ai);

      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "update public.menu_items set image_source = 'real' where id = $1;",
            [f.menuItemId],
          ),
        ),
      ).rejects.toThrow(/MENU_ITEM_IMAGE_COLUMNS_READ_ONLY/);
      expect((await itemImage(f.menuItemId)).image_source).toBe("ai_generated");
    });

    it("still allows every other menu edit", async () => {
      const f = await fullRestaurantFixture(db);
      await db.asUser(f.userId, (c) =>
        c.query("update public.menu_items set price = 12.5 where id = $1;", [
          f.menuItemId,
        ]),
      );
      const { rows } = await db.admin.query<{ price: string }>(
        "select price from public.menu_items where id = $1;",
        [f.menuItemId],
      );
      expect(Number(rows[0].price)).toBe(12.5);
    });

    it("stops a new dish being created with image columns set", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "insert into public.menu_items (restaurant_id, category_id, name, slug, price, image_source) values ($1, $2, 'Sneaky', 'sneaky', 1, 'real');",
            [f.restaurantId, f.categoryId],
          ),
        ),
      ).rejects.toThrow();
    });

    it("gives an owner no way to write image rows directly", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "insert into public.menu_item_images (restaurant_id, menu_item_id, source, status) values ($1, $2, 'real', 'uploading');",
            [f.restaurantId, f.menuItemId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      const ai = await beginGeneration(f.userId, f.menuItemId);
      const result = await db.asUser(f.userId, (c) =>
        c.query(
          "update public.menu_item_images set source = 'real' where id = $1;",
          [ai],
        ),
      );
      // No update policy: the row is simply not updatable, so nothing changes.
      expect(result.affectedRows ?? 0).toBe(0);
      const { rows } = await db.admin.query<{ source: string }>(
        "select source from public.menu_item_images where id = $1;",
        [ai],
      );
      expect(rows[0].source).toBe("ai_generated");
    });
  });

  describe("legacy image URLs", () => {
    it("become unverified images, not restaurant photos, and keep their URL", async () => {
      const f = await fullRestaurantFixture(db);
      await db.admin.query(
        "update public.menu_items set image_url = 'https://example.com/dosa.jpg' where id = $1;",
        [f.menuItemId],
      );

      const { rows: first } = await db.admin.query<{ n: number }>(
        "select public.backfill_legacy_menu_item_images() as n;",
      );
      expect(first[0].n).toBeGreaterThanOrEqual(1);

      const item = await itemImage(f.menuItemId);
      expect(item.image_source).toBe("unverified");
      expect(item.image_url).toBe("https://example.com/dosa.jpg");

      // Idempotent: a second run adds nothing for this dish.
      await db.admin.query("select public.backfill_legacy_menu_item_images();");
      const { rows: count } = await db.admin.query<{ n: number }>(
        "select count(*)::int as n from public.menu_item_images where menu_item_id = $1;",
        [f.menuItemId],
      );
      expect(count[0].n).toBe(1);
    });

    it("become restaurant photos only when an owner confirms", async () => {
      const f = await fullRestaurantFixture(db);
      await db.admin.query(
        "update public.menu_items set image_url = 'https://example.com/x.jpg' where id = $1;",
        [f.menuItemId],
      );
      await db.admin.query("select public.backfill_legacy_menu_item_images();");

      await db.asUser(f.userId, (c) =>
        c.query("select public.confirm_menu_item_image_authentic($1);", [
          f.menuItemId,
        ]),
      );
      expect((await itemImage(f.menuItemId)).image_source).toBe("real");

      const { rows } = await db.admin.query<{
        confirmed_by: string;
        confirmed_at: string | null;
      }>(
        "select confirmed_by, confirmed_at from public.menu_item_images where menu_item_id = $1;",
        [f.menuItemId],
      );
      expect(rows[0].confirmed_by).toBe(f.userId);
      expect(rows[0].confirmed_at).not.toBeNull();

      // Once real, there is nothing left to confirm.
      await expect(
        db.asUser(f.userId, (c) =>
          c.query("select public.confirm_menu_item_image_authentic($1);", [
            f.menuItemId,
          ]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_NOT_UNVERIFIED/);
    });

    it("cannot be run by a signed-in user", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asUser(f.userId, (c) =>
          c.query("select public.backfill_legacy_menu_item_images();"),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("deletion", () => {
    it("removes a dish's images with the dish", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
      await publish(f.userId, imageId);

      await db.admin.query("delete from public.menu_items where id = $1;", [
        f.menuItemId,
      ]);
      const { rows } = await db.admin.query(
        "select 1 from public.menu_item_images where id = $1;",
        [imageId],
      );
      expect(rows).toHaveLength(0);
    });
  });
  describe("function EXECUTE grants (Supabase default privileges mirrored)", () => {
    // Every function this migration creates, by kind. The harness applies
    // Supabase's default privileges (EXECUTE to anon/authenticated/
    // service_role on every new public function), so a missing revoke shows
    // up here as a privilege, exactly as it would on the live project.
    const PUBLIC_API = [
      "begin_menu_item_image_upload",
      "begin_menu_item_image_generation",
      "complete_menu_item_image",
      "fail_menu_item_image",
      "publish_menu_item_image",
      "reject_menu_item_image",
      "remove_menu_item_image",
      "confirm_menu_item_image_authentic",
      "get_menu_image_generation_quota",
    ];
    const INTERNAL = [
      "menu_image_authorize_item",
      "menu_image_authorize_image",
      "menu_image_expire_stale_generations",
      "menu_image_path_is_valid",
      "backfill_legacy_menu_item_images",
    ];

    async function privileges() {
      const { rows } = await db.admin.query<{
        name: string;
        anon: boolean;
        authenticated: boolean;
        is_trigger: boolean;
      }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                p.prorettype = 'trigger'::regtype as is_trigger
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname like '%menu_image%'
             or p.proname like '%menu_item_image%'
             or p.proname like 'menu_items_guard_image%'
             or p.proname = 'backfill_legacy_menu_item_images');`,
      );
      return rows;
    }

    it("classifies every function the migration creates", async () => {
      const rows = await privileges();
      const callable = rows.filter((r) => !r.is_trigger).map((r) => r.name);
      expect(new Set(callable)).toEqual(new Set([...PUBLIC_API, ...INTERNAL]));
    });

    it("gives anon no API function at all", async () => {
      const rows = await privileges();
      expect(rows.filter((r) => !r.is_trigger && r.anon)).toEqual([]);
    });

    it("gives authenticated exactly the public API, and no internal helper", async () => {
      const rows = await privileges();
      const granted = rows
        .filter((r) => !r.is_trigger && r.authenticated)
        .map((r) => r.name)
        .sort();
      expect(granted).toEqual([...PUBLIC_API].sort());
    });

    it.each([
      ["menu_image_authorize_item($1)", "item"],
      ["menu_image_authorize_image($1)", "image"],
      ["menu_image_expire_stale_generations($1)", "restaurant"],
      ["backfill_legacy_menu_item_images()", "none"],
      ["menu_image_path_is_valid('a', 'a')", "none"],
    ])(
      "refuses internal %s to anon and to a signed-in owner",
      async (call, arg) => {
        const f = await fullRestaurantFixture(db);
        const imageId = await beginUpload(f.userId, f.menuItemId);
        const params =
          arg === "item"
            ? [f.menuItemId]
            : arg === "image"
              ? [imageId]
              : arg === "restaurant"
                ? [f.restaurantId]
                : [];
        await expect(
          db.asAnon((c) => c.query(`select public.${call};`, params)),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          db.asUser(f.userId, (c) => c.query(`select public.${call};`, params)),
        ).rejects.toThrow(/permission denied/i);
      },
    );

    it("refuses every public API function to anon at the privilege level", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asAnon((c) =>
          c.query("select public.begin_menu_item_image_upload($1);", [
            f.menuItemId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.asAnon((c) =>
          c.query("select * from public.get_menu_image_generation_quota($1);", [
            f.restaurantId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("turns away a signed-in diner (anonymous auth) inside every owner function", async () => {
      const f = await fullRestaurantFixture(db);
      const diner = await db.createAnonymousAuthUser();
      const ownerImage = await beginUpload(f.userId, f.menuItemId);
      await expect(beginUpload(diner, f.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_FORBIDDEN/,
      );
      await expect(beginGeneration(diner, f.menuItemId)).rejects.toThrow(
        /MENU_IMAGE_FORBIDDEN/,
      );
      await expect(publish(diner, ownerImage)).rejects.toThrow(
        /MENU_IMAGE_FORBIDDEN/,
      );
      await expect(
        db.asUser(diner, (c) =>
          c.query("select public.remove_menu_item_image($1);", [f.menuItemId]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_FORBIDDEN/);
      await expect(
        db.asUser(diner, (c) =>
          c.query("select * from public.get_menu_image_generation_quota($1);", [
            f.restaurantId,
          ]),
        ),
      ).rejects.toThrow(/MENU_IMAGE_FORBIDDEN/);
    });
  });

  describe("generation attempt ledger", () => {
    async function attempts(where: string, params: unknown[]) {
      const { rows } = await db.admin.query<{
        status: string;
        menu_item_id: string | null;
        image_id: string | null;
        provider: string | null;
        model: string | null;
        failure_reason: string | null;
        finished_at: string | null;
      }>(
        `select status, menu_item_id, image_id, provider, model, failure_reason, finished_at
         from public.menu_image_generation_attempts where ${where} order by started_at;`,
        params,
      );
      return rows;
    }

    it("records every outcome: succeeded, failed, cancelled, timed out", async () => {
      const f = await fullRestaurantFixture(db);
      const items = [
        f.menuItemId,
        await createMenuItem(db, f.restaurantId, f.categoryId),
        await createMenuItem(db, f.restaurantId, f.categoryId),
        await createMenuItem(db, f.restaurantId, f.categoryId),
      ];

      const ok = await beginGeneration(f.userId, items[0]);
      await complete(f.userId, f.restaurantId, items[0], ok, aiMetadata);

      const bad = await beginGeneration(f.userId, items[1]);
      await db.asUser(f.userId, (c) =>
        c.query(
          "select public.fail_menu_item_image($1, 'Provider refused.');",
          [bad],
        ),
      );

      const cancelled = await beginGeneration(f.userId, items[2]);
      await db.asUser(f.userId, (c) =>
        c.query("select public.reject_menu_item_image($1);", [cancelled]),
      );

      const stuck = await beginGeneration(f.userId, items[3]);
      await db.admin.query(
        "update public.menu_item_images set created_at = now() - interval '10 minutes' where id = $1;",
        [stuck],
      );
      // Any later attempt in the restaurant expires the stuck one.
      await beginGeneration(f.userId, items[1]);

      const byImage = async (id: string) =>
        (await attempts("image_id = $1", [id]))[0];
      expect(await byImage(ok)).toMatchObject({
        status: "succeeded",
        provider: "openrouter",
        model: "recraft/recraft-v3:free",
      });
      expect(await byImage(bad)).toMatchObject({
        status: "failed",
        failure_reason: "Provider refused.",
      });
      expect((await byImage(cancelled)).status).toBe("cancelled");
      expect((await byImage(stuck)).status).toBe("timed_out");
      for (const id of [ok, bad, cancelled, stuck]) {
        expect((await byImage(id)).finished_at).not.toBeNull();
      }
    });

    it("keeps counting after the dish is deleted: the restaurant limit never resets", async () => {
      const f = await fullRestaurantFixture(db);

      // 1. Generate repeatedly on a dish (its 2 per day), 2. delete it —
      // five times over, the way the audit's bypass did it.
      const deleted: string[] = [];
      for (let round = 0; round < 5; round += 1) {
        const item = await createMenuItem(db, f.restaurantId, f.categoryId);
        for (let i = 0; i < 2; i += 1) {
          const id = await beginGeneration(f.userId, item);
          await db.asUser(f.userId, (c) =>
            c.query("select public.fail_menu_item_image($1, 'x');", [id]),
          );
        }
        await db.asUser(f.userId, (c) =>
          c.query("delete from public.menu_items where id = $1;", [item]),
        );
        deleted.push(item);
      }

      // The evidence survives, detached from the dishes that no longer exist.
      const history = await attempts("restaurant_id = $1", [f.restaurantId]);
      expect(history).toHaveLength(10);
      expect(history.every((a) => a.menu_item_id === null)).toBe(true);
      expect(history.every((a) => a.image_id === null)).toBe(true);

      // 3. Create another dish: 4. the restaurant's 10 are still spent.
      const fresh = await createMenuItem(db, f.restaurantId, f.categoryId);
      await expect(beginGeneration(f.userId, fresh)).rejects.toThrow(
        /MENU_IMAGE_GENERATION_RESTAURANT_LIMIT/,
      );

      const { rows } = await db.asUser(f.userId, (c) =>
        c.query<{ restaurant_attempts: number; item_attempts: number }>(
          "select * from public.get_menu_image_generation_quota($1, $2);",
          [f.restaurantId, fresh],
        ),
      );
      expect(rows[0].restaurant_attempts).toBe(10);
      // A re-created dish is a new identity: its own count starts fresh.
      expect(rows[0].item_attempts).toBe(0);
    });

    it("lets a new dish use its per-dish quota while the restaurant has room", async () => {
      const f = await fullRestaurantFixture(db);
      const old = await createMenuItem(db, f.restaurantId, f.categoryId);
      for (let i = 0; i < 2; i += 1) {
        const id = await beginGeneration(f.userId, old);
        await db.asUser(f.userId, (c) =>
          c.query("select public.fail_menu_item_image($1, 'x');", [id]),
        );
      }
      await db.asUser(f.userId, (c) =>
        c.query("delete from public.menu_items where id = $1;", [old]),
      );
      const fresh = await createMenuItem(db, f.restaurantId, f.categoryId);
      await expect(beginGeneration(f.userId, fresh)).resolves.toBeTruthy();
    });

    it("cannot exceed the restaurant limit when many requests arrive at once", async () => {
      // PGlite has a single connection, so these calls are queued rather
      // than truly parallel: this proves the count-then-insert check holds
      // for a burst of requests. Real concurrency is covered by
      // begin_menu_item_image_generation() taking a row lock on the
      // restaurant before counting (each waiting transaction then counts
      // with a fresh snapshot under READ COMMITTED).
      const f = await fullRestaurantFixture(db);
      const items: string[] = [];
      for (let i = 0; i < 15; i += 1) {
        items.push(await createMenuItem(db, f.restaurantId, f.categoryId));
      }
      const results = await db.asUser(f.userId, (c) =>
        Promise.allSettled(
          items.map((item) =>
            c.query("select public.begin_menu_item_image_generation($1);", [
              item,
            ]),
          ),
        ),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter(
        (r) =>
          r.status === "rejected" &&
          /MENU_IMAGE_GENERATION_RESTAURANT_LIMIT/.test(String(r.reason)),
      );
      expect(succeeded).toHaveLength(10);
      expect(refused).toHaveLength(5);
    });

    it("is append-only, even for the admin", async () => {
      const f = await fullRestaurantFixture(db);
      const id = await beginGeneration(f.userId, f.menuItemId);
      await db.asUser(f.userId, (c) =>
        c.query("select public.fail_menu_item_image($1, 'x');", [id]),
      );

      await expect(
        db.admin.query(
          "delete from public.menu_image_generation_attempts where image_id = $1;",
          [id],
        ),
      ).rejects.toThrow(/MENU_IMAGE_ATTEMPTS_APPEND_ONLY/);
      await expect(
        db.admin.query(
          "update public.menu_image_generation_attempts set status = 'succeeded' where image_id = $1;",
          [id],
        ),
      ).rejects.toThrow(/MENU_IMAGE_ATTEMPTS_APPEND_ONLY/);
      await expect(
        db.admin.query(
          "update public.menu_image_generation_attempts set started_at = now() - interval '2 days' where image_id = $1;",
          [id],
        ),
      ).rejects.toThrow(/MENU_IMAGE_ATTEMPTS_APPEND_ONLY/);
    });

    it("gives owners read access to their own history and no way to write it", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await beginGeneration(a.userId, a.menuItemId);

      const own = await db.asUser(a.userId, (c) =>
        c.query(
          "select 1 from public.menu_image_generation_attempts where restaurant_id = $1;",
          [a.restaurantId],
        ),
      );
      expect(own.rows).toHaveLength(1);
      const foreign = await db.asUser(b.userId, (c) =>
        c.query(
          "select 1 from public.menu_image_generation_attempts where restaurant_id = $1;",
          [a.restaurantId],
        ),
      );
      expect(foreign.rows).toHaveLength(0);

      await expect(
        db.asUser(a.userId, (c) =>
          c.query(
            "insert into public.menu_image_generation_attempts (restaurant_id) values ($1);",
            [a.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
      const deleted = await db.asUser(a.userId, (c) =>
        c.query(
          "delete from public.menu_image_generation_attempts where restaurant_id = $1;",
          [a.restaurantId],
        ),
      );
      expect(deleted.affectedRows ?? 0).toBe(0);
    });
  });

  describe("path traversal", () => {
    async function completeWith(original: string, variant?: unknown) {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      const prefix = `${f.restaurantId}/${f.menuItemId}/${imageId}/`;
      return db.asUser(f.userId, (c) =>
        c.query(
          "select public.complete_menu_item_image($1, $2, $3, 10, 10, 10, 'image/webp', 'x');",
          [
            imageId,
            original.replace("{prefix}", prefix),
            JSON.stringify({
              card:
                typeof variant === "string"
                  ? variant.replace("{prefix}", prefix)
                  : (variant ?? `${prefix}card.webp`),
            }),
          ],
        ),
      );
    }

    it.each([
      "{prefix}../../../other",
      "{prefix}..",
      "{prefix}../x.webp",
      "{prefix}./x.webp",
      "{prefix}x/../../y.webp",
      "{prefix}sub/x.webp",
      "{prefix}",
      "{prefix}.hidden",
      "{prefix}a\\b.webp",
      "{prefix}x.webp ",
      "{prefix}x..webp",
      "/{prefix}x.webp",
    ])("refuses original path %s", async (path) => {
      await expect(completeWith(path)).rejects.toThrow(
        /MENU_IMAGE_INVALID_PATH/,
      );
    });

    it.each([
      "{prefix}../../../other",
      "{prefix}sub/card.webp",
      "{prefix}.card",
    ])("refuses variant path %s", async (path) => {
      await expect(completeWith("{prefix}original", path)).rejects.toThrow(
        /MENU_IMAGE_INVALID_PATH/,
      );
    });

    it("refuses a variant that is not a string", async () => {
      await expect(
        completeWith("{prefix}original", { nested: "x" }),
      ).rejects.toThrow(/MENU_IMAGE_INVALID_PATH/);
    });

    it("accepts the plain file names phase 2 will use", async () => {
      await expect(
        completeWith("{prefix}original.jpg", "{prefix}detail_2x.webp"),
      ).resolves.toBeTruthy();
    });
  });

  describe("image column guard, every column", () => {
    it.each([
      ["active_image_id", "gen_random_uuid()"],
      ["image_variants", `'{"card":"x"}'::jsonb`],
      // A different value from the published 'real' — writing the same
      // value back is not a change, and is (correctly) allowed.
      ["image_source", "'ai_generated'"],
    ])(
      "refuses a direct change to menu_items.%s by the owner",
      async (column, value) => {
        const f = await fullRestaurantFixture(db);
        const imageId = await beginUpload(f.userId, f.menuItemId);
        await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
        await publish(f.userId, imageId);
        await expect(
          db.asUser(f.userId, (c) =>
            c.query(
              `update public.menu_items set ${column} = ${value} where id = $1;`,
              [f.menuItemId],
            ),
          ),
        ).rejects.toThrow(/MENU_ITEM_IMAGE_COLUMNS_READ_ONLY/);
        expect((await itemImage(f.menuItemId)).active_image_id).toBe(imageId);
      },
    );
  });

  describe("deletion by the owner", () => {
    it("lets an owner delete a dish that has an active image", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
      await publish(f.userId, imageId);

      await db.asUser(f.userId, (c) =>
        c.query("delete from public.menu_items where id = $1;", [f.menuItemId]),
      );
      const { rows } = await db.admin.query(
        "select 1 from public.menu_item_images where id = $1;",
        [imageId],
      );
      expect(rows).toHaveLength(0);
    });

    it("deletes a restaurant cleanly, with its images and its attempt history", async () => {
      const f = await fullRestaurantFixture(db);
      const real = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, real);
      await publish(f.userId, real);
      const other = await createMenuItem(db, f.restaurantId, f.categoryId);
      await beginGeneration(f.userId, other);

      await db.admin.query("delete from public.restaurants where id = $1;", [
        f.restaurantId,
      ]);
      for (const table of [
        "menu_item_images",
        "menu_image_generation_attempts",
      ]) {
        const { rows } = await db.admin.query(
          `select 1 from public.${table} where restaurant_id = $1;`,
          [f.restaurantId],
        );
        expect(rows).toHaveLength(0);
      }
    });

    it("refuses to delete an active image row directly, even for the admin", async () => {
      const f = await fullRestaurantFixture(db);
      const imageId = await beginUpload(f.userId, f.menuItemId);
      await complete(f.userId, f.restaurantId, f.menuItemId, imageId);
      await publish(f.userId, imageId);
      // The pointer's SET NULL would leave image_source without an image,
      // which the consistency check refuses — an active image can only be
      // taken down through remove_menu_item_image().
      await expect(
        db.admin.query("delete from public.menu_item_images where id = $1;", [
          imageId,
        ]),
      ).rejects.toThrow();
    });
  });
});
