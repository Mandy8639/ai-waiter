import "server-only";
import { cookies } from "next/headers";
import {
  createResetMarker,
  isResetMarkerValid,
  RESET_MARKER_COOKIE,
  RESET_WINDOW_MS,
} from "@/lib/auth/password-reset-core";

/**
 * The reset marker's cookie, signed with a key derived from the Supabase
 * secret key (server-only, already set wherever the app runs). See
 * src/lib/auth/password-reset-core.ts.
 */
function markerKey(): string {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  return secret;
}

export async function setResetMarker(userId: string): Promise<void> {
  (await cookies()).set(
    RESET_MARKER_COOKIE,
    createResetMarker(userId, Date.now(), markerKey()),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: RESET_WINDOW_MS / 1000,
    },
  );
}

export async function hasValidResetMarker(userId: string): Promise<boolean> {
  const marker = (await cookies()).get(RESET_MARKER_COOKIE)?.value;
  return isResetMarkerValid(marker, userId, Date.now(), markerKey());
}

export async function clearResetMarker(): Promise<void> {
  (await cookies()).delete(RESET_MARKER_COOKIE);
}
