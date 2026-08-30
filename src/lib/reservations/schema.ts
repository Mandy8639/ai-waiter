import { z } from "zod";

/**
 * `reservation_time` comes from a plain `<input type="datetime-local">`
 * (e.g. "2027-01-15T19:00") — no timezone offset. v1 explicit choice:
 * treat that wall-clock value as-is (append "Z", store as UTC) rather
 * than converting through any timezone, since this app doesn't model a
 * restaurant's timezone anywhere yet. What staff type is what's stored
 * and what's displayed back — see src/lib/reservations/format.ts.
 */
const reservationTimeSchema = z
  .string()
  .trim()
  .min(1, "Choose a reservation date and time.")
  .transform((value, ctx) => {
    // "YYYY-MM-DDTHH:mm" (16 chars, most browsers) needs ":00" for
    // seconds before the "Z"; a browser that already includes seconds
    // (19 chars) just needs the "Z".
    const withSeconds = value.length === 16 ? `${value}:00` : value;
    const date = new Date(`${withSeconds}Z`);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "That's not a valid date/time.",
      });
      return z.NEVER;
    }
    return date.toISOString();
  });

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

export const reservationStatusSchema = z.enum([
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
]);
