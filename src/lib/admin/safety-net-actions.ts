"use server";

import { revalidatePath } from "next/cache";
import { clearSafetyNetCache } from "@/lib/ai/safety-net";
import {
  SAFETY_NET_JOBS,
  switchName,
  type SafetyNetJob,
} from "@/lib/ai/safety-net-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import {
  runSafetyNetCheck,
  type SafetyNetCheckSummary,
} from "./safety-net-check";

/** The Admin page's safety net cards: each job's on/off switch and "Check now" (docs/admin.md). */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

type Store = {
  from: (t: "platform_switches") => {
    upsert: (
      row: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
};

function isJob(job: unknown): job is SafetyNetJob {
  return (SAFETY_NET_JOBS as readonly unknown[]).includes(job);
}

export async function setSafetyNetEnabled(
  job: SafetyNetJob,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isJob(job) || typeof enabled !== "boolean") {
    return { ok: false, error: "That isn't a valid setting." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const store = createAdminClient() as unknown as Store;
  const { error } = await store.from("platform_switches").upsert({
    name: switchName(job),
    enabled,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  });
  if (error) return { ok: false, error: "Couldn't save. Please try again." };

  console.info(
    JSON.stringify({
      event: "safety_net_switched",
      job,
      enabled,
      by: user.id,
    }),
  );
  clearSafetyNetCache();
  revalidatePath("/admin");
  return { ok: true };
}

export async function checkSafetyNetNow(
  job: SafetyNetJob,
): Promise<SafetyNetCheckSummary | { error: string }> {
  if (!isJob(job)) return { error: "That isn't a valid job." };
  const user = await platformAdminForAction();
  if (!user) return { error: NOT_ALLOWED };
  const summary = await runSafetyNetCheck(job);
  revalidatePath("/admin");
  return summary;
}
