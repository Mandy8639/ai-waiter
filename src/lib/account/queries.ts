import "server-only";
import { createClient } from "@/lib/supabase/server";

// database.types.ts predates 20261010090000, so the new function is
// reached through an untyped handle.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface AccountOverview {
  email: string;
  /** Restaurants where this person is the only owner: deletion waits on these. */
  soleOwned: { id: string; name: string }[];
  /** The authenticator-app factor, when two-step verification is on. */
  twoFactorFactorId: string | null;
}

/** For the Account page. Null when nobody (or only a diner) is signed in. */
export async function getAccountOverview(): Promise<AccountOverview | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous === true) return null;

  const { data, error } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(
    "get_my_sole_owned_restaurants",
  );
  if (error) throw new Error(error.message);

  return {
    email: user.email ?? "",
    soleOwned: (data as { id: string; name: string }[] | null) ?? [],
    twoFactorFactorId:
      user.factors?.find(
        (f) => f.factor_type === "totp" && f.status === "verified",
      )?.id ?? null,
  };
}
