"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PostgrestError } from "@supabase/supabase-js";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import {
  createReservationSchema,
  updateReservationDetailsSchema,
  reservationStatusSchema,
} from "./schema";
import { parseReservationError } from "./errors";
import { zonedWallClockToUtc } from "./timezone";

export interface ReservationFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function toReservationFormError(error: PostgrestError): ReservationFormState {
  return { error: parseReservationError(error.message) };
}

/**
 * Thin application-layer wrappers around create_reservation()/
 * update_reservation_details()/transition_reservation_status() (see
 * supabase/migrations/20260829110000_reservations.sql) — every business
 * rule (role permission, the double-booking check, the status state
 * machine) lives in the database functions, matching this codebase's
 * established convention (staff/actions.ts, orders/transition.ts).
 * authorizeRestaurantAction() here only improves the error message on an
 * unauthorized attempt — the functions re-check the caller's role
 * themselves regardless, since RLS/SECURITY DEFINER is the real boundary.
 */
export async function createReservation(
  restaurantId: string,
  _prevState: ReservationFormState,
  formData: FormData,
): Promise<ReservationFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "staff",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = createReservationSchema.safeParse({
    tableId: formData.get("tableId"),
    customerName: formData.get("customerName"),
    customerPhone: formData.get("customerPhone"),
    customerEmail: formData.get("customerEmail"),
    partySize: formData.get("partySize"),
    reservationTime: formData.get("reservationTime"),
    notes: formData.get("notes"),
  });
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  // Staff type a wall-clock time; the column is a timestamptz. Convert
  // through the restaurant's own timezone rather than assuming UTC — see
  // src/lib/reservations/timezone.ts for why that distinction matters to
  // the double-booking check, not just to display.
  const { data: restaurant } = await auth.context.supabase
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

  const { error } = await auth.context.supabase.rpc("create_reservation", {
    p_restaurant_id: restaurantId,
    p_table_id: parsed.data.tableId,
    p_customer_name: parsed.data.customerName,
    p_customer_phone: parsed.data.customerPhone,
    p_customer_email: parsed.data.customerEmail || null,
    p_party_size: parsed.data.partySize,
    p_reservation_time: reservationTimeUtc,
    p_notes: parsed.data.notes ?? null,
  });

  if (error) return toReservationFormError(error);

  revalidatePath("/dashboard/reservations");
  redirect("/dashboard/reservations");
}

export async function updateReservationDetails(
  restaurantId: string,
  reservationId: string,
  _prevState: ReservationFormState,
  formData: FormData,
): Promise<ReservationFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "staff",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = updateReservationDetailsSchema.safeParse({
    customerName: formData.get("customerName"),
    customerPhone: formData.get("customerPhone"),
    customerEmail: formData.get("customerEmail"),
    partySize: formData.get("partySize"),
    notes: formData.get("notes"),
  });
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.rpc(
    "update_reservation_details",
    {
      p_reservation_id: reservationId,
      p_customer_name: parsed.data.customerName,
      p_customer_phone: parsed.data.customerPhone,
      p_customer_email: parsed.data.customerEmail || null,
      p_party_size: parsed.data.partySize,
      p_notes: parsed.data.notes ?? null,
    },
  );

  if (error) return toReservationFormError(error);

  revalidatePath("/dashboard/reservations");
  redirect("/dashboard/reservations");
}

export interface TransitionReservationResult {
  error?: string;
}

export async function transitionReservationStatus(
  restaurantId: string,
  reservationId: string,
  targetStatus: string,
): Promise<TransitionReservationResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "staff",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = reservationStatusSchema.safeParse(targetStatus);
  if (!parsed.success) return { error: "That's not a valid status." };

  const { error } = await auth.context.supabase.rpc(
    "transition_reservation_status",
    { p_reservation_id: reservationId, p_target_status: parsed.data },
  );

  if (error) return toReservationFormError(error);

  revalidatePath("/dashboard/reservations");
  return {};
}
