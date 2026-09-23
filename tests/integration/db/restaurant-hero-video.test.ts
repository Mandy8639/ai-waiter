// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, fullRestaurantFixture } from "./helpers";

/**
 * The hero video lifecycle, against real Postgres running the real
 * migration.
 *
 * The claims worth testing here are the ones that would let a video reach
 * a diner without anybody approving it, or let one restaurant's hero point
 * at another restaurant's bytes. Everything else — column types, defaults
 * — is the schema asserting itself.
 */

const PRIVATE_BUCKET = "restaurant-videos-private";
const PUBLISHED_BUCKET = "restaurant-videos";

describe("restaurant hero video", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Walks a video to pending_review the way the application does. */
  async function uploadTo(
    userId: string,
    restaurantId: string,
  ): Promise<string> {
    return db.asUser(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "select public.begin_restaurant_hero_video_upload($1) as id;",
        [restaurantId],
      );
      const videoId = rows[0].id;
      await client.query(
        `select public.complete_restaurant_hero_video(
           $1, $2, $3::jsonb, $4, $5, $6
         );`,
        [
          videoId,
          `${restaurantId}/${videoId}/original.mp4`,
          JSON.stringify({
            small: `${restaurantId}/${videoId}/poster-small.webp`,
            large: `${restaurantId}/${videoId}/poster-large.webp`,
          }),
          1_000_000,
          "video/mp4",
          "a".repeat(64),
        ],
      );
      return videoId;
    });
  }

  describe("buckets", () => {
    it("creates one private and one public video bucket", async () => {
      const { rows } = await db.admin.query<{
        id: string;
        public: boolean;
        file_size_limit: number;
      }>(
        `select id, public, file_size_limit from storage.buckets
         where id in ($1, $2) order by id;`,
        [PUBLISHED_BUCKET, PRIVATE_BUCKET],
      );
      expect(rows).toHaveLength(2);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[PRIVATE_BUCKET].public).toBe(false);
      expect(byId[PUBLISHED_BUCKET].public).toBe(true);
      // 50 MB on both: the published copy is the same untranscoded file.
      expect(byId[PRIVATE_BUCKET].file_size_limit).toBe(52428800);
    });

    it("refuses anything that is not a video or an image", async () => {
      const { rows } = await db.admin.query<{ allowed_mime_types: string[] }>(
        "select allowed_mime_types from storage.buckets where id = $1;",
        [PUBLISHED_BUCKET],
      );
      expect(rows[0].allowed_mime_types).toEqual([
        "video/mp4",
        "video/webm",
        "image/webp",
      ]);
    });

    it("gives the video buckets no policy at all, like the private photo bucket", async () => {
      const { rows } = await db.admin.query<{ count: number }>(
        `select count(*)::int as count from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and qual like '%restaurant-videos%';`,
      );
      expect(rows[0].count).toBe(0);
    });
  });

  describe("upload and review", () => {
    it("reserves one upload and leaves it in 'uploading'", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await db.asUser(userId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "select public.begin_restaurant_hero_video_upload($1) as id;",
          [restaurantId],
        );
        return rows[0].id;
      });

      const { rows } = await db.admin.query<{
        status: string;
        video_path: string | null;
      }>(
        "select status, video_path from public.restaurant_hero_videos where id = $1;",
        [videoId],
      );
      expect(rows[0].status).toBe("uploading");
      expect(rows[0].video_path).toBeNull();
    });

    it("refuses a second upload while one is in flight", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      await uploadTo(userId, restaurantId);

      await expect(
        db.asUser(userId, (client) =>
          client.query(
            "select public.begin_restaurant_hero_video_upload($1);",
            [restaurantId],
          ),
        ),
      ).rejects.toThrow(/HERO_VIDEO_UPLOAD_IN_FLIGHT/);
    });

    it("stops a finished upload at pending_review, never at active", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await uploadTo(userId, restaurantId);

      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.restaurant_hero_videos where id = $1;",
        [videoId],
      );
      expect(rows[0].status).toBe("pending_review");

      // And the diner-facing columns are untouched.
      const { rows: restaurant } = await db.admin.query<{
        active_hero_video_id: string | null;
        hero_video: unknown;
      }>(
        "select active_hero_video_id, hero_video from public.restaurants where id = $1;",
        [restaurantId],
      );
      expect(restaurant[0].active_hero_video_id).toBeNull();
      expect(restaurant[0].hero_video).toBeNull();
    });

    it("refuses a path outside the video's own folder", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const other = await createRestaurant(db);

      await expect(
        db.asUser(userId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            "select public.begin_restaurant_hero_video_upload($1) as id;",
            [restaurantId],
          );
          return client.query(
            "select public.complete_restaurant_hero_video($1, $2, $3::jsonb, $4, $5, $6);",
            [
              rows[0].id,
              // Another restaurant's folder.
              `${other}/${rows[0].id}/original.mp4`,
              JSON.stringify({
                small: `${restaurantId}/${rows[0].id}/poster-small.webp`,
              }),
              10,
              "video/mp4",
              "b".repeat(64),
            ],
          );
        }),
      ).rejects.toThrow(/HERO_VIDEO_INVALID_PATH/);
    });

    it("refuses a traversal in a poster path", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);

      await expect(
        db.asUser(userId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            "select public.begin_restaurant_hero_video_upload($1) as id;",
            [restaurantId],
          );
          return client.query(
            "select public.complete_restaurant_hero_video($1, $2, $3::jsonb, $4, $5, $6);",
            [
              rows[0].id,
              `${restaurantId}/${rows[0].id}/original.mp4`,
              JSON.stringify({
                small: `${restaurantId}/${rows[0].id}/../../etc/passwd`,
              }),
              10,
              "video/mp4",
              "c".repeat(64),
            ],
          );
        }),
      ).rejects.toThrow(/HERO_VIDEO_INVALID_PATH/);
    });

    it("requires a poster: an empty object is not a poster set", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);

      await expect(
        db.asUser(userId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            "select public.begin_restaurant_hero_video_upload($1) as id;",
            [restaurantId],
          );
          return client.query(
            "select public.complete_restaurant_hero_video($1, $2, $3::jsonb, $4, $5, $6);",
            [
              rows[0].id,
              `${restaurantId}/${rows[0].id}/original.mp4`,
              JSON.stringify({}),
              10,
              "video/mp4",
              "d".repeat(64),
            ],
          );
        }),
      ).rejects.toThrow(/HERO_VIDEO_INVALID_PATH/);
    });
  });

  describe("publishing", () => {
    it("is the only thing that makes a video visible to diners", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await uploadTo(userId, restaurantId);

      await db.asUser(userId, (client) =>
        client.query("select public.publish_restaurant_hero_video($1);", [
          videoId,
        ]),
      );

      const { rows } = await db.admin.query<{
        active_hero_video_id: string;
        hero_video: { video: string; poster: Record<string, string> };
      }>(
        "select active_hero_video_id, hero_video from public.restaurants where id = $1;",
        [restaurantId],
      );
      expect(rows[0].active_hero_video_id).toBe(videoId);
      expect(rows[0].hero_video.video).toContain(videoId);
      // jsonb does not preserve key order, so compare as a set.
      expect(Object.keys(rows[0].hero_video.poster).sort()).toEqual([
        "large",
        "small",
      ]);
    });

    it("steps the outgoing video down in the same breath", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const first = await uploadTo(userId, restaurantId);
      await db.asUser(userId, (client) =>
        client.query("select public.publish_restaurant_hero_video($1);", [
          first,
        ]),
      );
      const second = await uploadTo(userId, restaurantId);
      await db.asUser(userId, (client) =>
        client.query("select public.publish_restaurant_hero_video($1);", [
          second,
        ]),
      );

      const { rows } = await db.admin.query<{ id: string; status: string }>(
        `select id, status from public.restaurant_hero_videos
         where restaurant_id = $1 order by created_at;`,
        [restaurantId],
      );
      expect(rows.map((r) => r.status)).toEqual(["superseded", "active"]);
      // Never two active rows, enforced by the partial unique index.
      expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    });

    it("refuses to publish something nobody reviewed", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await db.asUser(userId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "select public.begin_restaurant_hero_video_upload($1) as id;",
          [restaurantId],
        );
        return rows[0].id;
      });

      // Still 'uploading' — no bytes, no paths.
      await expect(
        db.asUser(userId, (client) =>
          client.query("select public.publish_restaurant_hero_video($1);", [
            videoId,
          ]),
        ),
      ).rejects.toThrow(/HERO_VIDEO_INVALID_STATE/);
    });

    it("removing clears the diner pointer but keeps the row and its bytes", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await uploadTo(userId, restaurantId);
      await db.asUser(userId, (client) =>
        client.query("select public.publish_restaurant_hero_video($1);", [
          videoId,
        ]),
      );

      await db.asUser(userId, (client) =>
        client.query("select public.remove_restaurant_hero_video($1);", [
          restaurantId,
        ]),
      );

      const { rows } = await db.admin.query<{
        status: string;
        video_path: string;
      }>(
        "select status, video_path from public.restaurant_hero_videos where id = $1;",
        [videoId],
      );
      expect(rows[0].status).toBe("removed");
      // The retention engine, not this function, decides when bytes go.
      expect(rows[0].video_path).not.toBeNull();

      const { rows: restaurant } = await db.admin.query<{
        active_hero_video_id: string | null;
        hero_video: unknown;
      }>(
        "select active_hero_video_id, hero_video from public.restaurants where id = $1;",
        [restaurantId],
      );
      expect(restaurant[0].active_hero_video_id).toBeNull();
      expect(restaurant[0].hero_video).toBeNull();
    });
  });

  describe("authorization", () => {
    it("refuses a member who is not an owner or manager", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const cook = await db.createAuthUser();
      await addMember(db, restaurantId, cook, "kitchen");

      await expect(
        db.asUser(cook, (client) =>
          client.query(
            "select public.begin_restaurant_hero_video_upload($1);",
            [restaurantId],
          ),
        ),
      ).rejects.toThrow(/HERO_VIDEO_FORBIDDEN/);
    });

    it("refuses another restaurant's owner", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const outsider = await fullRestaurantFixture(db);

      await expect(
        db.asUser(outsider.userId, (client) =>
          client.query(
            "select public.begin_restaurant_hero_video_upload($1);",
            [restaurantId],
          ),
        ),
      ).rejects.toThrow(/HERO_VIDEO_FORBIDDEN/);
    });

    it("hides the lifecycle table from diners entirely", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      await uploadTo(userId, restaurantId);

      const { rows } = await db.asAnon((client) =>
        client
          .query("select id from public.restaurant_hero_videos;")
          .then((r) => r),
      );
      expect(rows).toHaveLength(0);
    });

    it("still lets a diner read the published video off restaurants", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const videoId = await uploadTo(userId, restaurantId);
      await db.asUser(userId, (client) =>
        client.query("select public.publish_restaurant_hero_video($1);", [
          videoId,
        ]),
      );

      const { rows } = await db.asAnon((client) =>
        client.query<{ hero_video: { video: string } | null }>(
          "select hero_video from public.restaurants where id = $1;",
          [restaurantId],
        ),
      );
      expect(rows[0].hero_video?.video).toContain(videoId);
    });
  });

  describe("the pointer columns are not ordinary columns", () => {
    it("refuses a direct write from an owner", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);

      // RLS would happily allow this update; the trigger is what stops it.
      await expect(
        db.asUser(userId, (client) =>
          client.query(
            `update public.restaurants
             set active_hero_video_id = $1, hero_video = '{"video":"x"}'::jsonb
             where id = $1;`,
            [restaurantId],
          ),
        ),
      ).rejects.toThrow(/RESTAURANT_HERO_VIDEO_COLUMNS_READ_ONLY/);
    });

    it("refuses a pointer without the denormalised copy", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      // Even as the table owner, the constraint holds.
      await expect(
        db.admin.query(
          'update public.restaurants set hero_video = \'{"video":"x"}\'::jsonb where id = $1;',
          [restaurantId],
        ),
      ).rejects.toThrow(/restaurants_hero_video_pointer_consistent/);
    });
  });

  describe("grants", () => {
    it("leaves no hero video function callable by anon", async () => {
      const { rows } = await db.admin.query<{
        name: string;
        anon_can_execute: boolean;
      }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prorettype <> 'trigger'::regtype
           and (p.proname like '%hero_video%')
         order by p.proname;`,
      );

      expect(rows.length).toBeGreaterThan(0);
      const exposed = rows.filter((r) => r.anon_can_execute).map((r) => r.name);
      expect(exposed).toEqual([]);
    });

    it("keeps the two internal helpers away from authenticated as well", async () => {
      const { rows } = await db.admin.query<{
        name: string;
        can: boolean;
      }>(
        `select p.proname as name,
                has_function_privilege('authenticated', p.oid, 'execute') as can
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('hero_video_authorize', 'hero_video_authorize_video');`,
      );
      expect(rows.map((r) => r.can)).toEqual([false, false]);
    });
  });
});
