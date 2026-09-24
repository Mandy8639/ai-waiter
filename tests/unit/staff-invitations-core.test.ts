// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  INVITE_TOKEN_PATTERN,
  buildInviteUrl,
  describeInvitation,
  expiryLabel,
  isInviteToken,
  roleDescription,
  roleLabel,
  toInvitationError,
  type InvitationState,
} from "@/lib/staff/invitations-core";

/**
 * Phase C, the parts with no database in them.
 *
 * Two things are worth testing here and they are not the same kind of
 * thing. The token pattern is a guard on a value that comes straight out
 * of a URL typed by a stranger. The wording is the whole product for
 * someone who has never seen this app before and has just been asked to
 * create an account — if it reads like phishing, the feature does not work
 * no matter what the SQL does.
 */

const A_TOKEN = "a".repeat(64);

describe("token shape", () => {
  it("accepts a real token", () => {
    expect(isInviteToken(A_TOKEN)).toBe(true);
    expect(isInviteToken("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isInviteToken("a".repeat(63))).toBe(false);
    expect(isInviteToken("a".repeat(65))).toBe(false);
    expect(isInviteToken("")).toBe(false);
  });

  it("rejects anything that is not lowercase hex", () => {
    expect(isInviteToken("A".repeat(64))).toBe(false);
    expect(isInviteToken("g".repeat(64))).toBe(false);
    // A UUID is the right entropy but the wrong shape — the real token is
    // two of them with the hyphens taken out.
    expect(isInviteToken("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);
  });

  it("is anchored, so a token buried in other text does not pass", () => {
    // The reason this matters: an unanchored pattern would accept
    // "../../admin/" + token, and the value is interpolated into a path.
    expect(isInviteToken(`../${A_TOKEN}`)).toBe(false);
    expect(isInviteToken(`${A_TOKEN}?next=https://evil.example`)).toBe(false);
    expect(isInviteToken(`${A_TOKEN}\n${A_TOKEN}`)).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    expect(isInviteToken(undefined)).toBe(false);
    expect(isInviteToken(null)).toBe(false);
    expect(isInviteToken(42)).toBe(false);
    expect(isInviteToken({ toString: () => A_TOKEN })).toBe(false);
  });

  it("matches what the database mints: 64 hex characters", () => {
    expect(INVITE_TOKEN_PATTERN.source).toContain("64");
  });
});

describe("the link", () => {
  it("is absolute, because it is pasted into a message", () => {
    expect(buildInviteUrl("https://order.example.com", A_TOKEN)).toBe(
      `https://order.example.com/join/${A_TOKEN}`,
    );
  });

  it("works on a dev origin too", () => {
    expect(buildInviteUrl("http://localhost:3000", A_TOKEN)).toBe(
      `http://localhost:3000/join/${A_TOKEN}`,
    );
  });
});

describe("what the link's holder reads", () => {
  it("names the restaurant when the invitation is good", () => {
    const message = describeInvitation("valid", "Nashta");
    expect(message.heading).toBe("You've been invited to join Nashta");
    expect(message.canAccept).toBe(true);
  });

  it("offers nothing to accept in any other state", () => {
    const states: InvitationState[] = ["expired", "used", "revoked", "unknown"];
    for (const state of states) {
      expect(describeInvitation(state, "Nashta").canAccept).toBe(false);
    }
  });

  it("still names the restaurant for an expired link, and says what to do", () => {
    // "Invalid link" leaves a new hire stuck and suspicious. Naming the
    // restaurant and the fix is the difference between a dead end and a
    // message they can send back to their boss.
    const message = describeInvitation("expired", "Nashta");
    expect(message.heading).toContain("Nashta");
    expect(message.body).toMatch(/new one/i);
  });

  it("tells someone whose link was already used what that means for them", () => {
    const message = describeInvitation("used", "Nashta");
    expect(message.body).toMatch(/wasn't you/i);
  });

  it("does not speculate about a link nobody issued", () => {
    // There is no restaurant to name, and guessing at why ("it may have
    // been cancelled") would be inventing facts.
    const message = describeInvitation("unknown", null);
    expect(message.heading).not.toMatch(/nashta|expired|cancelled/i);
    expect(message.body).toMatch(/copied the whole link/i);
  });

  it("falls back to neutral wording when the name is missing", () => {
    // A valid invitation always has a restaurant, but a deleted one during
    // the same request would not — and "join null" must never render.
    for (const state of [
      "valid",
      "expired",
      "used",
      "revoked",
    ] as InvitationState[]) {
      const message = describeInvitation(state, null);
      expect(message.heading).not.toMatch(/null|undefined/);
      expect(message.heading).toContain("this restaurant");
    }
  });
});

describe("roles", () => {
  it("labels every role a link can carry", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("manager")).toBe("Manager");
    expect(roleLabel("kitchen")).toBe("Kitchen");
    expect(roleLabel("staff")).toBe("Staff");
  });

  it("describes every role, so nobody accepts an unexplained one", () => {
    for (const role of ["owner", "manager", "kitchen", "staff"]) {
      expect(roleDescription(role).length).toBeGreaterThan(10);
    }
  });

  it("degrades gracefully on an unknown role rather than rendering blank", () => {
    expect(roleLabel("chef")).toBe("chef");
    expect(roleLabel(null)).toBe("Staff");
    expect(roleDescription(null)).toBe("");
  });
});

describe("expiry in words", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);

  it("reads as days for a fresh link", () => {
    expect(expiryLabel(inHours(24 * 7), now)).toBe("Expires in 7 days");
  });

  it("rounds up, so a link with twenty hours left is not 'in 0 days'", () => {
    expect(expiryLabel(inHours(20), now)).toBe("Expires in 20 hours");
    expect(expiryLabel(inHours(30), now)).toBe("Expires in 2 days");
  });

  it("uses the singular where it should", () => {
    expect(expiryLabel(inHours(1), now)).toBe("Expires in 1 hour");
    expect(expiryLabel(inHours(24), now)).toBe("Expires in 1 day");
  });

  it("says so within the last hour", () => {
    expect(expiryLabel(inHours(0.4), now)).toBe("Expires within the hour");
  });

  it("says Expired once it has, including exactly on the boundary", () => {
    expect(expiryLabel(now, now)).toBe("Expired");
    expect(expiryLabel(inHours(-1), now)).toBe("Expired");
  });
});

describe("errors the holder or the owner reads", () => {
  it("explains a manager's ceiling rather than just refusing", () => {
    expect(
      toInvitationError("STAFF_INVITE_MANAGERS_CANNOT_GRANT_OWNER"),
    ).toMatch(/ask an owner/i);
  });

  it("tells an owner at the cap what to do about it", () => {
    expect(toInvitationError("STAFF_INVITE_TOO_MANY_PENDING")).toMatch(
      /cancel one/i,
    );
  });

  it("explains a guest session in terms a diner could act on", () => {
    // The one error message here that reaches someone who has never heard
    // of this product and is holding a phone at a restaurant table.
    const message = toInvitationError("STAFF_INVITE_ANONYMOUS_CALLER");
    expect(message).toMatch(/guest/i);
    expect(message).toMatch(/account/i);
    expect(message).not.toMatch(/anonymous|auth\.uid|42501/i);
  });

  it("maps each refusal to its own sentence", () => {
    const seen = new Set(
      [
        "STAFF_INVITE_EXPIRED",
        "STAFF_INVITE_REVOKED",
        "STAFF_INVITE_ALREADY_USED",
        "STAFF_INVITE_NOT_FOUND",
        "STAFF_INVITE_INSUFFICIENT_ROLE",
        "STAFF_INVITE_NOT_PENDING",
      ].map(toInvitationError),
    );
    expect(seen.size).toBe(6);
    for (const message of seen) {
      expect(message).not.toBe("Something went wrong. Please try again.");
    }
  });

  it("hides anything it does not recognise", () => {
    // Raw Postgres detail is not for a new hire's screen.
    expect(
      toInvitationError(
        'duplicate key value violates unique constraint "staff_invitations_token_hash_key"',
      ),
    ).toBe("Something went wrong. Please try again.");
  });

  it("matches on the real message, which arrives wrapped by PostgREST", () => {
    // Postgres prefixes the raise with its own framing, so the mapping has
    // to survive a message that merely contains the code.
    expect(
      toInvitationError(
        "unexpected error: STAFF_INVITE_EXPIRED (SQLSTATE 42501)",
      ),
    ).toMatch(/expired/i);
  });
});
