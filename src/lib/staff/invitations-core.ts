/**
 * Everything about invitation links that does not need a database or a
 * request: the URL shape, the token shape, and the words shown to the
 * person holding the link.
 *
 * No `server-only` import, so this is unit-testable directly — the wording
 * is the part of phase C most likely to be wrong in a way no type catches,
 * and the token pattern is checked on a path that a stranger reaches
 * before anything else runs.
 */

/**
 * Two hyphen-stripped UUIDs, as create_staff_invitation() mints them.
 * Anchored and exact: this is the first thing that looks at a value taken
 * straight out of a URL, and a token that is not this shape cannot match
 * any row, so there is no reason to carry it as far as the database.
 */
export const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}

/**
 * The link an owner copies. Absolute, because it is pasted into WhatsApp,
 * a text message or an email — nothing about where it lands knows this app.
 * `origin` comes from getRequestOrigin() (src/lib/tables/qr.ts), the same
 * source the table QR codes use.
 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin}/join/${encodeURIComponent(token)}`;
}

/** What get_staff_invitation_preview() reports. */
export type InvitationState =
  "valid" | "expired" | "used" | "revoked" | "unknown";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  kitchen: "Kitchen",
  staff: "Staff",
};

export function roleLabel(role: string | null): string {
  if (!role) return "Staff";
  return ROLE_LABELS[role] ?? role;
}

/**
 * A plain-language description of what each role can do, shown on the join
 * page. Someone accepting an invitation is often told nothing beyond "join
 * this", and the role decides what they will see for as long as they work
 * there.
 */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: "Full access, including staff, payments and settings.",
  manager: "Menus, tables, orders and staff — everything except billing.",
  kitchen: "The kitchen board: orders to prepare, and their status.",
  staff: "Orders, tables and diner requests.",
};

export function roleDescription(role: string | null): string {
  if (!role) return "";
  return ROLE_DESCRIPTIONS[role] ?? "";
}

export interface InvitationMessage {
  heading: string;
  body: string;
  /** False for every state but `valid` — nothing to accept. */
  canAccept: boolean;
}

/**
 * What the join page says.
 *
 * Only `valid` names the restaurant in the heading. The others still say
 * which restaurant it was, because the holder of an expired link held a
 * real one and "your invitation to Nashta has expired, ask them for a new
 * one" is something they can act on — where "invalid link" leaves them
 * stuck and suspicious. `unknown` is the one case with no restaurant to
 * name, and it deliberately does not speculate about why.
 */
export function describeInvitation(
  state: InvitationState,
  restaurantName: string | null,
): InvitationMessage {
  const where = restaurantName ?? "this restaurant";

  switch (state) {
    case "valid":
      return {
        heading: `You've been invited to join ${where}`,
        body: "Accept the invitation to get access to their Tableside dashboard.",
        canAccept: true,
      };
    case "expired":
      return {
        heading: `This invitation to ${where} has expired`,
        body: "Invitation links last seven days. Ask whoever sent it for a new one.",
        canAccept: false,
      };
    case "used":
      return {
        heading: `This invitation to ${where} has already been used`,
        body: "Each link works once. If it wasn't you who used it, tell whoever sent it — they can remove the account that joined.",
        canAccept: false,
      };
    case "revoked":
      return {
        heading: `This invitation to ${where} was cancelled`,
        body: "Ask whoever sent it for a new link.",
        canAccept: false,
      };
    case "unknown":
      return {
        heading: "This invitation link isn't valid",
        body: "Check that you copied the whole link. If it still doesn't work, ask whoever sent it for a new one.",
        canAccept: false,
      };
  }
}

/**
 * How long an owner has left to send a link, in words.
 *
 * A duration, not a wall-clock time, so the restaurant's timezone does not
 * come into it — which is the reason this is not going through
 * src/lib/reservations/timezone.ts. Rounds up, because "expires in 0 days"
 * reads as already gone when there are still twenty hours on it.
 */
export function expiryLabel(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "Expired";

  const hours = ms / 3_600_000;
  if (hours < 1) return "Expires within the hour";
  if (hours < 24) {
    const rounded = Math.round(hours);
    return `Expires in ${rounded} hour${rounded === 1 ? "" : "s"}`;
  }

  const days = Math.ceil(hours / 24);
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The exceptions the phase C functions raise, mapped to what an owner or a
 * new hire should read. Kept here rather than going through
 * src/lib/errors/database-error.ts for the same reason
 * src/lib/staff/actions.ts keeps its own: these messages exist to be read,
 * not to be hidden.
 */
export function toInvitationError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("managers_cannot_grant_owner")) {
    return "Managers can't invite an owner — ask an owner to do this.";
  }
  if (lower.includes("insufficient_role")) {
    return "You don't have permission to manage invitations for this restaurant.";
  }
  if (lower.includes("too_many_pending")) {
    return "There are already 20 invitation links waiting. Cancel one you no longer need, or let it expire.";
  }
  if (lower.includes("invalid_role")) {
    return "That's not a valid role.";
  }
  if (lower.includes("not_pending")) {
    return "That invitation has already been used or cancelled.";
  }
  if (lower.includes("anonymous_caller")) {
    // A diner's phone, mid-meal: they have a guest session, not an account.
    return "You're browsing as a guest. Create a Tableside account or sign in, then open the link again.";
  }
  if (lower.includes("not_authenticated")) {
    return "Sign in or create an account first, then open the link again.";
  }
  if (lower.includes("already_used")) {
    return "This invitation has already been used.";
  }
  if (lower.includes("revoked")) {
    return "This invitation was cancelled.";
  }
  if (lower.includes("expired")) {
    return "This invitation has expired. Ask whoever sent it for a new link.";
  }
  if (lower.includes("not_found")) {
    return "That invitation link isn't valid.";
  }
  return "Something went wrong. Please try again.";
}
