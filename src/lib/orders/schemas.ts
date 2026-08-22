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
