// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullRestaurantFixture } from "./helpers";

/**
 * Storage access for the two menu-photo buckets.
 *
 * The protection here is unusual and worth stating plainly: the private
 * bucket has NO policy. RLS is enabled on storage.objects, nothing matches
 * these buckets, so every ambient read and write by anon or authenticated
 * is refused — including by an owner acting on their own restaurant. The
 * only way a byte reaches the private bucket is a signed upload URL minted
 * server-side for one exact object path.
 *
 * That is deliberate. The menu-imports bucket takes the more usual
 * approach — allow anything under (storage.foldername(name))[1] when the
 * caller manages that restaurant — and it cannot express the requirement
 * that authorization for restaurant A / dish X / image Y must not also
 * authorize A / dish Z. A policy sees only the object name; it has no idea
 * which image record the caller was actually granted.
 *
 * An absence is fragile in a way a policy is not: it erodes the moment
 * someone adds a helpful policy in a later migration. These tests run on
 * every suite, so that erosion fails CI.
 *
 * The harness grants anon and authenticated full CRUD on storage.objects
 * first (see setup.ts), exactly as a real project does, so a refusal here
 * is the policy boundary and not a missing grant.
 */

const PRIVATE_BUCKET = "menu-photos-private";
const PUBLISHED_BUCKET = "menu-photos";

describe("menu photo storage", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe("buckets", () => {
    it("creates one private and one public bucket", async () => {
      const { rows } = await db.admin.query<{
        id: string;
        public: boolean;
        file_size_limit: string | number | null;
        allowed_mime_types: string[];
      }>(
        `select id, public, file_size_limit, allowed_mime_types
         from storage.buckets where id = any($1) order by id;`,
        [[PRIVATE_BUCKET, PUBLISHED_BUCKET]],
      );

      expect(rows).toHaveLength(2);
      const published = rows.find((r) => r.id === PUBLISHED_BUCKET);
      const priv = rows.find((r) => r.id === PRIVATE_BUCKET);

      expect(priv?.public).toBe(false);
      expect(published?.public).toBe(true);
      // Published objects are our own re-encoded output, nothing else.
      expect(published?.allowed_mime_types).toEqual(["image/webp"]);
      // Originals are what a phone camera produces.
      expect(priv?.allowed_mime_types).toEqual([
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
    });

    it("keeps the originals bucket private, whatever else changes", async () => {
      const { rows } = await db.admin.query<{ public: boolean }>(
        "select public from storage.buckets where id = $1;",
        [PRIVATE_BUCKET],
      );
      expect(rows[0].public).toBe(false);
    });
  });

  describe("policies", () => {
    it("has no policy referencing either menu photo bucket", async () => {
      // The whole design rests on this. A policy appearing here means
      // per-object authorization quietly became per-tenant authorization.
      const { rows } = await db.admin.query<{ policyname: string }>(
        `select policyname
         from pg_policies
         where schemaname = 'storage'
           and tablename = 'objects'
           and (coalesce(qual, '') like '%menu-photos%'
                or coalesce(with_check, '') like '%menu-photos%');`,
      );
      expect(rows.map((r) => r.policyname)).toEqual([]);
    });

    it("leaves the menu-imports policies alone", async () => {
      // Phase 2 must not weaken or disturb the existing import bucket.
      const { rows } = await db.admin.query<{ policyname: string }>(
        `select policyname from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and coalesce(qual, '') || coalesce(with_check, '') like '%menu-imports%'
         order by policyname;`,
      );
      expect(rows.map((r) => r.policyname)).toEqual([
        "menu_imports_storage_delete_own_restaurant",
        "menu_imports_storage_read_own_restaurant",
        "menu_imports_storage_write_own_restaurant",
      ]);
    });
  });

  describe("nobody may write the private bucket through an ordinary session", () => {
    async function insertAs(
      userId: string | null,
      bucket: string,
      name: string,
    ) {
      const run = (c: Parameters<Parameters<TestDb["asAnon"]>[0]>[0]) =>
        c.query(
          "insert into storage.objects (bucket_id, name) values ($1, $2);",
          [bucket, name],
        );
      return userId === null ? db.asAnon(run) : db.asUser(userId, run);
    }

    it("refuses the restaurant's own owner", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        insertAs(
          f.userId,
          PRIVATE_BUCKET,
          `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/original.jpg`,
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses an anonymous caller", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        insertAs(
          null,
          PRIVATE_BUCKET,
          `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/original.jpg`,
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses a signed-in diner", async () => {
      const f = await fullRestaurantFixture(db);
      const dinerId = await db.createAnonymousAuthUser();
      await expect(
        insertAs(
          dinerId,
          PRIVATE_BUCKET,
          `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/original.jpg`,
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses an owner of a different restaurant", async () => {
      const f = await fullRestaurantFixture(db);
      // An independent restaurant with its own owner.
      const other = await fullRestaurantFixture(db);
      await expect(
        insertAs(
          other.userId,
          PRIVATE_BUCKET,
          `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/original.jpg`,
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });
  });

  describe("nobody may read the private bucket through an ordinary session", () => {
    let objectName: string;
    let fixture: Awaited<ReturnType<typeof fullRestaurantFixture>>;

    beforeAll(async () => {
      fixture = await fullRestaurantFixture(db);
      objectName = `${fixture.restaurantId}/${fixture.menuItemId}/${crypto.randomUUID()}/original.jpg`;
      // Written as the admin, standing in for the signed-URL upload that
      // is the only real way an object gets here.
      await db.admin.query(
        "insert into storage.objects (bucket_id, name) values ($1, $2);",
        [PRIVATE_BUCKET, objectName],
      );
    });

    it("hides it from the restaurant's own owner", async () => {
      const { rows } = await db.asUser(fixture.userId, (c) =>
        c.query("select name from storage.objects where bucket_id = $1;", [
          PRIVATE_BUCKET,
        ]),
      );
      expect(rows).toEqual([]);
    });

    it("hides it from anon", async () => {
      const { rows } = await db.asAnon((c) =>
        c.query("select name from storage.objects where bucket_id = $1;", [
          PRIVATE_BUCKET,
        ]),
      );
      expect(rows).toEqual([]);
    });

    it("is readable by service_role, which is how the server processes it", async () => {
      const { rows } = await db.asServiceRole((c) =>
        c.query("select name from storage.objects where bucket_id = $1;", [
          PRIVATE_BUCKET,
        ]),
      );
      expect(rows.map((r) => (r as { name: string }).name)).toContain(
        objectName,
      );
    });
  });

  describe("published variants are written only by the server", () => {
    it("refuses an owner writing a published variant directly", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asUser(f.userId, (c) =>
          c.query(
            "insert into storage.objects (bucket_id, name) values ($1, $2);",
            [
              PUBLISHED_BUCKET,
              `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/small.webp`,
            ],
          ),
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("refuses anon writing a published variant", async () => {
      const f = await fullRestaurantFixture(db);
      await expect(
        db.asAnon((c) =>
          c.query(
            "insert into storage.objects (bucket_id, name) values ($1, $2);",
            [
              PUBLISHED_BUCKET,
              `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/small.webp`,
            ],
          ),
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });

    it("lets service_role write one", async () => {
      const f = await fullRestaurantFixture(db);
      const name = `${f.restaurantId}/${f.menuItemId}/${crypto.randomUUID()}/small.webp`;
      await expect(
        db.asServiceRole((c) =>
          c.query(
            "insert into storage.objects (bucket_id, name) values ($1, $2);",
            [PUBLISHED_BUCKET, name],
          ),
        ),
      ).resolves.toBeTruthy();
    });
  });
});
