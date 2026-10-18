import { z } from "zod";

/**
 * Sign-in and sign-up validation. Kept out of actions.ts because a
 * "use server" file may only export async functions, and the rules are
 * unit-tested directly.
 */

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required.")
  .email("Enter a valid email address.");
const signInPasswordSchema = z.string().min(1, "Password is required.");
const signUpPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.");

export const PASSWORD_MISMATCH_MESSAGE = "Passwords don't match.";

export const signInSchema = z.object({
  email: emailSchema,
  password: signInPasswordSchema,
});

/**
 * Also checked in the browser before submitting (src/components/auth/
 * auth-form.tsx), so a typo doesn't clear the form; this is the check that
 * counts.
 */
export const signUpSchema = z
  .object({
    email: emailSchema,
    password: signUpPasswordSchema,
    confirmPassword: z.string().min(1, "Type your password again."),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: PASSWORD_MISMATCH_MESSAGE,
    path: ["confirmPassword"],
  });

/** "Forgot password?": just the email. */
export const forgotPasswordSchema = z.object({ email: emailSchema });

/** Choosing a new password after a reset link: twice, matching. */
export const newPasswordSchema = z
  .object({
    newPassword: signUpPasswordSchema,
    confirmPassword: z.string().min(1, "Type your new password again."),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: PASSWORD_MISMATCH_MESSAGE,
    path: ["confirmPassword"],
  });

/** "Change password" on /account: the current one, then the new one twice. */
export const changePasswordSchema = z
  .object({
    currentPassword: signInPasswordSchema,
    newPassword: signUpPasswordSchema,
    confirmPassword: z.string().min(1, "Type your new password again."),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: PASSWORD_MISMATCH_MESSAGE,
    path: ["confirmPassword"],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "Choose a password different from your current one.",
    path: ["newPassword"],
  });
