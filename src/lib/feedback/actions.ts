"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requestService } from "@/lib/table-requests/actions";
import { LOW_RATING, parseFeedback } from "./core";
import { getMyFeedbackState } from "./queries";

/**
 * Diner feedback (phase N). Every rule — whose order, served, one per
 * order, within two days, dishes on that order — lives in
 * submit_order_feedback() and is tested against Postgres in
 * tests/integration/db/order-feedback.test.ts. This file checks the shape
 * and turns error codes into sentences.
 */

export interface FeedbackActionResult {
  ok: boolean;
  error?: string;
  /** True when the rating was low enough to offer someone coming over. */
  low?: boolean;
}

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function friendly(message: string): string {
  if (message.includes("FEEDBACK_ALREADY_GIVEN")) {
    return "You've already told us about this order — thank you.";
  }
  if (message.includes("FEEDBACK_NOT_SERVED")) {
    return "You can rate your order once it's been served.";
  }
  if (message.includes("FEEDBACK_CLOSED")) {
    return "Feedback for this order has closed.";
  }
  if (message.includes("FEEDBACK_NOT_YOUR_ORDER")) {
    return "Only the person who placed this order can rate it.";
  }
  return "Couldn't send that. Please try again.";
}

export async function submitOrderFeedback(
  restaurantSlug: string,
  orderId: string,
  orderItemIds: string[],
  input: { rating: number; comment: string; votes: Record<string, boolean> },
): Promise<FeedbackActionResult> {
  if (!z.uuid().safeParse(orderId).success) {
    return { ok: false, error: "Please reload the page and try again." };
  }
  const parsed = parseFeedback(input, orderItemIds);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();
  const { error } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(
    "submit_order_feedback",
    {
      p_order_id: orderId,
      p_rating: parsed.value.rating,
      p_comment: parsed.value.comment,
      p_dish_votes: parsed.value.votes,
    },
  );
  if (error) return { ok: false, error: friendly(error.message) };

  revalidatePath(`/r/${restaurantSlug}/order/${orderId}`);
  return { ok: true, low: parsed.value.rating <= LOW_RATING };
}

/**
 * After a low rating, the diner asked for someone to come over. An
 * ordinary waiter call, from the diner's own session, so staff get it the
 * way they get every other call. Only offered — and only honoured — for
 * the diner's own order with a low rating on it.
 */
export async function askStaffAboutFeedback(
  orderId: string,
): Promise<FeedbackActionResult> {
  if (!z.uuid().safeParse(orderId).success) return { ok: false };
  const { state, rating } = await getMyFeedbackState(orderId);
  if (state !== "given" || rating === null || rating > LOW_RATING) {
    return { ok: false, error: "Please use “Call a waiter” instead." };
  }
  const result = await requestService(
    "waiter",
    `About their feedback: rated the visit ${rating} of 5`,
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error ??
        "Couldn't reach the staff from here — please ask anyone nearby.",
    };
  }
  return { ok: true };
}
