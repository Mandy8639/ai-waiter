import { BUSY_FOR_MINUTES } from "@/lib/kitchen/busy-core";
import type { StaffAction } from "./intent";
import type { RunResult } from "./plan-core";

/**
 * Running an action: every change goes through a function or policy the
 * dashboard already uses, called as the signed-in person — so their role
 * and Row Level Security decide, exactly as if they'd tapped the button
 * themselves. This file adds no way to change anything; it only chooses
 * which existing one to call. No `server-only`, per the extract-the-core
 * convention: the database is passed in.
 */

export interface DbError {
  message: string;
  code?: string;
}

export interface AssistantDb {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: DbError | null }>;
  /**
   * menu_items.price, through the same UPDATE policy as the edit form.
   * Returns the ids actually updated: RLS refuses by updating nothing.
   */
  updateDishPrice(
    restaurantId: string,
    dishId: string,
    price: number,
  ): Promise<{ updatedIds: string[]; error: DbError | null }>;
}

/** One database call, as recorded in staff_assistant_commands.tool_calls. */
export interface ToolCall {
  fn: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export type ExecuteOutcome =
  | { ok: true; calls: ToolCall[]; result: RunResult }
  | { ok: false; calls: ToolCall[]; error: string };

export async function executeAction(
  db: AssistantDb,
  restaurantId: string,
  action: StaffAction,
): Promise<ExecuteOutcome> {
  const calls: ToolCall[] = [];

  async function call(fn: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(fn, args);
    calls.push({
      fn,
      args,
      ok: !error,
      ...(error ? { error: error.message } : {}),
    });
    return { data, error };
  }

  const failed = (error: string): ExecuteOutcome => ({
    ok: false,
    calls,
    error,
  });
  const NOT_CHANGED =
    "Couldn't make that change, so nothing was changed. Please try again.";

  switch (action.kind) {
    case "dish_sold_out": {
      if (action.until === "next_opening") {
        const { data, error } = await call(
          "set_menu_item_sold_out_until_next_opening",
          { p_menu_item_id: action.dishId },
        );
        if (error || typeof data !== "string") return failed(NOT_CHANGED);
        return {
          ok: true,
          calls,
          result: { backAt: new Date(data).toISOString() },
        };
      }
      const { error } = await call("set_menu_item_availability", {
        p_menu_item_id: action.dishId,
        p_available: false,
      });
      return error ? failed(NOT_CHANGED) : { ok: true, calls, result: {} };
    }

    case "dish_back": {
      const { error } = await call("set_menu_item_availability", {
        p_menu_item_id: action.dishId,
        p_available: true,
      });
      return error ? failed(NOT_CHANGED) : { ok: true, calls, result: {} };
    }

    case "options_sold_out":
    case "options_back": {
      // One at a time: each is its own switch. If one fails partway, say
      // so plainly instead of claiming the whole change.
      let changed = 0;
      for (const optionId of action.optionIds) {
        const { error } = await call("set_modifier_option_availability", {
          p_option_id: optionId,
          p_available: action.kind === "options_back",
        });
        if (error) {
          return failed(
            changed === 0
              ? NOT_CHANGED
              : `Only ${changed} of ${action.optionIds.length} were changed before an error. Check the Sold out page.`,
          );
        }
        changed += 1;
      }
      return { ok: true, calls, result: {} };
    }

    case "pause": {
      const { data, error } = await call("pause_new_orders", {
        p_restaurant_id: restaurantId,
        p_minutes: action.minutes,
      });
      if (error) return failed(NOT_CHANGED);
      const until =
        typeof data === "string"
          ? data === "infinity"
            ? "infinity"
            : new Date(data).toISOString()
          : undefined;
      return { ok: true, calls, result: { pausedUntil: until } };
    }

    case "resume": {
      const { error } = await call("resume_new_orders", {
        p_restaurant_id: restaurantId,
      });
      return error ? failed(NOT_CHANGED) : { ok: true, calls, result: {} };
    }

    case "busy": {
      const { error } = await call("set_kitchen_busy", {
        p_restaurant_id: restaurantId,
        p_extra_minutes: action.extraMinutes,
        p_for_minutes: BUSY_FOR_MINUTES,
      });
      return error ? failed(NOT_CHANGED) : { ok: true, calls, result: {} };
    }

    case "set_price": {
      const args = { menu_item_id: action.dishId, price: action.price };
      const { updatedIds, error } = await db.updateDishPrice(
        restaurantId,
        action.dishId,
        action.price,
      );
      const ok = !error && updatedIds.includes(action.dishId);
      calls.push({
        fn: "update menu_items.price",
        args,
        ok,
        ...(ok
          ? {}
          : { error: error?.message ?? "no row updated (not allowed)" }),
      });
      return ok ? { ok: true, calls, result: {} } : failed(NOT_CHANGED);
    }
  }
}
