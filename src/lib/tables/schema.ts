import { z } from "zod";

export const tableSchema = z.object({
  tableNumber: z.string().trim().min(1, "Table number is required.").max(50),
  displayName: z.string().trim().max(100).optional(),
  isActive: z.boolean(),
  /** A place diners sit, or a pickup counter (20261022090000_pickup_ordering.sql). */
  kind: z.enum(["table", "counter"]).default("table"),
});

export type TableInput = z.infer<typeof tableSchema>;
