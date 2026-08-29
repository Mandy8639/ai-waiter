import { z } from "zod";

export const restaurantRoleSchema = z.enum([
  "owner",
  "manager",
  "kitchen",
  "staff",
]);

export const addStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  role: restaurantRoleSchema,
});

export const updateStaffRoleSchema = z.object({
  role: restaurantRoleSchema,
});

export type AddStaffInput = z.infer<typeof addStaffSchema>;
