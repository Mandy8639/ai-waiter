import { z } from "zod";

/**
 * What a staff command means, before anything is looked up or changed.
 * Produced by the built-in phrases (parse-core.ts) or, when those don't
 * understand, by the model (interpret-core.ts) — both are held to this
 * schema, and nothing downstream knows which one read it.
 *
 * `target` is the dish or add-on as typed ("the salmon"). It is matched
 * against the menu by resolve-core.ts, never trusted as an id.
 */

/** Longest command kept (the log's limit). */
export const MAX_COMMAND_LENGTH = 500;

/** A dish's price, in dollars, as the menu stores it. */
export const PRICE_MAX = 10_000;

export const staffIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sold_out"),
    target: z.string().trim().min(1).max(120),
    /** next_opening: back by itself when the restaurant next opens. */
    until: z.enum(["next_opening", "manual"]),
  }),
  z.object({
    kind: z.literal("back"),
    target: z.string().trim().min(1).max(120),
  }),
  z.object({
    kind: z.literal("pause"),
    /** Null: until someone resumes. */
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .nullable(),
  }),
  z.object({ kind: z.literal("resume") }),
  z.object({
    kind: z.literal("busy"),
    extraMinutes: z.number().int().min(1).max(240),
  }),
  z.object({ kind: z.literal("busy_off") }),
  z.object({
    kind: z.literal("set_price"),
    target: z.string().trim().min(1).max(120),
    price: z.number().min(0).max(PRICE_MAX),
  }),
  z.object({ kind: z.literal("status") }),
  /** How service is going: tables with orders, the kitchen's queue, who's waiting. Read only. */
  z.object({ kind: z.literal("service") }),
  /** "Hi", or "thanks". */
  z.object({ kind: z.literal("greeting"), thanks: z.boolean() }),
  z.object({ kind: z.literal("help") }),
  z.object({ kind: z.literal("unknown") }),
]);

export type StaffIntent = z.infer<typeof staffIntentSchema>;

/**
 * A change the server can make, with every dish and add-on already
 * resolved to ids. This is what Yes, Undo and "which one?" buttons carry
 * back, so it is validated again (and the ids re-checked against the
 * restaurant's own menu) every time it arrives.
 */
const id = z.uuid();

export const staffActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dish_sold_out"),
    dishId: id,
    until: z.enum(["next_opening", "manual"]),
  }),
  z.object({ kind: z.literal("dish_back"), dishId: id }),
  z.object({
    kind: z.literal("options_sold_out"),
    optionIds: z.array(id).min(1).max(50),
  }),
  z.object({
    kind: z.literal("options_back"),
    optionIds: z.array(id).min(1).max(50),
  }),
  z.object({
    kind: z.literal("pause"),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .nullable(),
  }),
  z.object({ kind: z.literal("resume") }),
  /** 0 clears it. */
  z.object({
    kind: z.literal("busy"),
    extraMinutes: z.number().int().min(0).max(240),
  }),
  z.object({
    kind: z.literal("set_price"),
    dishId: id,
    price: z.number().min(0).max(PRICE_MAX),
  }),
]);

export type StaffAction = z.infer<typeof staffActionSchema>;
