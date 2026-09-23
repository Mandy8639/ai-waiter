"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveCustomerSession } from "@/lib/customer/session";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { isRequestKind, requestErrorMessage, type RequestKind } from "./core";

/**
 * Server actions for the diner -> staff channel.
 *
 * Thin by design: every rule that matters — which table, one open request
 * per kind, the rolling cap — lives in create_table_request() and is
 * tested against real Postgres in
 * tests/integration/db/table-requests.test.ts. This file binds those
 * functions to the request-scoped Supabase client and turns their error
 * codes into sentences.
 *
 * Note what is NOT passed to the database: no restaurant id, no table id.
 * A diner's request is raised entirely from their own session, so there is
 * no argument a client could tamper with to summon staff to another
 * restaurant's table. The only choice the caller makes is the kind.
 */

const MEMBERS = ["owner", "manager", "kitchen", "staff"] as const;

/**
 * database.types.ts predates this migration, so the generated client types
 * reject these functions by name. Confined to one helper and named so it
 * is obvious, exactly as in src/lib/menu-images/actions.ts.
 */
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(supabase: Awaited<ReturnType<typeof createClient>>): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

export interface RequestServiceResult {
  ok: boolean;
  error?: string;
  requestId?: string;
}

/**
 * A diner asks for something.
 *
 * Asking twice returns the first request rather than an error: from the
 * table's side, tapping again is impatience, not a mistake, and telling
 * someone off for it would be absurd. The database decides that; this
 * action just reports success either way.
 */
export async function requestService(
  kind: RequestKind,
  note?: string,
): Promise<RequestServiceResult> {
  if (!isRequestKind(kind)) {
    return {
      ok: false,
      error: requestErrorMessage("TABLE_REQUEST_INVALID_KIND"),
    };
  }

  const session = await requireActiveCustomerSession();
  if (!session.ok) {
    return {
      ok: false,
      error: requestErrorMessage("TABLE_REQUEST_NO_SESSION"),
    };
  }

  const supabase = await createClient();
  const { data, error } = await rpc(supabase)("create_table_request", {
    p_kind: kind,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: requestErrorMessage(error.message) };

  return { ok: true, requestId: data as string };
}

/** The diner taking it back — "never mind, we found someone". */
export async function cancelServiceRequest(
  requestId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireActiveCustomerSession();
  if (!session.ok) {
    return {
      ok: false,
      error: requestErrorMessage("TABLE_REQUEST_NO_SESSION"),
    };
  }

  const supabase = await createClient();
  const { error } = await rpc(supabase)("cancel_table_request", {
    p_request_id: requestId,
  });
  if (error) return { ok: false, error: requestErrorMessage(error.message) };
  return { ok: true };
}

/**
 * Staff marks a request dealt with. Any member of the restaurant, because
 * answering a table is what floor staff do — this is not a manager action.
 */
export async function resolveServiceRequest(
  restaurantId: string,
  requestId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MEMBERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  const { error } = await rpc(auth.context.supabase)("resolve_table_request", {
    p_request_id: requestId,
  });
  if (error) return { ok: false, error: requestErrorMessage(error.message) };

  revalidatePath("/dashboard");
  return { ok: true };
}

export interface OpenRequest {
  id: string;
  kind: RequestKind;
  note: string | null;
  createdAt: string;
  tableId: string;
  tableNumber: string;
  tableDisplayName: string | null;
}

/**
 * The staff queue. Called from the server on first render and again from
 * the browser on every realtime event, so it is the single definition of
 * "what is waiting" rather than two that can drift.
 */
export async function loadOpenRequests(
  restaurantId: string,
): Promise<OpenRequest[]> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MEMBERS]);
  if (!auth.ok) return [];

  const { data, error } = await rpc(auth.context.supabase)(
    "get_open_table_requests",
    { p_restaurant_id: restaurantId },
  );
  if (error || !Array.isArray(data)) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    kind: row.kind as RequestKind,
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as string,
    tableId: row.table_id as string,
    tableNumber: row.table_number as string,
    tableDisplayName: (row.table_display_name as string | null) ?? null,
  }));
}
