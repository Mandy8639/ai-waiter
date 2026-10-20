/**
 * "Generate for all dishes" on the Menu photos page: which dishes to ask
 * for, and how one batch of them runs.
 *
 * No `server-only`: pure, so it is unit-tested directly (see
 * src/lib/env-helpers.ts for why). The server action in actions.ts does the
 * authorising and hands in the per-dish generator.
 *
 * The browser drives the loop, one batch at a time, so a menu of any size
 * never needs one long request, and closing the page simply stops after
 * the current batch. Every image still lands in pending_review: nothing
 * here can put a picture in front of a diner.
 */

/** Dishes generated at once. Each takes about 10 s, in parallel. */
export const BULK_BATCH_SIZE = 5;

/** Images approved at once by "Approve all". */
export const BULK_PUBLISH_SIZE = 10;

/** One dish's photo situation, as the page reads it. */
export interface BulkCandidate {
  id: string;
  name: string;
  activeImageId: string | null;
  /** A generated or uploaded image waiting for review, or being made. */
  hasPendingImage: boolean;
}

/**
 * The dishes worth generating for: no photo on the menu, nothing already
 * waiting for review or being made (the database would refuse a second
 * pending image anyway, and the refusal would cost a round trip), and a
 * name to draw from.
 */
export function pickBulkTargets(rows: BulkCandidate[]): string[] {
  return rows
    .filter(
      (r) => !r.activeImageId && !r.hasPendingImage && r.name.trim() !== "",
    )
    .map((r) => r.id);
}

/** How one dish's generation ended. */
export type DishResult =
  | { ok: true; imageId: string }
  | {
      ok: false;
      error: string;
      /**
       * restaurant_limit: today's restaurant-wide allowance is used up.
       * unavailable:      the generator can't serve right now.
       * dish:             this dish only (its own limit, a bad image...).
       */
      kind: "restaurant_limit" | "unavailable" | "dish";
    };

export interface BatchResult {
  generated: number;
  failed: number;
  /** Why the browser should stop asking for more, if it should. */
  stop: "restaurant_limit" | "unavailable" | null;
  /** The sentence to show when stopping, or for the last failure. */
  message: string | null;
}

/**
 * Runs one batch in parallel and says whether to go on. Stops on the
 * restaurant limit (every further dish would be refused) or on the
 * generator being unavailable (every further dish would fail the same
 * way); a single dish's failure is counted and the run carries on.
 */
export async function runBatch(
  ids: string[],
  one: (menuItemId: string) => Promise<DishResult>,
): Promise<BatchResult> {
  const results = await Promise.all(
    ids.slice(0, BULK_BATCH_SIZE).map(async (id) => {
      try {
        return await one(id);
      } catch {
        return {
          ok: false,
          error: "The image could not be generated.",
          kind: "dish",
        } satisfies DishResult;
      }
    }),
  );

  const failures = results.filter(
    (r): r is Extract<DishResult, { ok: false }> => !r.ok,
  );
  const limit = failures.find((f) => f.kind === "restaurant_limit");
  const unavailable = failures.find((f) => f.kind === "unavailable");
  const stopping = limit ?? unavailable ?? null;

  return {
    generated: results.length - failures.length,
    failed: failures.length,
    stop: limit ? "restaurant_limit" : unavailable ? "unavailable" : null,
    message: stopping?.error ?? failures.at(-1)?.error ?? null,
  };
}

/** Splits a list into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
