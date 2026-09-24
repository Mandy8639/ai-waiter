import "server-only";
import { createClient } from "@/lib/supabase/server";

/** One row of get_staff_invitations(). Never carries the token or its hash. */
export interface PendingInvitation {
  id: string;
  invited_role: string;
  /** The inviter's private note about who the link was for. */
  label: string | null;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
  created_by_email: string | null;
}

/**
 * Pending invitation links for a restaurant.
 *
 * get_staff_invitations() raises STAFF_INVITE_INSUFFICIENT_ROLE for anyone
 * but an owner or manager, so callers check the viewer's role first and
 * simply don't ask otherwise — an error is not the right way to render
 * "this section isn't for you".
 *
 * database.types.ts predates 20260926090000, so the RPC is reached through
 * a named cast, confined to this function — the same convention as
 * src/lib/table-requests/actions.ts.
 */
export async function getPendingInvitations(
  restaurantId: string,
): Promise<PendingInvitation[]> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("get_staff_invitations", {
    target_restaurant_id: restaurantId,
  });

  // A failure here is a section of the staff page, not the page. Returning
  // an empty list shows the "no links waiting" copy, which is wrong but
  // harmless; throwing would take the member list down with it.
  if (error) return [];

  return (data ?? []) as PendingInvitation[];
}
