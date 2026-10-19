"use server";

import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import {
  MAX_COMMAND_LENGTH,
  staffActionSchema,
  type StaffAction,
  type StaffIntent,
} from "./intent";
import { parseStaffCommand } from "./parse-core";
import {
  doneText,
  HELP_TEXT,
  planAction,
  planIntent,
  replyForPlan,
  undoFor,
  type AssistantReply,
  type Plan,
  type PlanContext,
  type StaffRole,
} from "./plan-core";
import { executeAction, type ToolCall } from "./execute-core";
import { interpretWithModel, isStaffInterpreterConfigured } from "./interpret";
import {
  assistantDb,
  isRateLimited,
  loadAssistantContext,
  recordCommand,
} from "./queries";

/**
 * The staff assistant's two entry points: a typed command, and a button
 * from an earlier reply (Yes, Undo, or "which one?"). Owners, managers and
 * the kitchen account; every change runs as that person through the
 * dashboard's own functions (execute-core.ts), and every command is
 * recorded (staff_assistant_commands).
 */

const KITCHEN_SIDE = ["owner", "manager", "kitchen"] as const;

const TOO_MANY: AssistantReply = {
  text: "That's a lot of commands in a few minutes. Give it a moment, or use the Sold out and Kitchen pages directly.",
  tone: "error",
  buttons: [],
  cancellable: false,
};

/** Runs a plan if it's a "run", and words the reply either way. */
async function carryOut(
  restaurantId: string,
  plan: Plan,
  ctx: PlanContext,
  db: ReturnType<typeof assistantDb>,
): Promise<{ reply: AssistantReply; outcome: string; calls: ToolCall[] }> {
  if (plan.type !== "run") {
    return { reply: replyForPlan(plan), outcome: plan.type, calls: [] };
  }
  const result = await executeAction(db, restaurantId, plan.action);
  if (!result.ok) {
    return {
      reply: {
        text: result.error,
        tone: "error",
        buttons: [],
        cancellable: false,
      },
      outcome: "failed",
      calls: result.calls,
    };
  }
  revalidateAfter(plan.action);
  const undo = undoFor(plan.action, ctx, ctx.now);
  return {
    reply: {
      text: doneText(
        plan.action,
        ctx.catalog,
        result.result,
        ctx.timeZone,
        ctx.now,
        { hasMenuHours: ctx.hasMenuHours },
      ),
      tone: "done",
      buttons: undo ? [undo] : [],
      cancellable: false,
    },
    outcome: "applied",
    calls: result.calls,
  };
}

function revalidateAfter(action: StaffAction) {
  revalidatePath("/dashboard/kitchen", "layout");
  if (action.kind === "set_price") revalidatePath("/dashboard/menu", "layout");
  if (action.kind.startsWith("options_"))
    revalidatePath("/dashboard/modifiers");
  // Diners see sold-out dishes, pauses, waits and prices.
  revalidatePath("/r/[restaurantSlug]", "layout");
}

export async function sendStaffCommand(
  restaurantId: string,
  text: string,
): Promise<AssistantReply> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) {
    return { text: auth.error, tone: "error", buttons: [], cancellable: false };
  }
  const command = text.trim().slice(0, MAX_COMMAND_LENGTH);
  if (!command) {
    return replyForPlan({ type: "answered", text: HELP_TEXT });
  }
  const { userId } = auth.context;
  const role = auth.context.role as StaffRole;

  try {
    if (await isRateLimited(userId)) {
      await recordCommand({
        restaurantId,
        userId,
        role,
        command,
        interpretedBy: "rules",
        intent: null,
        outcome: "rate_limited",
        calls: [],
        reply: TOO_MANY.text,
      });
      return TOO_MANY;
    }

    let intent: StaffIntent = parseStaffCommand(command);
    let interpretedBy: "rules" | "ai" = "rules";
    if (intent.kind === "unknown" && isStaffInterpreterConfigured()) {
      const read = await interpretWithModel(command, restaurantId);
      if (read.intent.kind !== "unknown") {
        intent = read.intent;
        interpretedBy = "ai";
      }
    }

    const db = assistantDb(auth.context.supabase);
    const ctx: PlanContext = {
      ...(await loadAssistantContext(auth.context.supabase, restaurantId)),
      role,
      source: interpretedBy,
      now: new Date(),
    };
    const plan = planIntent(intent, ctx);
    const { reply, outcome, calls } = await carryOut(
      restaurantId,
      plan,
      ctx,
      db,
    );

    await recordCommand({
      restaurantId,
      userId,
      role,
      command,
      interpretedBy,
      intent: intent.kind === "unknown" ? null : intent,
      outcome,
      calls,
      reply: reply.text,
    });
    return reply;
  } catch (error) {
    reportError(error, {
      scope: "staff_assistant.command",
      extra: { restaurantId },
    });
    return {
      text: "Something went wrong, and I haven't changed anything. Please try again.",
      tone: "error",
      buttons: [],
      cancellable: false,
    };
  }
}

/**
 * A button from an earlier reply. The action is validated again and every
 * id re-checked against this restaurant's menu: a button's contents come
 * from the browser, so they're treated as a fresh request.
 */
export async function applyStaffAction(
  restaurantId: string,
  rawAction: unknown,
  confirmed: boolean,
  label: string,
): Promise<AssistantReply> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) {
    return { text: auth.error, tone: "error", buttons: [], cancellable: false };
  }
  const parsed = staffActionSchema.safeParse(rawAction);
  if (!parsed.success) {
    return {
      text: "That button has expired. Type the command again.",
      tone: "error",
      buttons: [],
      cancellable: false,
    };
  }
  const { userId } = auth.context;
  const role = auth.context.role as StaffRole;
  const command = (label.trim() || "Button").slice(0, 100);

  try {
    if (await isRateLimited(userId)) return TOO_MANY;

    const ctx: PlanContext = {
      ...(await loadAssistantContext(auth.context.supabase, restaurantId)),
      role,
      source: "button",
      now: new Date(),
    };
    const plan = planAction(parsed.data, ctx, {
      confirmed: confirmed === true,
    });
    const { reply, outcome, calls } = await carryOut(
      restaurantId,
      plan,
      ctx,
      assistantDb(auth.context.supabase),
    );
    await recordCommand({
      restaurantId,
      userId,
      role,
      command,
      interpretedBy: "button",
      intent: { ...parsed.data, confirmed: confirmed === true },
      outcome,
      calls,
      reply: reply.text,
    });
    return reply;
  } catch (error) {
    reportError(error, {
      scope: "staff_assistant.button",
      extra: { restaurantId },
    });
    return {
      text: "Something went wrong, and I haven't changed anything. Please try again.",
      tone: "error",
      buttons: [],
      cancellable: false,
    };
  }
}
