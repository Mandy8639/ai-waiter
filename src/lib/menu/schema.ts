import { z } from "zod";

export const spiceLevels = [
  "none",
  "mild",
  "medium",
  "hot",
  "very_hot",
] as const;

export const menuItemSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Slug must be lowercase kebab-case (e.g. "chicken-tikka").',
    ),
  categoryId: z.string().trim().min(1, "Choose a category."),
  description: z.string().trim().max(2000).optional(),
  price: z.number("Enter a price.").min(0, "Price must be 0 or more."),
  imageUrl: z.string().trim().max(2000).optional(),
  isAvailable: z.boolean(),
  isVegetarian: z.boolean(),
  isVegan: z.boolean(),
  isSpicy: z.boolean(),
  spiceLevel: z.enum(spiceLevels).optional(),
  containsNuts: z.boolean(),
  containsDairy: z.boolean(),
  containsGluten: z.boolean(),
  preparationTime: z
    .number()
    .int("Whole minutes only.")
    .min(0, "Preparation time must be 0 or more.")
    .optional(),
  displayOrder: z
    .number()
    .int("Display order must be a whole number.")
    .min(0, "Display order must be 0 or more."),
});

export type MenuItemInput = z.infer<typeof menuItemSchema>;
