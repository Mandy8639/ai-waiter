/**
 * Copy for errors thrown by the Stripe SDK on the dashboard's Payments page,
 * where the reader is an owner or manager.
 *
 * Kept free of `server-only` and of the Stripe import itself so it can be
 * unit-tested directly. It reads the fields the SDK sets on every
 * StripeError (`type`, which is the class name; `code`; `statusCode`) rather
 * than using instanceof, which would break if two copies of the SDK were
 * ever loaded.
 *
 * Stripe's v2 API errors go through the SDK's generateV2Error(), which falls
 * back to the v1 status-code mapping: a 400 becomes StripeInvalidRequestError
 * with the v2 `code` kept, and a 403 becomes StripePermissionError.
 *
 * Stripe's own `message` is never shown. It is written for developers and
 * can quote part of the API key ("The provided key 'sk_live_…SWYRh1' does not
 * have access…"), so it goes to the error report and not to the page.
 */

/**
 * Codes that mean the PLATFORM's Stripe account isn't allowed to create
 * connected accounts yet. Nothing the restaurant does can fix these, so the
 * copy says so rather than asking them to retry.
 *
 * On 2026-09-11 Stripe returned account_create_activation_required for three
 * different unfinished platform steps in a row, so the code alone can't say
 * which step is missing. Listed from Stripe's error table for
 * POST /v2/core/accounts.
 */
const PLATFORM_NOT_READY_CODES = new Set([
  "account_create_activation_required",
  "accounts_v2_access_blocked",
  "cannot_create_connected_account",
  "cannot_create_new_account_rejected",
  "connect_identity_not_verified",
  "connect_profile_not_submitted",
  "non_connect_platform_accounts_v2_access_blocked",
  "platform_registration_required",
]);

const UNAVAILABLE_TYPES = new Set([
  "StripeAPIError",
  "StripeConnectionError",
  "StripeRateLimitError",
  "RateLimitError",
]);

export const STRIPE_ERROR_COPY = {
  platformNotReady:
    "Stripe won't set up restaurant accounts on this platform yet, because the platform's own Stripe setup still has a step to finish. Please contact support.",
  accountUnreachable:
    "The Stripe account saved for this restaurant can't be reached from this platform any more, so it needs to be reconnected. Please contact support.",
  misconfigured:
    "Payments are set up incorrectly on this site, so Stripe turned the request down. Please contact support.",
  unavailable:
    "Stripe couldn't be reached just now. Wait a minute and try again.",
  rejected:
    "Stripe couldn't complete that. Try again, and contact support if it keeps happening.",
  unexpected: "Something went wrong while talking to Stripe. Please try again.",
} as const;

interface StripeErrorFields {
  type: string;
  code?: string;
  statusCode?: number;
  requestId?: string;
}

function readStripeError(thrown: unknown): StripeErrorFields | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const { type, code, statusCode, requestId } = thrown as Record<
    string,
    unknown
  >;
  if (typeof type !== "string") return null;
  if (!type.startsWith("Stripe") && !UNAVAILABLE_TYPES.has(type)) return null;
  return {
    type,
    code: typeof code === "string" ? code : undefined,
    statusCode: typeof statusCode === "number" ? statusCode : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

/** A short suffix that lets support find the request in Stripe's log. */
function withCode(message: string, code: string | undefined): string {
  return code ? `${message} (Stripe code: ${code})` : message;
}

export function describeStripeError(thrown: unknown): string {
  const error = readStripeError(thrown);
  if (!error) return STRIPE_ERROR_COPY.unexpected;

  if (error.code && PLATFORM_NOT_READY_CODES.has(error.code)) {
    return withCode(STRIPE_ERROR_COPY.platformNotReady, error.code);
  }

  // A 403 here means the key can't see the stored account: typically a row
  // created while production ran on a different Stripe account's key.
  // resource_missing is the same situation when the account was deleted.
  if (
    error.type === "StripePermissionError" ||
    error.statusCode === 403 ||
    error.code === "resource_missing"
  ) {
    return STRIPE_ERROR_COPY.accountUnreachable;
  }

  if (error.type === "StripeAuthenticationError" || error.statusCode === 401) {
    return STRIPE_ERROR_COPY.misconfigured;
  }

  if (
    UNAVAILABLE_TYPES.has(error.type) ||
    error.statusCode === 429 ||
    (error.statusCode !== undefined && error.statusCode >= 500)
  ) {
    return STRIPE_ERROR_COPY.unavailable;
  }

  return withCode(STRIPE_ERROR_COPY.rejected, error.code);
}

/**
 * The identifying fields of a Stripe error, for the error report. No
 * message: see the note at the top of this file.
 */
export function stripeErrorDetails(
  thrown: unknown,
): Record<string, string | number> {
  const error = readStripeError(thrown);
  if (!error) return {};
  const details: Record<string, string | number> = { stripeType: error.type };
  if (error.code) details.stripeCode = error.code;
  if (error.statusCode !== undefined) details.stripeStatus = error.statusCode;
  if (error.requestId) details.stripeRequestId = error.requestId;
  return details;
}
