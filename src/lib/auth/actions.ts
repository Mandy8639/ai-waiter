"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

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

  redirect("/dashboard");
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
      message: "Check your email to confirm your account, then sign in.",
    };
  }

  redirect("/onboarding");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
