import { publishedVideoUrl } from "./resolve";

/**
 * What the owner's hero video panel needs to render, read server-side.
 *
 * Three states, mirroring src/lib/menu-images/owner-state.ts, because they
 * are the only three an owner can actually be in: there is a video live,
 * one is waiting for them, or the last attempt failed. Everything else in
 * the lifecycle is transient or history.
 */
export interface OwnerHeroVideoState {
  current: { videoId: string; src: string; poster: string | null } | null;
  pending: { videoId: string } | null;
  failed: { videoId: string; error: string | null } | null;
}

interface HeroVideoRow {
  id: string;
  status: string;
  video_path: string | null;
  poster_paths: Record<string, string> | null;
  error: string | null;
}

/**
 * `supabase` is passed in rather than created here so this module stays
 * free of `server-only` and can be exercised directly — the same
 * convention as the menu image loader.
 */
export async function loadOwnerHeroVideoState(
  supabase: {
    from: (table: string) => unknown;
  },
  restaurantId: string,
  supabaseUrl: string,
): Promise<OwnerHeroVideoState> {
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        order: (
          column: string,
          options: { ascending: boolean },
        ) => Promise<{ data: HeroVideoRow[] | null }>;
      };
    };
  };

  const { data } = await from("restaurant_hero_videos")
    .select("id, status, video_path, poster_paths, error")
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false });

  const rows = data ?? [];
  const active = rows.find((r) => r.status === "active") ?? null;
  const pending = rows.find((r) => r.status === "pending_review") ?? null;

  // Only a failure that is still the most recent thing that happened is
  // worth showing. A failure from before a successful upload is history.
  const newest = rows[0] ?? null;
  const failed = newest?.status === "failed" ? newest : null;

  return {
    current:
      active && active.video_path
        ? {
            videoId: active.id,
            src: publishedVideoUrl(supabaseUrl, active.video_path),
            poster: firstPoster(active, supabaseUrl),
          }
        : null,
    pending: pending ? { videoId: pending.id } : null,
    failed: failed ? { videoId: failed.id, error: failed.error } : null,
  };
}

function firstPoster(row: HeroVideoRow, supabaseUrl: string): string | null {
  const paths = Object.values(row.poster_paths ?? {});
  return paths.length > 0 ? publishedVideoUrl(supabaseUrl, paths[0]) : null;
}
