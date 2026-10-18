"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { AuthError } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/tables/qr";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  newPasswordSchema,
} from "@/lib/auth/auth-schemas";
import { RESET_PASSWORD_PATH } from "@/lib/auth/password-reset-core";
import {
  clearResetMarker,
  hasValidResetMarker,
} from "@/lib/auth/password-reset-server";

/**
 * Changing a password while signed in (/account), and choosing a new one
 * after "Forgot password?" (/forgot-password, then the emailed link, then
 * /reset-password). Rules: src/lib/auth/password-reset-core.ts.
 *
 * After either, every other device signed in to the account is signed out:
 * if someone else had the old password, their session ends too.
 */

export interface PasswordFormState {
  error?: string;
  message?: string;
  fieldErrors?: Partial<
    Record<
      "email" | "currentPassword" | "newPassword" | "confirmPassword",
      string[]
    >
  >;
}

/** Supabase's own wording for these two is already right for people. */
function friendlyPasswordError(error: AuthError): string {
  if (error.code === "same_password") {
    return "Choose a password different from your current one.";
  }
  if (error.code === "weak_password") return error.message;
  return "Couldn't change the password. Please try again.";
}

/**
 * Whether `password` is this account's current password, checked with a
 * separate, throwaway sign-in so the person's own session (and its
 * two-step level) is left exactly as it was. Supabase's "Require current
 * password when updating" setting is off on this project, so this is the
 * check.
 */
async function isCurrentPassword(
  email: string,
  password: string,
): Promise<boolean> {
  const probe = createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await probe.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) return false;
  // End only the throwaway session.
  await probe.auth.signOut({ scope: "local" });
  return true;
}

export async function changePassword(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || user.is_anonymous === true) {
    return { error: "Please sign in again." };
  }

  if (!(await isCurrentPassword(user.email, parsed.data.currentPassword))) {
    return {
      fieldErrors: { currentPassword: ["That isn't your current password."] },
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (error) return { error: friendlyPasswordError(error) };

  await supabase.auth.signOut({ scope: "others" });
  return {
    message:
      "Password changed. Any other devices signed in to this account have been signed out.",
  };
}

const RESET_SENT_MESSAGE =
  "If there's an account for that email, we've sent a link to reset the password. It works for 1 hour. Check your spam folder if it doesn't arrive.";

export async function requestPasswordReset(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const parsed = forgotPasswordSchema.safeParse({
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const origin = await getRequestOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    { redirectTo: `${origin}/auth/confirm?next=${RESET_PASSWORD_PATH}` },
  );
  if (error) {
    // Logged, never shown: what Supabase says (rate limits included) can
    // reveal whether an account exists for that email.
    console.error("[password-reset] request failed:", error.code ?? error.name);
  }

  // The same answer either way, so this can't be used to find out who
  // has an account.
  return { message: RESET_SENT_MESSAGE };
}

export async function setNewPassword(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const parsed = newPasswordSchema.safeParse({
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await hasValidResetMarker(user.id))) {
    return {
      error:
        "This reset link has expired. Request a new one from the sign-in page.",
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (error) return { error: friendlyPasswordError(error) };

  await clearResetMarker();
  await supabase.auth.signOut({ scope: "others" });
  redirect("/dashboard");
}
