import { z } from "zod";

export const modifierGroupSchema = z
  .object({
    menuItemId: z.string().trim().min(1, "Choose a menu item."),
    name: z.string().trim().min(1, "Name is required.").max(200),
    description: z.string().trim().max(1000).optional(),
    isRequired: z.boolean(),
    minSelections: z
      .number("Enter a number.")
      .int("Whole numbers only.")
      .min(0, "Must be 0 or more."),
    maxSelections: z
      .number("Enter a number.")
      .int("Whole numbers only.")
      .min(0, "Must be 0 or more."),
    displayOrder: z
      .number()
      .int("Must be a whole number.")
      .min(0, "Must be 0 or more."),
  })
  .refine((data) => data.maxSelections >= data.minSelections, {
    message:
      "Maximum selections must be greater than or equal to minimum selections.",
    path: ["maxSelections"],
  });

export type ModifierGroupInput = z.infer<typeof modifierGroupSchema>;

export const modifierOptionSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  priceAdjustment: z.number("Enter a price adjustment (can be negative)."),
  isAvailable: z.boolean(),
  displayOrder: z
    .number()
    .int("Must be a whole number.")
    .min(0, "Must be 0 or more."),
});

export type ModifierOptionInput = z.infer<typeof modifierOptionSchema>;
