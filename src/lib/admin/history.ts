import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiJob } from "@/lib/ai/model-settings-core";
import { HISTORY_LIMIT, type HistoryEntry } from "./history-core";

/**
 * The Admin page's change history and saved lists, read with the
 * service-role client: both tables are server-only (no policy for any
 * signed-in role). Never cached: the page should show a change the
 * moment it is made.
 */

type Result = Promise<{ data: unknown[] | null; error: unknown }>;

type HistoryStore = {
  from: (t: "platform_settings_history") => {
    select: (c: string) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => { limit: (n: number) => Result };
    };
  };
};

type SettingsStore = {
  from: (t: "platform_settings") => { select: (c: string) => Result };
};

interface Row {
  id: string;
  job: AiJob | "all";
  action: HistoryEntry["action"];
  old_models: string[] | null;
  new_models: string[] | null;
  test_result: Record<string, unknown> | null;
  changed_by: string | null;
  changed_at: string;
}

export async function getHistory(): Promise<HistoryEntry[] | null> {
  try {
    const store = createAdminClient() as unknown as HistoryStore;
    const { data, error } = await store
      .from("platform_settings_history")
      .select(COLUMNS)
      .order("changed_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    return (data as Row[]).map(toEntry);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_history_read_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

type EntryStore = {
  from: (t: "platform_settings_history") => {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

const COLUMNS =
  "id, job, action, old_models, new_models, test_result, changed_by, changed_at";

function toEntry(r: Row): HistoryEntry {
  return {
    id: r.id,
    job: r.job,
    action: r.action,
    oldModels: r.old_models,
    newModels: r.new_models,
    testResult: r.test_result,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  };
}

export async function getHistoryEntry(
  id: string,
): Promise<HistoryEntry | null> {
  const store = createAdminClient() as unknown as EntryStore;
  const { data, error } = await store
    .from("platform_settings_history")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return toEntry(data as Row);
}

/** Each job's saved list right now (missing: nothing saved). Fresh, not the 60-second cache. */
export async function getSavedLists(): Promise<Map<AiJob, string[]>> {
  const store = createAdminClient() as unknown as SettingsStore;
  const { data, error } = await store
    .from("platform_settings")
    .select("job, models");
  if (error) throw error;
  return new Map(
    (data as { job: AiJob; models: string[] }[]).map((r) => [r.job, r.models]),
  );
}
