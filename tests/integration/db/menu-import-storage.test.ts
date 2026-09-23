// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, fullRestaurantFixture } from "./helpers";

/**
 * Who may write the menu-imports bucket.
 *
 * Phase 2 deliberately gave the dish-photo bucket NO policy, because
 * folder-level authorization could not express "authorization for dish X
 * must not also authorize dish Z". Import pages are a different shape, and
 * the existing policy was re-examined rather than assumed inadequate:
 *
 *   - an import's pages are working material for one restaurant, not
 *     per-dish capabilities, so restaurant-level scoping is the right
 *     granularity;
 *   - the server still mints every object key and every signed token, so a
 *     client never chooses a path in practice;
 *   - extraction reads only the paths the server itself recorded on the
 *     import row, so a stray object elsewhere in the folder can never be
 *     fed to the model.
 *
 * The policy therefore stays exactly as 20260904120000_menu_imports.sql
 * wrote it. These tests pin the properties that decision depends on, so a
 * later widening — to `authenticated`, or to all staff — fails CI.
 *
 * The harness grants anon and authenticated full CRUD on storage.objects
 * first (setup.ts), as a real project does, so a refusal here is the policy
 * and not a missing grant.
 */

const BUCKET = "menu-imports";

describe("menu import storage", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  function pagePath(restaurantId: string, importId = crypto.randomUUID()) {
    return `${restaurantId}/${importId}/page-1.jpg`;
  }

  async function uploadAs(userId: string | null, name: string) {
    const run = (c: Parameters<Parameters<TestDb["asAnon"]>[0]>[0]) =>
      c.query(
        "insert into storage.objects (bucket_id, name) values ($1, $2);",
        [BUCKET, name],
      );
    return userId === null ? db.asAnon(run) : db.asUser(userId, run);
  }

  it("stays a private bucket", async () => {
    const { rows } = await db.admin.query<{ public: boolean }>(
      "select public from storage.buckets where id = $1;",
      [BUCKET],
    );
    expect(rows[0].public).toBe(false);
  });

  describe("who may upload import pages", () => {
    it("allows an owner, into their own restaurant's folder", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        uploadAs(f.userId, pagePath(f.restaurantId)),
      ).resolves.toBeTruthy();
    });

    it("allows a manager", async () => {
      const f = await fullRestaurantFixture(db, "manager");
      await expect(
        uploadAs(f.userId, pagePath(f.restaurantId)),
      ).resolves.toBeTruthy();
    });

    it.each(["staff", "kitchen"] as const)("refuses %s", async (role) => {
      // Importing rewrites the restaurant's price list, which is not
      // something waiting or kitchen staff should be able to do.
      const f = await fullRestaurantFixture(db);
      const memberId = await db.createAuthUser();
      await addMember(db, f.restaurantId, memberId, role);

      await expect(
        uploadAs(memberId, pagePath(f.restaurantId)),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses a signed-in diner", async () => {
      const f = await fullRestaurantFixture(db);
      const dinerId = await db.createAnonymousAuthUser();
      await expect(uploadAs(dinerId, pagePath(f.restaurantId))).rejects.toThrow(
        /row-level security|permission denied/i,
      );
    });

    it("refuses an anonymous caller", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(uploadAs(null, pagePath(f.restaurantId))).rejects.toThrow(
        /row-level security|permission denied/i,
      );
    });

    it("refuses an owner writing into another restaurant's folder", async () => {
      const mine = await fullRestaurantFixture(db);
      const theirs = await fullRestaurantFixture(db);

      await expect(
        uploadAs(mine.userId, pagePath(theirs.restaurantId)),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses an owner of no restaurant at all", async () => {
      const outsider = await db.createAuthUser();
      // A restaurant with no members at all: the outsider is not merely in
      // the wrong restaurant, they belong to none.
      const restaurantId = await createRestaurant(db);

      await expect(uploadAs(outsider, pagePath(restaurantId))).rejects.toThrow(
        /row-level security|permission denied/i,
      );
    });
  });

  describe("who may read import pages", () => {
    it("shows an owner only their own restaurant's pages", async () => {
      const mine = await fullRestaurantFixture(db);
      const theirs = await fullRestaurantFixture(db);
      const minePath = pagePath(mine.restaurantId);
      const theirsPath = pagePath(theirs.restaurantId);

      await db.admin.query(
        "insert into storage.objects (bucket_id, name) values ($1, $2), ($1, $3);",
        [BUCKET, minePath, theirsPath],
      );

      const { rows } = await db.asUser(mine.userId, (c) =>
        c.query<{ name: string }>(
          "select name from storage.objects where bucket_id = $1 and name = any($2);",
          [BUCKET, [minePath, theirsPath]],
        ),
      );
      expect(rows.map((r) => r.name)).toEqual([minePath]);
    });

    it("shows anon nothing", async () => {
      const f = await fullRestaurantFixture(db);
      await db.admin.query(
        "insert into storage.objects (bucket_id, name) values ($1, $2);",
        [BUCKET, pagePath(f.restaurantId)],
      );

      const { rows } = await db.asAnon((c) =>
        c.query("select name from storage.objects where bucket_id = $1;", [
          BUCKET,
        ]),
      );
      expect(rows).toEqual([]);
    });
  });

  describe("the import pages stay out of the dish-photo world", () => {
    it("never creates a menu_item_images row", async () => {
      const f = await fullRestaurantFixture(db);
      await uploadAs(f.userId, pagePath(f.restaurantId));

      const { rows } = await db.admin.query<{ count: string }>(
        "select count(*)::text as count from public.menu_item_images where restaurant_id = $1;",
        [f.restaurantId],
      );
      expect(rows[0].count).toBe("0");
    });

    it("writes nothing into either menu photo bucket", async () => {
      const { rows } = await db.admin.query<{ count: string }>(
        `select count(*)::text as count from storage.objects
         where bucket_id in ('menu-photos', 'menu-photos-private');`,
      );
      expect(rows[0].count).toBe("0");
    });
  });

  describe("menu_imports.source_paths", () => {
    it("already exists, so this transport needs no migration", async () => {
      const { rows } = await db.admin.query<{
        data_type: string;
        is_nullable: string;
      }>(
        `select data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'menu_imports'
           and column_name = 'source_paths';`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe("ARRAY");
      expect(rows[0].is_nullable).toBe("NO");
    });

    it("accepts the page paths an owner's import records, in order", async () => {
      const f = await fullRestaurantFixture(db);
      const importId = crypto.randomUUID();
      const paths = [
        `${f.restaurantId}/${importId}/page-1.jpg`,
        `${f.restaurantId}/${importId}/page-2.png`,
      ];

      await db.asUser(f.userId, (c) =>
        c.query(
          `insert into public.menu_imports (id, restaurant_id, status, source_paths)
           values ($1, $2, 'uploaded', $3);`,
          [importId, f.restaurantId, paths],
        ),
      );

      const { rows } = await db.asUser(f.userId, (c) =>
        c.query<{ source_paths: string[] }>(
          "select source_paths from public.menu_imports where id = $1;",
          [importId],
        ),
      );
      expect(rows[0].source_paths).toEqual(paths);
    });

    it("hides another restaurant's import row entirely", async () => {
      const mine = await fullRestaurantFixture(db);
      const theirs = await fullRestaurantFixture(db);
      const importId = crypto.randomUUID();

      await db.asUser(theirs.userId, (c) =>
        c.query(
          `insert into public.menu_imports (id, restaurant_id, status, source_paths)
           values ($1, $2, 'uploaded', $3);`,
          [
            importId,
            theirs.restaurantId,
            [`${theirs.restaurantId}/${importId}/page-1.jpg`],
          ],
        ),
      );

      const { rows } = await db.asUser(mine.userId, (c) =>
        c.query("select id from public.menu_imports where id = $1;", [
          importId,
        ]),
      );
      expect(rows).toEqual([]);
    });
  });
});
