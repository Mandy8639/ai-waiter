import { z } from "zod";

export const addToCartSchema = z.object({
  menuItemId: z.string().trim().min(1, "Missing item."),
  quantity: z
    .number("Enter a quantity.")
    .int("Whole numbers only.")
    .min(1, "Quantity must be at least 1.")
    .max(99, "Quantity is too high."),
  selectedOptionIds: z.array(z.string().trim().min(1)),
});

export type AddToCartInput = z.infer<typeof addToCartSchema>;

export const updateQuantitySchema = z.object({
  cartItemId: z.string().trim().min(1),
  quantity: z
    .number()
    .int()
    .min(1, "Quantity must be at least 1.")
    .max(99, "Quantity is too high."),
});
