"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report";
import { requestReservationSchema } from "./schema";
import { parseReservationError } from "./errors";
import { zonedWallClockToUtc } from "./timezone";

/**
 * A diner asking for a table.
 *
 * Distinct from createReservation() in actions.ts in the one way that
 * matters: there is no authorizeRestaurantAction() call, because the
 * caller has no relationship to the restaurant. request_reservation() is
 * not role-gated and enforces its own rules — a future time, a sane party
 * size, and a per-caller rate limit — so this wrapper validates shape and
 * converts the clock, and nothing here is trusted to be the boundary.
 *
 * The result is a request, not a booking. Nothing is confirmed until a
 * person at the restaurant assigns a table, and the copy the diner sees
 * says so rather than implying a table is being held.
 */

export interface RequestReservationState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** The created request's id, so the page can show what was asked for. */
  reservationId?: string;
}

export async function requestReservation(
  restaurantId: string,
  restaurantSlug: string,
  _prevState: RequestReservationState,
  formData: FormData,
): Promise<RequestReservationState> {
  const parsed = requestReservationSchema.safeParse({
    customerName: formData.get("customerName"),
    customerPhone: formData.get("customerPhone"),
    customerEmail: formData.get("customerEmail"),
    partySize: formData.get("partySize"),
    reservationTime: formData.get("reservationTime"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();

  // A diner may arrive here without ever scanning a QR code, so there may
  // be no identity at all. request_reservation() requires one — created_by
  // is what later lets them read their own request back — so establish it
  // here. A server action can write cookies; a Server Component cannot,
  // which is why this cannot live on the page.
  //
  // Worth being straight about the limit this places on the rate limit:
  // anyone who clears their cookies gets a fresh anonymous identity and a
  // fresh allowance. The five-per-hour rule therefore stops accidental
  // double-submits and casual repetition, not a determined abuser — for
  // that, the real control is Supabase's own per-IP throttling of
  // anonymous sign-ins.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { error: signInError } = await supabase.auth.signInAnonymously();
    if (signInError) {
      reportError(signInError, {
        scope: "reservations.request.signin",
        extra: { restaurantId },
      });
      return {
        error: "We couldn't start your request. Please try again.",
      };
    }
  }

  // A diner types the time they mean to arrive, which is a wall clock in
  // the restaurant's town — not theirs, and not UTC. Converting through
  // the restaurant's own zone is what makes "7pm" mean 7pm to the person
  // reading the dashboard, and it is why the timezone is read here rather
  // than assumed.
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("timezone")
    .eq("id", restaurantId)
    .maybeSingle();

  const reservationTimeUtc = zonedWallClockToUtc(
    parsed.data.reservationTime,
    restaurant?.timezone ?? "UTC",
  );
  if (!reservationTimeUtc) {
    return {
      fieldErrors: { reservationTime: ["That's not a valid date/time."] },
    };
  }

  const { data, error } = await supabase.rpc("request_reservation", {
    p_restaurant_id: restaurantId,
    p_customer_name: parsed.data.customerName,
    p_customer_phone: parsed.data.customerPhone,
    p_customer_email: parsed.data.customerEmail || null,
    p_party_size: parsed.data.partySize,
    p_reservation_time: reservationTimeUtc,
    p_notes: parsed.data.notes || null,
  });

  if (error) {
    // A refusal the diner can act on (a past time, too many requests) is
    // still worth reporting: a spike in them is how a broken date picker
    // or a bad timezone conversion announces itself.
    reportError(error, {
      scope: "reservations.request",
      extra: { restaurantId },
    });
    return { error: parseReservationError(error.message) };
  }

  revalidatePath(`/dashboard/reservations`);

  return { reservationId: (data as { id: string } | null)?.id };
}
