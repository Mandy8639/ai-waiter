"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { PostgrestError } from "@supabase/supabase-js";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { addStaffSchema, updateStaffRoleSchema } from "./schema";

export interface AddStaffFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

/**
 * add_restaurant_staff_by_email()/enforce_at_least_one_owner() raise
 * specific, deliberately-worded exceptions (see
 * supabase/migrations/20260829090000_staff_management.sql) — mapped here
 * by message/code rather than through the generic
 * src/lib/errors/database-error.ts, since those messages are already
 * exactly what should reach the user, not raw Postgres detail to hide.
 */
function toStaffError(error: PostgrestError): string {
  const message = error.message.toLowerCase();
  if (message.includes("managers_cannot_grant_owner")) {
    return "Managers can't grant the owner role — ask an owner to do this.";
  }
  if (message.includes("insufficient_role")) {
    return "You don't have permission to manage staff for this restaurant.";
  }
  if (message.includes("user_not_found")) {
    return "No account found with that email. They need to sign up first, then you can add them.";
  }
  if (message.includes("invalid_role")) {
    return "That's not a valid role.";
  }
  if (message.includes("last owner")) {
    return "This restaurant needs at least one owner — add another owner first.";
  }
  if (error.code === "23505") {
    return "That person is already a member of this restaurant.";
  }
  return "Something went wrong. Please try again.";
}

export async function addStaffMember(
  restaurantId: string,
  _prevState: AddStaffFormState,
  formData: FormData,
): Promise<AddStaffFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = addStaffSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.rpc(
    "add_restaurant_staff_by_email",
    {
      target_restaurant_id: restaurantId,
      p_email: parsed.data.email,
      p_role: parsed.data.role,
    },
  );

  if (error) return { error: toStaffError(error) };

  revalidatePath("/dashboard/staff");
  return {};
}

export async function updateStaffRole(
  restaurantId: string,
  memberId: string,
  role: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, ["owner"]);
  if (!auth.ok) return { error: auth.error };

  const parsed = updateStaffRoleSchema.safeParse({ role });
  if (!parsed.success) return { error: "That's not a valid role." };

  const { error } = await auth.context.supabase
    .from("restaurant_users")
    .update({ role: parsed.data.role })
    .eq("id", memberId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toStaffError(error) };

  revalidatePath("/dashboard/staff");
  return {};
}

export async function removeStaffMember(
  restaurantId: string,
  memberId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, ["owner"]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("restaurant_users")
    .delete()
    .eq("id", memberId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toStaffError(error) };

  revalidatePath("/dashboard/staff");
  return {};
}
