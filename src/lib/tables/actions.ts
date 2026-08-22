"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined, toBoolean } from "@/lib/forms/form-data";
import { tableSchema } from "./schema";

export interface TableFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parse(formData: FormData) {
  return tableSchema.safeParse({
    tableNumber: formData.get("tableNumber"),
    displayName: emptyToUndefined(formData.get("displayName")),
    isActive: toBoolean(formData.get("isActive")),
  });
}

export async function createTable(
  restaurantId: string,
  _prevState: TableFormState,
  formData: FormData,
): Promise<TableFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.from("tables").insert({
    restaurant_id: restaurantId,
    table_number: parsed.data.tableNumber,
    display_name: parsed.data.displayName ?? null,
    is_active: parsed.data.isActive,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        fieldErrors: {
          tableNumber: ["A table with that number already exists."],
        },
      };
    }
    return { error: toFriendlyError(error, "table") };
  }

  revalidatePath("/dashboard/tables");
  redirect("/dashboard/tables");
}

export async function updateTable(
  restaurantId: string,
  tableId: string,
  _prevState: TableFormState,
  formData: FormData,
): Promise<TableFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("tables")
    .update({
      table_number: parsed.data.tableNumber,
      display_name: parsed.data.displayName ?? null,
      is_active: parsed.data.isActive,
    })
    .eq("id", tableId)
    .eq("restaurant_id", restaurantId);

  if (error) {
    if (error.code === "23505") {
      return {
        fieldErrors: {
          tableNumber: ["A table with that number already exists."],
        },
      };
    }
    return { error: toFriendlyError(error, "table") };
  }

  revalidatePath("/dashboard/tables");
  redirect("/dashboard/tables");
}

export async function deleteTable(
  restaurantId: string,
  tableId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("tables")
    .delete()
    .eq("id", tableId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "table") };

  revalidatePath("/dashboard/tables");
  return {};
}

/**
 * Assigns a fresh random public_token, immediately invalidating any
 * previously-printed QR code for this table — anyone scanning the old
 * code will get an unresolvable token from that moment on (see
 * get_table_by_token() in the migrations, and docs/security.md#qr-tokens).
 * Goes through the same owner/manager RLS-respecting path as every other
 * table edit — no special privilege needed to rotate a token.
 */
export async function regenerateTableToken(
  restaurantId: string,
  tableId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("tables")
    .update({ public_token: crypto.randomUUID() })
    .eq("id", tableId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "table") };

  revalidatePath("/dashboard/tables");
  revalidatePath(`/dashboard/tables/${tableId}/qr`);
  return {};
}

export async function toggleTableActive(
  restaurantId: string,
  tableId: string,
  nextValue: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  await auth.context.supabase
    .from("tables")
    .update({ is_active: nextValue })
    .eq("id", tableId)
    .eq("restaurant_id", restaurantId);

  revalidatePath("/dashboard/tables");
}
