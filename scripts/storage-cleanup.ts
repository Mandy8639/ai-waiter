/**
 * Storage retention and orphan cleanup, as a controlled command.
 *
 *   npm run storage:cleanup              dry run (the default)
 *   npm run storage:cleanup -- --execute actually deletes
 *
 * SAFETY, IN THE ORDER IT MATTERS
 *
 * 1. Dry run is the default. Deleting requires --execute, typed by a human.
 *
 * 2. The target is never implicit. The Supabase CLI is linked to the
 *    PRODUCTION project, so this script deliberately ignores that link and
 *    reads an explicit STORAGE_CLEANUP_ENV_FILE. There is no default
 *    environment: forgetting to say where means the script refuses to run,
 *    rather than quietly cleaning up production.
 *
 * 3. Known production refs are refused outright unless
 *    STORAGE_CLEANUP_ALLOW_PRODUCTION=i-understand is set. That is not a
 *    real safeguard against a determined operator — it is a speed bump
 *    against the 2am mistake.
 *
 * 4. Deletion is bounded (see DEFAULT_BATCH_LIMIT) and reports whether a
 *    continuation run is needed.
 *
 * NOT VERIFIED AGAINST REAL SUPABASE STORAGE. The planner and executor are
 * covered by tests; this wiring has never run against a live service. Run it
 * in dry run first and check the plan against reality before --execute.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { planCleanup } from "../src/lib/storage-cleanup/plan";
import { executeCleanup, formatPlan } from "../src/lib/storage-cleanup/execute";
import {
  DEFAULT_BATCH_LIMIT,
  MANAGED_BUCKETS,
} from "../src/lib/storage-cleanup/policy";
import type {
  HeroVideoRecord,
  ImageRecord,
  ImportRecord,
  MenuItemRecord,
  RestaurantRecord,
  StorageObject,
} from "../src/lib/storage-cleanup/types";

/** Refs known to serve real diners. Not exhaustive — the env file is the real control. */
const KNOWN_PRODUCTION_REFS = ["dqypmprjcyxoeywsumxr"];

function fail(message: string): never {
  console.error(`storage-cleanup: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));
  const batchLimit = batchArg
    ? Number(batchArg.split("=")[1])
    : DEFAULT_BATCH_LIMIT;

  const envFile = process.env.STORAGE_CLEANUP_ENV_FILE;
  if (!envFile) {
    fail(
      "STORAGE_CLEANUP_ENV_FILE is required. This script never uses the linked Supabase project,\n" +
        "  because that link points at production. Example:\n" +
        "    STORAGE_CLEANUP_ENV_FILE=.env.e2e-disposable.local npm run storage:cleanup",
    );
  }
  config({ path: envFile, override: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    fail(
      `${envFile} must define NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.`,
    );
  }

  const ref = new URL(url).hostname.split(".")[0];
  if (
    KNOWN_PRODUCTION_REFS.includes(ref) &&
    process.env.STORAGE_CLEANUP_ALLOW_PRODUCTION !== "i-understand"
  ) {
    fail(
      `refusing to run against ${ref}, which is a known production project.\n` +
        "  If this is genuinely intended, set STORAGE_CLEANUP_ALLOW_PRODUCTION=i-understand.",
    );
  }

  console.log(
    `storage-cleanup: target ${ref} (${execute ? "EXECUTE" : "dry run"})`,
  );

  const supabase = createClient(url, secret, {
    auth: { persistSession: false },
  });
  // The image columns postdate database.types.ts; see
  // src/lib/menu-images/menu-item-rows.ts for why this is asserted rather
  // than inferred.
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (
      columns: string,
    ) => Promise<{ data: unknown[] | null; error: unknown }>;
  };

  const [imageRows, itemRows, importRows, heroRows, restaurantRows] =
    await Promise.all([
      from("menu_item_images").select(
        "id, restaurant_id, menu_item_id, status, status_changed_at, original_path, variant_paths",
      ),
      from("menu_items").select("id, active_image_id"),
      from("menu_imports").select(
        "id, restaurant_id, status, source_paths, updated_at",
      ),
      from("restaurant_hero_videos").select(
        "id, restaurant_id, status, status_changed_at, video_path, poster_paths",
      ),
      from("restaurants").select("id, active_hero_video_id"),
    ]);

  const images: ImageRecord[] = ((imageRows.data ?? []) as never[]).map(
    (r: Record<string, string>) => ({
      id: r.id,
      restaurantId: r.restaurant_id,
      menuItemId: r.menu_item_id,
      status: r.status as ImageRecord["status"],
      statusChangedAt: new Date(r.status_changed_at),
      originalPath: r.original_path ?? null,
      variantPaths:
        (r.variant_paths as unknown as Record<string, string>) ?? null,
    }),
  );
  const menuItems: MenuItemRecord[] = ((itemRows.data ?? []) as never[]).map(
    (r: Record<string, string>) => ({
      id: r.id,
      activeImageId: r.active_image_id ?? null,
    }),
  );
  const imports: ImportRecord[] = ((importRows.data ?? []) as never[]).map(
    (r: Record<string, string>) => ({
      id: r.id,
      restaurantId: r.restaurant_id,
      status: r.status as ImportRecord["status"],
      sourcePaths: (r.source_paths as unknown as string[]) ?? [],
      updatedAt: new Date(r.updated_at),
    }),
  );

  const heroVideos: HeroVideoRecord[] = ((heroRows.data ?? []) as never[]).map(
    (r: Record<string, string>) => ({
      id: r.id,
      restaurantId: r.restaurant_id,
      status: r.status as HeroVideoRecord["status"],
      statusChangedAt: new Date(r.status_changed_at),
      videoPath: r.video_path ?? null,
      posterPaths:
        (r.poster_paths as unknown as Record<string, string>) ?? null,
    }),
  );
  const restaurants: RestaurantRecord[] = (
    (restaurantRows.data ?? []) as never[]
  ).map((r: Record<string, string>) => ({
    id: r.id,
    activeHeroVideoId: r.active_hero_video_id ?? null,
  }));

  const objects: StorageObject[] = [];
  for (const bucket of Object.values(MANAGED_BUCKETS)) {
    objects.push(...(await listBucket(supabase, bucket)));
  }

  const plan = planCleanup({
    now: new Date(),
    images,
    menuItems,
    imports,
    heroVideos,
    restaurants,
    objects,
  });
  const result = await executeCleanup(
    plan,
    {
      async remove(bucket, paths) {
        const { error } = await supabase.storage.from(bucket).remove(paths);
        if (error) throw new Error(error.message);
      },
    },
    { execute, batchLimit },
  );

  console.log(formatPlan(plan, result));
  if (result.failed.length > 0) process.exitCode = 1;
}

/**
 * Objects live three folders deep, and Storage's list is per-prefix, so
 * this walks restaurant -> item/import -> image. Slower than a flat list
 * and the only option the API offers.
 */
async function listBucket(
  supabase: { storage: ReturnType<typeof createClient>["storage"] },
  bucket: string,
): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  async function walk(prefix: string, depth: number): Promise<void> {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 1000 });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    for (const entry of data ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Storage marks folders by the absence of file metadata.
      if (!entry.id) {
        if (depth < 3) await walk(path, depth + 1);
        continue;
      }
      out.push({
        bucket,
        path,
        sizeBytes: (entry.metadata as { size?: number } | null)?.size ?? null,
        createdAt: new Date(entry.created_at ?? Date.now()),
      });
    }
  }
  await walk("", 0);
  return out;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
