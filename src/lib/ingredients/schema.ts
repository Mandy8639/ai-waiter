import { z } from "zod";

export const ingredientSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  description: z.string().trim().max(1000).optional(),
});

export type IngredientInput = z.infer<typeof ingredientSchema>;
