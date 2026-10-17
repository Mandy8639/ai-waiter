"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isInviteToken } from "@/lib/staff/invitations-core";
import { normalizeTwoFactorCode } from "@/lib/auth/two-factor-core";

/**
 * Two-step verification with an authenticator app (Supabase Auth TOTP).
 * Everything runs through the signed-in person's own session; Supabase
 * itself refuses to remove a verified factor from a session that hasn't
 * passed the code step. Rules: src/lib/auth/two-factor-core.ts.
 */

export interface TwoFactorFormState {
  error?: string;
  done?: boolean;
}

const CODE_HELP = "Enter the 6-digit code from your authenticator app.";
const WRONG_CODE =
  "That code didn't work. Codes change every 30 seconds: try the newest one, and check that your phone's clock is set automatically.";

/** The code step after a password sign-in (/login/verify). */
export async function verifyTwoFactorSignIn(
  _prev: TwoFactorFormState,
  formData: FormData,
): Promise<TwoFactorFormState> {
  const code = normalizeTwoFactorCode(formData.get("code"));
  if (!code) return { error: CODE_HELP };

  const supabase = await createClient();
  const { data: factors, error: listError } =
    await supabase.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (listError || !factor) {
    return { error: "Something went wrong. Please sign in again." };
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code,
  });
  if (error) return { error: WRONG_CODE };

  const token = formData.get("inviteToken");
  redirect(isInviteToken(token) ? `/join/${token}` : "/dashboard");
}

export interface TwoFactorSetup {
  factorId: string;
  /** The QR code as an image URL, for the authenticator app to scan. */
  qrCode: string;
  /** The same secret as text, for typing in by hand or keeping safe. */
  secret: string;
}

/** Starts a setup on /account: a fresh QR code and key, not yet active. */
export async function startTwoFactorSetup(): Promise<
  { setup: TwoFactorSetup } | { error: string }
> {
  const supabase = await createClient();

  // A setup abandoned halfway leaves an unverified factor behind; clear it
  // so starting again works (Supabase wants friendly names unique).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const factor of factors?.all ?? []) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Authenticator app",
    issuer: "Tableside",
  });
  if (error || !data) {
    return { error: "Couldn't start the setup. Please try again." };
  }

  const qr = data.totp.qr_code;
  return {
    setup: {
      factorId: data.id,
      qrCode: qr.startsWith("data:")
        ? qr
        : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`,
      secret: data.totp.secret,
    },
  };
}

/** Finishes a setup: the first code from the app turns it on. */
export async function confirmTwoFactorSetup(
  _prev: TwoFactorFormState,
  formData: FormData,
): Promise<TwoFactorFormState> {
  const factorId = formData.get("factorId");
  const code = normalizeTwoFactorCode(formData.get("code"));
  if (typeof factorId !== "string" || !factorId) {
    return { error: "Something went wrong. Please start again." };
  }
  if (!code) return { error: CODE_HELP };

  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code,
  });
  if (error) return { error: WRONG_CODE };

  revalidatePath("/account");
  revalidatePath("/dashboard", "layout");
  return { done: true };
}

/** Turns it off. Only reachable from a session that passed the code step. */
export async function removeTwoFactor(
  _prev: TwoFactorFormState,
  formData: FormData,
): Promise<TwoFactorFormState> {
  const factorId = formData.get("factorId");
  if (typeof factorId !== "string" || !factorId) {
    return { error: "Something went wrong. Please try again." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) {
    return { error: "Couldn't turn it off. Please sign in again and retry." };
  }

  revalidatePath("/account");
  revalidatePath("/dashboard", "layout");
  return { done: true };
}
