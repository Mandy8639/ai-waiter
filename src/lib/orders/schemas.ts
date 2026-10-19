import { z } from "zod";

/**
 * Both fields are the only two inputs submit_order() (the Postgres
 * function) accepts — no cart id, no line items, no prices. See
 * src/lib/orders/submit-order.ts and the migration for why.
 */
export const submitOrderSchema = z.object({
  idempotencyKey: z
    .string()
    .trim()
    .min(1, "Missing idempotency key.")
    .max(100, "Idempotency key is too long."),
  customerNote: z
    .string()
    .trim()
    .max(500, "Note is too long (500 characters max).")
    .optional(),
});

export type SubmitOrderInput = z.infer<typeof submitOrderSchema>;

/**
 * A pickup choice (20261022090000_pickup_ordering.sql). Only shape is
 * checked here; whether the time is a real, open, not-full slot is the
 * database's question, asked again when the order is placed.
 */
export const pickupChoiceSchema = z.object({
  at: z.iso.datetime({ offset: true, error: "Choose a pickup time." }),
  name: z
    .string()
    .trim()
    .min(1, "Add the name we should call out at pickup.")
    .max(40, "Please keep the name to 40 characters."),
});

export type PickupChoice = z.infer<typeof pickupChoiceSchema>;
