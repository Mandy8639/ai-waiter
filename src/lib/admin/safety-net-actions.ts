"use server";

import { revalidatePath } from "next/cache";
import { clearSafetyNetCache } from "@/lib/ai/safety-net";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import {
  runSafetyNetCheck,
  type SafetyNetCheckSummary,
} from "./safety-net-check";

/** The Admin page's safety net card: its on/off switch and "Check now" (docs/admin.md). */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

type Store = {
  from: (t: "platform_switches") => {
    upsert: (
      row: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
};

export async function setSafetyNetEnabled(
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "That isn't a valid setting." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const store = createAdminClient() as unknown as Store;
  const { error } = await store.from("platform_switches").upsert({
    name: "waiter_safety_net",
    enabled,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  });
  if (error) return { ok: false, error: "Couldn't save. Please try again." };

  console.info(
    JSON.stringify({ event: "safety_net_switched", enabled, by: user.id }),
  );
  clearSafetyNetCache();
  revalidatePath("/admin");
  return { ok: true };
}

export async function checkSafetyNetNow(): Promise<
  SafetyNetCheckSummary | { error: string }
> {
  const user = await platformAdminForAction();
  if (!user) return { error: NOT_ALLOWED };
  const summary = await runSafetyNetCheck();
  revalidatePath("/admin");
  return summary;
}
