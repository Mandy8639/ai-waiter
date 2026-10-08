/**
 * Diner feedback (phase N), the parts with no database: what a valid
 * submission is, which ratings count as low, and the owner's summaries.
 * Unit-tested. The database enforces the same rules itself
 * (20261006090000_order_feedback.sql); these give the diner a sentence.
 */

export const COMMENT_MAX = 1000;

/** At or below this, the diner is offered someone coming over. */
export const LOW_RATING = 2;

export type FeedbackState =
  "not_yours" | "not_yet" | "open" | "given" | "closed";

export function isFeedbackState(value: unknown): value is FeedbackState {
  return (
    value === "not_yours" ||
    value === "not_yet" ||
    value === "open" ||
    value === "given" ||
    value === "closed"
  );
}

export interface FeedbackInput {
  rating: number;
  comment: string | null;
  /** order_item_id -> liked */
  votes: Record<string, boolean>;
}

export type FeedbackParse =
  { ok: true; value: FeedbackInput } | { ok: false; error: string };

export function parseFeedback(
  input: {
    rating: unknown;
    comment: unknown;
    votes: unknown;
  },
  orderItemIds: readonly string[],
): FeedbackParse {
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Choose from one to five stars." };
  }
  const comment =
    typeof input.comment === "string" && input.comment.trim() !== ""
      ? input.comment.trim()
      : null;
  if (comment && comment.length > COMMENT_MAX) {
    return {
      ok: false,
      error: `Keep it under ${COMMENT_MAX.toLocaleString("en-US")} characters.`,
    };
  }
  const votes: Record<string, boolean> = {};
  if (input.votes && typeof input.votes === "object") {
    const known = new Set(orderItemIds);
    for (const [id, liked] of Object.entries(input.votes)) {
      if (typeof liked !== "boolean") continue;
      if (!known.has(id)) {
        return { ok: false, error: "Please reload the page and try again." };
      }
      votes[id] = liked;
    }
  }
  return { ok: true, value: { rating, comment, votes } };
}

/** The friendly words for a star count, for the diner's buttons. */
export const RATING_WORDS: Record<number, string> = {
  1: "Poor",
  2: "Not great",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

// For the owner ------------------------------------------------------------------

export interface FeedbackRow {
  rating: number;
  createdAt: string;
}

export interface FeedbackSummary {
  count: number;
  /** One decimal place, or null when there's nothing to average. */
  average: number | null;
  /** distribution[5] is how many gave five stars. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  low: number;
}

export function summarizeFeedback(
  rows: readonly FeedbackRow[],
): FeedbackSummary {
  const distribution = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  } as FeedbackSummary["distribution"];
  let total = 0;
  for (const r of rows) {
    distribution[r.rating as 1 | 2 | 3 | 4 | 5] += 1;
    total += r.rating;
  }
  return {
    count: rows.length,
    average: rows.length ? Math.round((total / rows.length) * 10) / 10 : null,
    distribution,
    low: rows.filter((r) => r.rating <= LOW_RATING).length,
  };
}

export interface DishVote {
  menuItemId: string | null;
  dishName: string;
  liked: boolean;
}

export interface DishTally {
  dishName: string;
  up: number;
  down: number;
}

/**
 * Votes per dish, the most disliked first: the list an owner reads to
 * find the dish that's letting them down. Votes for a dish since removed
 * from the menu are grouped under the name it was served as.
 */
export function tallyDishes(votes: readonly DishVote[]): DishTally[] {
  const byKey = new Map<string, DishTally>();
  for (const v of votes) {
    const key = v.menuItemId ?? `name:${v.dishName}`;
    const t = byKey.get(key) ?? { dishName: v.dishName, up: 0, down: 0 };
    if (v.liked) t.up += 1;
    else t.down += 1;
    byKey.set(key, t);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.down - a.down || a.up - b.up || a.dishName.localeCompare(b.dishName),
  );
}
