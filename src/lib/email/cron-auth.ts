import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/**
 * Is this the scheduler calling? Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`. With no secret configured, nothing
 * is authorized — a deployment that forgot the secret sends no email rather
 * than letting anyone trigger it.
 */
export function isAuthorizedCronRequest(
  authorization: string | null,
  secret: string | undefined,
): boolean {
  if (!secret?.trim() || !authorization) return false;
  // Hashing both sides first gives equal-length buffers, so the comparison
  // is constant-time without leaking the secret's length.
  return timingSafeEqual(
    digest(authorization),
    digest(`Bearer ${secret.trim()}`),
  );
}
