import { z } from "zod";

export const addToCartSchema = z.object({
  menuItemId: z.string().trim().min(1, "Missing item."),
  quantity: z
    .number("Enter a quantity.")
    .int("Whole numbers only.")
    .min(1, "Quantity must be at least 1.")
    .max(99, "Quantity is too high."),
  selectedOptionIds: z.array(z.string().trim().min(1)),
  // How the DINER wants it, which is a different fact from how the dish is
  // normally made — see 20260905180000_per_line_spice_and_notes.sql.
  // Undefined means "however you normally make it".
  spicePreference: z
    .enum(["none", "mild", "medium", "hot", "very_hot"])
    .optional(),
  notes: z
    .string()
    .trim()
    .max(200, "Please keep this under 200 characters.")
    .optional(),
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
