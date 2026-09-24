"use server";
import "server-only";

import { z } from "zod";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/tables/qr";
import { CURRENT_RESTAURANT_COOKIE } from "@/lib/restaurants/current-restaurant";
import { restaurantRoleSchema } from "./schema";
import {
  buildInviteUrl,
  isInviteToken,
  toInvitationError,
} from "./invitations-core";

/**
 * database.types.ts predates 20260926090000, so the generated client types
 * reject these functions by name. Confined to one helper and named so it is
 * obvious, exactly as in src/lib/table-requests/actions.ts.
 */
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(supabase: Awaited<ReturnType<typeof createClient>>): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

const createInvitationSchema = z.object({
  role: restaurantRoleSchema,
  // Nullable rather than required: the label is the owner's own reminder,
  // and making it mandatory would only produce rows labelled "staff".
  label: z
    .string()
    .trim()
    .max(60, "Keep the note under 60 characters.")
    .optional(),
});

export interface CreateInvitationState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /**
   * The finished link, present exactly once — on the response that created
   * it. Only the hash is stored, so if this is lost the link is gone and a
   * new one has to be made. See 20260926090000_staff_invitations.sql.
   */
  inviteUrl?: string;
  invitedRole?: string;
}

export async function createInvitation(
  restaurantId: string,
  _prevState: CreateInvitationState,
  formData: FormData,
): Promise<CreateInvitationState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = createInvitationSchema.safeParse({
    role: formData.get("role"),
    label: formData.get("label") ?? undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  // Checked here as well as in the database. The DB is the authority
  // (create_staff_invitation() re-checks the caller's role itself), but a
  // manager who picks "Owner" should read why rather than a generic error.
  if (auth.context.role === "manager" && parsed.data.role === "owner") {
    return {
      error: "Managers can't invite an owner — ask an owner to do this.",
    };
  }

  const { data: token, error } = await rpc(auth.context.supabase)(
    "create_staff_invitation",
    {
      target_restaurant_id: restaurantId,
      p_role: parsed.data.role,
      p_label: parsed.data.label ?? null,
    },
  );

  if (error) return { error: toInvitationError(error.message) };
  if (typeof token !== "string" || !isInviteToken(token)) {
    // Should be unreachable: the function returns the token it just built.
    // If it ever is reached, showing a broken link is worse than saying so.
    return { error: "The invitation link could not be created. Try again." };
  }

  revalidatePath("/dashboard/staff");

  return {
    inviteUrl: buildInviteUrl(await getRequestOrigin(), token),
    invitedRole: parsed.data.role,
  };
}

export async function revokeInvitation(
  restaurantId: string,
  invitationId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await rpc(auth.context.supabase)(
    "revoke_staff_invitation",
    { p_invitation_id: invitationId },
  );

  if (error) return { error: toInvitationError(error.message) };

  revalidatePath("/dashboard/staff");
  return {};
}

/**
 * Consumes an invitation and joins the caller to the restaurant.
 *
 * Redirects into the dashboard on success rather than returning, so the
 * page that held the token is gone from the history entry the accepter
 * lands on — and so a refresh cannot replay an accept that has already
 * happened.
 */
export async function acceptInvitation(
  token: string,
): Promise<{ error?: string }> {
  if (!isInviteToken(token)) {
    return { error: "That invitation link isn't valid." };
  }

  // The database refuses both of these itself
  // (STAFF_INVITE_NOT_AUTHENTICATED / STAFF_INVITE_ANONYMOUS_CALLER). This
  // is here for the message: a diner mid-meal holds a real anonymous
  // session, and "you're browsing as a guest" is the only version of that
  // error they can act on.
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Sign in or create an account first, then try again." };
  }
  if (user.is_anonymous === true) {
    return {
      error:
        "You're browsing as a guest. Create a Tableside account or sign in, then open the link again.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await rpc(supabase)("accept_staff_invitation", {
    p_token: token,
  });

  if (error) return { error: toInvitationError(error.message) };

  // A `returns table` function comes back as an array of one row.
  const joined = (Array.isArray(data) ? data[0] : data) as
    { joined_restaurant_id?: unknown } | null | undefined;
  const joinedRestaurantId = joined?.joined_restaurant_id;

  // Land them in the restaurant they just joined rather than on the
  // "which restaurant?" chooser, which is what someone with two
  // memberships would otherwise see (see current-restaurant.ts). The
  // cookie is a default, never an authorization — it is re-validated
  // against real memberships on every request.
  if (typeof joinedRestaurantId === "string") {
    const cookieStore = await cookies();
    cookieStore.set(CURRENT_RESTAURANT_COOKIE, joinedRestaurantId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  redirect("/dashboard");
}
