import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCostRows, type CostRow, type Week } from "./cost-report-core";

/**
 * AI cost per restaurant for one week, from ai_cost_summary() (service
 * role only). Null when it couldn't be read, so the page and the email
 * say so instead of showing an empty week.
 */

type Store = {
  rpc: (
    fn: "ai_cost_summary",
    args: { p_from: string; p_to: string },
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function getCostReport(week: Week): Promise<CostRow[] | null> {
  try {
    const store = createAdminClient() as unknown as Store;
    const { data, error } = await store.rpc("ai_cost_summary", {
      p_from: week.from.toISOString(),
      p_to: week.to.toISOString(),
    });
    if (error) throw new Error(error.message);
    return parseCostRows(data);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ai_cost_report_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}
