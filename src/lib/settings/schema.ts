import { z } from "zod";
import {
  AI_INSTRUCTIONS_MAX_LENGTH,
  AI_TONES,
  tidyAiInstructions,
} from "@/lib/ai/persona";

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

/**
 * Phase D. The note is normalised BEFORE its length is checked, so a note
 * that is long only because of pasted line breaks is not rejected for
 * whitespace the owner cannot see — and so what is validated is exactly
 * what is stored (see tidyAiInstructions for what that does). Tidied, not
 * capped: an over-long note is refused, never silently cut mid-sentence.
 */
export const aiPersonaSchema = z.object({
  tone: z.enum(AI_TONES, "Pick a tone."),
  instructions: z
    .string()
    .max(
      AI_INSTRUCTIONS_MAX_LENGTH * 4,
      `Keep the note under ${AI_INSTRUCTIONS_MAX_LENGTH} characters.`,
    )
    .optional()
    .transform((value) => tidyAiInstructions(value))
    .refine(
      (value) => value === null || value.length <= AI_INSTRUCTIONS_MAX_LENGTH,
      `Keep the note under ${AI_INSTRUCTIONS_MAX_LENGTH} characters.`,
    ),
});

export type AiPersonaInput = z.infer<typeof aiPersonaSchema>;
