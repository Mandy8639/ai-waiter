import { z } from "zod";

export const restaurantProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  description: z.string().trim().max(2000).optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  timezone: z.string().trim().min(1, "Timezone is required.").max(100),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter code (e.g. "USD").'),
  taxRate: z
    .number("Enter a tax rate.")
    // Stored as a fraction; the form collects a percentage and converts.
    .min(0, "Must be 0% or more.")
    .max(1, "Must be 100% or less."),
  serviceCharge: z
    .number("Enter a service charge.")
    .min(0, "Must be 0% or more.")
    .max(1, "Must be 100% or less."),
});

export type RestaurantProfileInput = z.infer<typeof restaurantProfileSchema>;

export const operationalSettingsSchema = z.object({
  acceptingOrders: z.boolean(),
  allowCustomerNotes: z.boolean(),
  allowAiRecommendations: z.boolean(),
  allowUpselling: z.boolean(),
  maxOrderItems: z
    .number("Enter a number.")
    .int("Whole numbers only.")
    .min(1, "Must be at least 1."),
});

export type OperationalSettingsInput = z.infer<
  typeof operationalSettingsSchema
>;
