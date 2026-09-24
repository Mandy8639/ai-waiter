"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isInviteToken } from "@/lib/staff/invitations-core";

/**
 * Supabase Auth's own error messages ("Invalid login credentials", "User
 * already registered") are already written to be user-safe, so they're
 * passed through as-is. Anything else — network failures, an unreachable
 * project, a client-library error like "fetch failed" — is not something a
 * user should see verbatim; those become a generic message instead.
 */
function friendlyAuthError(error: AuthError): string {
  const knownSafe = [
    "credentials",
    "already registered",
    "not confirmed",
    "rate limit",
    "password",
  ];
  const lower = error.message.toLowerCase();
  if (knownSafe.some((phrase) => lower.includes(phrase))) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

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

const signInSchema = z.object({
  email: emailSchema,
  password: signInPasswordSchema,
});
const signUpSchema = z.object({
  email: emailSchema,
  password: signUpPasswordSchema,
});

/**
 * Where to send someone after they authenticate.
 *
 * Deliberately NOT a general `redirectTo` parameter. The only off-the-happy-
 * path destination this app needs is a staff invitation, and a 64-hex token
 * validated against INVITE_TOKEN_PATTERN and then interpolated into a fixed
 * path cannot express an external URL, a protocol-relative one, or a path
 * traversal — which is exactly what a general redirect parameter would have
 * to be defended against.
 */
function destinationAfterAuth(formData: FormData, fallback: string): string {
  const token = formData.get("inviteToken");
  return isInviteToken(token) ? `/join/${token}` : fallback;
}

export interface AuthFormState {
  error?: string;
  message?: string;
  fieldErrors?: Partial<Record<"email" | "password", string[]>>;
}

export async function signIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: friendlyAuthError(error) };
  }

  redirect(destinationAfterAuth(formData, "/dashboard"));
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp(parsed.data);

  if (error) {
    return { error: friendlyAuthError(error) };
  }

  // If the project requires email confirmation, signUp() succeeds but
  // returns no session — there's nothing to redirect into yet.
  if (!data.session) {
    return {
      message: isInviteToken(formData.get("inviteToken"))
        ? // The invitation is not lost: it stays pending, so opening the
          // original link again after confirming picks up where they left
          // off. Saying so beats leaving them wondering.
          "Check your email to confirm your account, then open the invitation link again."
        : "Check your email to confirm your account, then sign in.",
    };
  }

  // A new hire joining someone else's restaurant must not be asked to
  // create one of their own, which is what /onboarding would do.
  redirect(destinationAfterAuth(formData, "/onboarding"));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
