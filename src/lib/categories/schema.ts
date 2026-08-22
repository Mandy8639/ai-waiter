import { z } from "zod";

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  description: z.string().trim().max(2000).optional(),
  displayOrder: z
    .number()
    .int("Display order must be a whole number.")
    .min(0, "Display order must be 0 or more."),
  isActive: z.boolean(),
});

export type CategoryInput = z.infer<typeof categorySchema>;
