import { z } from "zod";
import { WALL_CLOCK_PATTERN } from "./timezone";

/**
 * Kept as the raw wall-clock string the browser produced (e.g.
 * "2027-01-15T19:00"), deliberately NOT converted here: turning it into a
 * real instant needs the restaurant's own timezone, which lives in the
 * database, so that step belongs in actions.ts via
 * src/lib/reservations/timezone.ts. Validating only the shape here keeps
 * this schema pure and the conversion in exactly one place.
 */
const reservationTimeSchema = z
  .string()
  .trim()
  .min(1, "Choose a reservation date and time.")
  .regex(WALL_CLOCK_PATTERN, "That's not a valid date/time.");

export const createReservationSchema = z.object({
  tableId: z.uuid("Choose a table."),
  customerName: z.string().trim().min(1, "Enter the customer's name."),
  customerPhone: z.string().trim().min(1, "Enter the customer's phone number."),
  customerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email.")
    .optional()
    .or(z.literal("")),
  partySize: z.coerce
    .number()
    .int("Party size must be a whole number.")
    .min(1, "Party size must be at least 1."),
  reservationTime: reservationTimeSchema,
  notes: z
    .string()
    .trim()
    .max(500, "Keep notes under 500 characters.")
    .optional(),
});

export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const updateReservationDetailsSchema = z.object({
  customerName: z.string().trim().min(1, "Enter the customer's name."),
  customerPhone: z.string().trim().min(1, "Enter the customer's phone number."),
  customerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email.")
    .optional()
    .or(z.literal("")),
  partySize: z.coerce
    .number()
    .int("Party size must be a whole number.")
    .min(1, "Party size must be at least 1."),
  notes: z
    .string()
    .trim()
    .max(500, "Keep notes under 500 characters.")
    .optional(),
});

export type UpdateReservationDetailsInput = z.infer<
  typeof updateReservationDetailsSchema
>;

/**
 * What a diner supplies. Deliberately not createReservationSchema minus a
 * field: that one requires a tableId, and the entire point of a request is
 * that nobody has chosen a table yet.
 *
 * The upper bound on party size mirrors request_reservation()'s own, so a
 * large party is turned away with a sentence about phoning rather than a
 * database exception.
 */
export const requestReservationSchema = z.object({
  customerName: z.string().trim().min(1, "Enter your name."),
  customerPhone: z
    .string()
    .trim()
    .min(1, "Enter a phone number so the restaurant can reach you."),
  customerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email.")
    .optional()
    .or(z.literal("")),
  partySize: z.coerce
    .number()
    .int("Party size must be a whole number.")
    .min(1, "There has to be at least one of you.")
    .max(50, "For a party this size, please call the restaurant."),
  reservationTime: reservationTimeSchema,
  notes: z
    .string()
    .trim()
    .max(500, "Keep notes under 500 characters.")
    .optional(),
});

export type RequestReservationInput = z.infer<typeof requestReservationSchema>;

export const confirmReservationRequestSchema = z.object({
  tableId: z.uuid("Choose a table."),
});

export const reservationStatusSchema = z.enum([
  "pending",
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
]);
