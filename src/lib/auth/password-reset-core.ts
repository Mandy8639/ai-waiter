import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * "Forgot password?", the rules. No server-only import and no Supabase
 * client, so it is unit-tested directly.
 *
 * Flow: /forgot-password sends Supabase's reset email, whose link lands on
 * /auth/confirm. That signs the person in and sets RESET_MARKER_COOKIE,
 * then /reset-password lets them choose a new password without typing the
 * old one.
 *
 * The marker is what limits that to someone who came through a real reset
 * link. Without it, anyone at an unlocked, signed-in laptop could open
 * /reset-password and skip the current-password check that "Change
 * password" on /account asks for. It names the user and an expiry and is
 * signed with a server-only key, so it can't be made up or reused for
 * another account.
 */

export const RESET_MARKER_COOKIE = "tableside_pw_reset";
export const RESET_PASSWORD_PATH = "/reset-password";
/** How long after opening the link the new password can be set. */
export const RESET_WINDOW_MS = 15 * 60 * 1000;

function signature(payload: string, key: string): string {
  return createHmac("sha256", key)
    .update(`password-reset:${payload}`)
    .digest("base64url");
}

export function createResetMarker(
  userId: string,
  now: number,
  key: string,
): string {
  const payload = `${userId}.${now + RESET_WINDOW_MS}`;
  return `${payload}.${signature(payload, key)}`;
}

/** Whether the marker is genuine, for this user, and not yet expired. */
export function isResetMarkerValid(
  marker: string | undefined,
  userId: string,
  now: number,
  key: string,
): boolean {
  if (!marker) return false;
  const parts = marker.split(".");
  if (parts.length !== 3) return false;
  const [markerUser, expiresAt, sig] = parts;

  const expected = Buffer.from(signature(`${markerUser}.${expiresAt}`, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return false;
  }
  return markerUser === userId && Number(expiresAt) > now;
}

/**
 * Where /auth/confirm and the code step may send someone afterwards. Only
 * named pages, never a general redirect (see destinationAfterAuth in
 * src/lib/auth/actions.ts for why).
 */
export function allowedNextPath(next: unknown): string | null {
  return next === RESET_PASSWORD_PATH ? RESET_PASSWORD_PATH : null;
}
