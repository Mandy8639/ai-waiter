import { z } from "zod";

export const tableSchema = z.object({
  tableNumber: z.string().trim().min(1, "Table number is required.").max(50),
  displayName: z.string().trim().max(100).optional(),
  isActive: z.boolean(),
});

export type TableInput = z.infer<typeof tableSchema>;
