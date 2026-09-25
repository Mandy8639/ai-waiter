// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, type Role } from "./helpers";

/**
 * Phase C: invitation links.
 *
 * A valid token is a staff account. There is no email binding, no second
 * factor and no approval step behind it, so almost every test here is
 * about a link NOT working: expired, revoked, already used, forwarded to a
 * diner's phone, or pointed at a role its creator was not allowed to
 * grant. The happy path is three tests; the rest is the boundary.
 *
 * Run against the real migration SQL through PGlite (see setup.ts), so
 * these exercise the actual constraints and SECURITY DEFINER bodies rather
 * than a description of them.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe("staff invitations", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /** A restaurant with one member at `role`, plus their user id. */
  async function fixture(role: Role = "owner", name?: string) {
    const restaurantId = await createRestaurant(db, name ? { name } : {});
    const userId = await db.createAuthUser();
    await addMember(db, restaurantId, userId, role);
    return { restaurantId, userId };
  }

  async function createInvite(
    userId: string,
    restaurantId: string,
    role: Role = "staff",
    label: string | null = null,
  ): Promise<string> {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ token: string }>(
        "select public.create_staff_invitation($1, $2, $3) as token;",
        [restaurantId, role, label],
      ),
    );
    return rows[0].token;
  }

  interface Preview {
    restaurant_name: string | null;
    invited_role: string | null;
    state: string;
  }

  async function preview(token: string): Promise<Preview> {
    const { rows } = await db.asAnon((c) =>
      c.query<Preview>(
        "select * from public.get_staff_invitation_preview($1);",
        [token],
      ),
    );
    return rows[0];
  }

  interface Accepted {
    joined_restaurant_id: string;
    joined_restaurant_name: string;
    granted_role: string;
    already_member: boolean;
  }

  async function accept(userId: string, token: string): Promise<Accepted> {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<Accepted>("select * from public.accept_staff_invitation($1);", [
        token,
      ]),
    );
    return rows[0];
  }

  async function memberRole(
    restaurantId: string,
    userId: string,
  ): Promise<string | null> {
    const { rows } = await db.admin.query<{ role: string }>(
      "select role from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
      [restaurantId, userId],
    );
    return rows[0]?.role ?? null;
  }

  async function expireInvite(token: string): Promise<void> {
    await db.admin.query(
      `update public.staff_invitations
         set expires_at = now() - interval '1 minute'
       where token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex');`,
      [token],
    );
  }

  // ---------------------------------------------------------------- creating

  describe("creating a link", () => {
    it("gives the owner a token and stores only its hash", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);

      expect(token).toMatch(SHA256_HEX);

      // The token itself must appear nowhere in the row. This is the whole
      // point of hashing it: a read of this table yields no usable link.
      const { rows } = await db.admin.query<{
        token_hash: string;
        role: string;
        status: string;
        matches: boolean;
      }>(
        `select token_hash, role, status,
                token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex') as matches
           from public.staff_invitations
          where restaurant_id = $2;`,
        [token, restaurantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].matches).toBe(true);
      expect(rows[0].token_hash).not.toBe(token);
      expect(rows[0]).toMatchObject({ role: "staff", status: "pending" });
    });

    it("expires in seven days, set by the database and not the caller", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await createInvite(userId, restaurantId);

      const { rows } = await db.admin.query<{ days: number }>(
        `select extract(day from (expires_at - created_at))::int as days
           from public.staff_invitations where restaurant_id = $1;`,
        [restaurantId],
      );
      expect(rows[0].days).toBe(7);
    });

    it("never issues the same token twice", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const tokens = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        tokens.add(await createInvite(userId, restaurantId));
      }
      expect(tokens.size).toBe(5);
    });

    it("lets a manager invite a waiter", async () => {
      const { restaurantId, userId } = await fixture("manager");
      await expect(
        createInvite(userId, restaurantId, "staff"),
      ).resolves.toMatch(SHA256_HEX);
    });

    it("refuses to let a manager mint an owner link", async () => {
      // The escalation this feature makes cheapest: a manager who cannot
      // add an owner directly must not be able to do it by link either.
      const { restaurantId, userId } = await fixture("manager");
      await expect(createInvite(userId, restaurantId, "owner")).rejects.toThrow(
        /STAFF_INVITE_MANAGERS_CANNOT_GRANT_OWNER/,
      );
    });

    it("lets an owner mint an owner link", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await expect(
        createInvite(userId, restaurantId, "owner"),
      ).resolves.toMatch(SHA256_HEX);
    });

    it.each(["kitchen", "staff"] as const)(
      "refuses %s, who cannot add members at all",
      async (role) => {
        const { restaurantId, userId } = await fixture(role);
        await expect(createInvite(userId, restaurantId)).rejects.toThrow(
          /STAFF_INVITE_INSUFFICIENT_ROLE/,
        );
      },
    );

    it("refuses a signed-in stranger with no membership", async () => {
      const { restaurantId } = await fixture("owner");
      const outsider = await db.createAuthUser();
      await expect(createInvite(outsider, restaurantId)).rejects.toThrow(
        /STAFF_INVITE_INSUFFICIENT_ROLE/,
      );
    });

    it("refuses a role outside the four", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await expect(
        db.asUser(userId, (c) =>
          c.query("select public.create_staff_invitation($1, $2);", [
            restaurantId,
            "superuser",
          ]),
        ),
      ).rejects.toThrow(/STAFF_INVITE_INVALID_ROLE/);
    });

    it("caps outstanding links at twenty, so the pending list stays readable", async () => {
      const { restaurantId, userId } = await fixture("owner");
      for (let i = 0; i < 20; i += 1) {
        await createInvite(userId, restaurantId);
      }
      await expect(createInvite(userId, restaurantId)).rejects.toThrow(
        /STAFF_INVITE_TOO_MANY_PENDING/,
      );
    });

    it("does not count expired links against the cap", async () => {
      // The cap is about what is outstanding, not what was ever created —
      // otherwise a restaurant hits a permanent ceiling after twenty hires.
      const { restaurantId, userId } = await fixture("owner");
      for (let i = 0; i < 20; i += 1) {
        await expireInvite(await createInvite(userId, restaurantId));
      }
      await expect(createInvite(userId, restaurantId)).resolves.toMatch(
        SHA256_HEX,
      );
    });

    it("trims a label and drops an empty one", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await createInvite(userId, restaurantId, "staff", "   ");
      await createInvite(userId, restaurantId, "staff", "  Priya  ");

      const { rows } = await db.admin.query<{ label: string | null }>(
        "select label from public.staff_invitations where restaurant_id = $1 order by created_at;",
        [restaurantId],
      );
      expect(rows.map((r) => r.label)).toEqual([null, "Priya"]);
    });
  });

  // ----------------------------------------------------------------- preview

  describe("what the link's holder is told before signing in", () => {
    it("names the restaurant and the role to a signed-out visitor", async () => {
      // Signed out is the normal case: the person following this link has
      // no account yet, which is the entire reason the feature exists.
      const { restaurantId, userId } = await fixture("owner", "Nashta");
      const token = await createInvite(userId, restaurantId, "staff");

      expect(await preview(token)).toEqual({
        restaurant_name: "Nashta",
        invited_role: "staff",
        state: "valid",
      });
    });

    it("says nothing about a token nobody issued", async () => {
      expect(await preview("f".repeat(64))).toEqual({
        restaurant_name: null,
        invited_role: null,
        state: "unknown",
      });
    });

    it("answers a garbage token without erroring", async () => {
      expect((await preview("not-a-token")).state).toBe("unknown");
      expect((await preview("")).state).toBe("unknown");
    });

    it("reports an expired link as expired, and still names the restaurant", async () => {
      // "Your invitation to Nashta has expired" is something the holder can
      // act on. "Invalid link" leaves them stuck and suspicious.
      const { restaurantId, userId } = await fixture("owner", "Nashta");
      const token = await createInvite(userId, restaurantId);
      await expireInvite(token);

      expect(await preview(token)).toMatchObject({
        restaurant_name: "Nashta",
        state: "expired",
      });
    });

    it("reports a used link as used", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      await accept(await db.createAuthUser(), token);

      expect((await preview(token)).state).toBe("used");
    });

    it("reports a revoked link as revoked", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const { rows } = await db.admin.query<{ id: string }>(
        "select id from public.staff_invitations where restaurant_id = $1;",
        [restaurantId],
      );
      await db.asUser(userId, (c) =>
        c.query("select public.revoke_staff_invitation($1);", [rows[0].id]),
      );

      expect((await preview(token)).state).toBe("revoked");
    });

    it("never returns the label, which is the inviter's private note", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(
        userId,
        restaurantId,
        "staff",
        "replacing Sam, who was fired",
      );
      expect(JSON.stringify(await preview(token))).not.toMatch(/fired/i);
    });
  });

  // ---------------------------------------------------------------- accepting

  describe("accepting", () => {
    it("makes a brand-new account a member at exactly the invited role", async () => {
      const { restaurantId, userId } = await fixture("owner", "Nashta");
      const token = await createInvite(userId, restaurantId, "staff");
      const newHire = await db.createAuthUser();

      const result = await accept(newHire, token);
      expect(result).toMatchObject({
        joined_restaurant_id: restaurantId,
        joined_restaurant_name: "Nashta",
        granted_role: "staff",
        already_member: false,
      });
      expect(await memberRole(restaurantId, newHire)).toBe("staff");
    });

    it("joins them to exactly that one restaurant", async () => {
      const a = await fixture("owner");
      const b = await fixture("owner");
      const token = await createInvite(a.userId, a.restaurantId);
      const newHire = await db.createAuthUser();
      await accept(newHire, token);

      const { rows } = await db.admin.query<{ restaurant_id: string }>(
        "select restaurant_id from public.restaurant_users where user_id = $1;",
        [newHire],
      );
      expect(rows.map((r) => r.restaurant_id)).toEqual([a.restaurantId]);
      expect(await memberRole(b.restaurantId, newHire)).toBeNull();
    });

    it("consumes the link: the second person gets nothing", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const first = await db.createAuthUser();
      const second = await db.createAuthUser();

      await accept(first, token);
      await expect(accept(second, token)).rejects.toThrow(
        /STAFF_INVITE_ALREADY_USED/,
      );
      expect(await memberRole(restaurantId, second)).toBeNull();
    });

    it("records who accepted it, and when", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const newHire = await db.createAuthUser();
      await accept(newHire, token);

      const { rows } = await db.admin.query<{
        status: string;
        accepted_by: string;
        has_time: boolean;
      }>(
        "select status, accepted_by, accepted_at is not null as has_time from public.staff_invitations where restaurant_id = $1;",
        [restaurantId],
      );
      expect(rows[0]).toMatchObject({
        status: "accepted",
        accepted_by: newHire,
        has_time: true,
      });
    });

    it("refuses an expired link", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      await expireInvite(token);
      const newHire = await db.createAuthUser();

      await expect(accept(newHire, token)).rejects.toThrow(
        /STAFF_INVITE_EXPIRED/,
      );
      expect(await memberRole(restaurantId, newHire)).toBeNull();
    });

    it("refuses a revoked link", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const { rows } = await db.admin.query<{ id: string }>(
        "select id from public.staff_invitations where restaurant_id = $1;",
        [restaurantId],
      );
      await db.asUser(userId, (c) =>
        c.query("select public.revoke_staff_invitation($1);", [rows[0].id]),
      );
      const newHire = await db.createAuthUser();

      await expect(accept(newHire, token)).rejects.toThrow(
        /STAFF_INVITE_REVOKED/,
      );
      expect(await memberRole(restaurantId, newHire)).toBeNull();
    });

    it("refuses a token nobody issued", async () => {
      const newHire = await db.createAuthUser();
      await expect(accept(newHire, "a".repeat(64))).rejects.toThrow(
        /STAFF_INVITE_NOT_FOUND/,
      );
    });

    it("refuses a diner's guest session", async () => {
      // A link forwarded to a phone that is mid-meal. That identity is a
      // real `authenticated` user, so only the is_anonymous check stops
      // staff access being attached to something that disappears with the
      // browser storage and can never be signed back into.
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const diner = await db.createAnonymousAuthUser();

      await expect(accept(diner, token)).rejects.toThrow(
        /STAFF_INVITE_ANONYMOUS_CALLER/,
      );
      expect(await memberRole(restaurantId, diner)).toBeNull();
      // And the link is still good for the person it was meant for.
      expect((await preview(token)).state).toBe("valid");
    });

    it("is not callable at all by a signed-out visitor", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      await expect(
        db.asAnon((c) =>
          c.query("select public.accept_staff_invitation($1);", [token]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("leaves an existing member's role alone, and says so", async () => {
      // A 'manager' link forwarded to someone already on the team must not
      // promote them. Nobody performed that promotion and nobody would see
      // it happen.
      const { restaurantId, userId } = await fixture("owner");
      const waiter = await db.createAuthUser();
      await addMember(db, restaurantId, waiter, "staff");
      const token = await createInvite(userId, restaurantId, "manager");

      const result = await accept(waiter, token);
      expect(result).toMatchObject({
        granted_role: "manager",
        already_member: true,
      });
      expect(await memberRole(restaurantId, waiter)).toBe("staff");
    });

    it("still consumes a link an existing member followed", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const waiter = await db.createAuthUser();
      await addMember(db, restaurantId, waiter, "staff");
      const token = await createInvite(userId, restaurantId, "staff");

      await accept(waiter, token);
      expect((await preview(token)).state).toBe("used");
    });

    it("takes the token and nothing else", async () => {
      // The structural guarantee behind "the role is fixed at creation":
      // there is no second argument for a URL or a form field to reach.
      const { rows } = await db.admin.query<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'accept_staff_invitation';`,
      );
      expect(rows.map((r) => r.args)).toEqual(["p_token text"]);
    });
  });

  // ---------------------------------------------------------------- revoking

  describe("revoking", () => {
    async function inviteId(restaurantId: string): Promise<string> {
      const { rows } = await db.admin.query<{ id: string }>(
        "select id from public.staff_invitations where restaurant_id = $1 order by created_at desc limit 1;",
        [restaurantId],
      );
      return rows[0].id;
    }

    async function revoke(userId: string, id: string) {
      return db.asUser(userId, (c) =>
        c.query("select public.revoke_staff_invitation($1);", [id]),
      );
    }

    it("kills a pending link immediately", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      await revoke(userId, await inviteId(restaurantId));

      expect((await preview(token)).state).toBe("revoked");
    });

    it("lets any owner or manager revoke, not only whoever created it", async () => {
      // The owner who needs to kill a mis-sent link at 9pm is not always
      // the one who sent it.
      const { restaurantId, userId } = await fixture("owner");
      const manager = await db.createAuthUser();
      await addMember(db, restaurantId, manager, "manager");
      const token = await createInvite(userId, restaurantId);

      await revoke(manager, await inviteId(restaurantId));
      expect((await preview(token)).state).toBe("revoked");
    });

    it.each(["kitchen", "staff"] as const)("refuses %s", async (role) => {
      const { restaurantId, userId } = await fixture("owner");
      const other = await db.createAuthUser();
      await addMember(db, restaurantId, other, role);
      await createInvite(userId, restaurantId);

      await expect(revoke(other, await inviteId(restaurantId))).rejects.toThrow(
        /STAFF_INVITE_INSUFFICIENT_ROLE/,
      );
    });

    it("refuses an owner of a different restaurant", async () => {
      const a = await fixture("owner");
      const b = await fixture("owner");
      await createInvite(a.userId, a.restaurantId);

      await expect(
        revoke(b.userId, await inviteId(a.restaurantId)),
      ).rejects.toThrow(/STAFF_INVITE_INSUFFICIENT_ROLE/);
    });

    it("refuses an already-accepted link — that is a member now, not a link", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      await accept(await db.createAuthUser(), token);

      await expect(
        revoke(userId, await inviteId(restaurantId)),
      ).rejects.toThrow(/STAFF_INVITE_NOT_PENDING/);
    });

    it("allows revoking an expired link, which is how the list gets tidied", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await expireInvite(await createInvite(userId, restaurantId));
      await expect(
        revoke(userId, await inviteId(restaurantId)),
      ).resolves.toBeDefined();
    });

    it("refuses an id nobody issued", async () => {
      const { userId } = await fixture("owner");
      await expect(revoke(userId, crypto.randomUUID())).rejects.toThrow(
        /STAFF_INVITE_NOT_FOUND/,
      );
    });
  });

  // -------------------------------------------------------------- the list

  describe("the pending list", () => {
    interface Row {
      id: string;
      invited_role: string;
      label: string | null;
      is_expired: boolean;
      created_by_email: string | null;
    }

    async function list(userId: string, restaurantId: string): Promise<Row[]> {
      const { rows } = await db.asUser(userId, (c) =>
        c.query<Row>("select * from public.get_staff_invitations($1);", [
          restaurantId,
        ]),
      );
      return rows;
    }

    it("shows pending links with the role, label and inviter", async () => {
      const restaurantId = await createRestaurant(db);
      const userId = await db.createAuthUser("boss@example.com");
      await addMember(db, restaurantId, userId, "owner");
      await createInvite(userId, restaurantId, "kitchen", "new chef");

      const rows = await list(userId, restaurantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        invited_role: "kitchen",
        label: "new chef",
        is_expired: false,
        created_by_email: "boss@example.com",
      });
    });

    it("returns no token and no hash", async () => {
      // A created link is unrecoverable by design; a list that handed it
      // back would quietly undo the hashing.
      const { restaurantId, userId } = await fixture("owner");
      const token = await createInvite(userId, restaurantId);
      const serialized = JSON.stringify(await list(userId, restaurantId));

      expect(serialized).not.toContain(token);
      expect(serialized).not.toMatch(/token/i);
    });

    it("flags an expired link rather than hiding it", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await expireInvite(await createInvite(userId, restaurantId));

      const rows = await list(userId, restaurantId);
      expect(rows).toHaveLength(1);
      expect(rows[0].is_expired).toBe(true);
    });

    it("drops accepted and revoked links", async () => {
      const { restaurantId, userId } = await fixture("owner");
      const accepted = await createInvite(userId, restaurantId);
      await accept(await db.createAuthUser(), accepted);

      await createInvite(userId, restaurantId);
      const { rows: pending } = await db.admin.query<{ id: string }>(
        "select id from public.staff_invitations where restaurant_id = $1 and status = 'pending';",
        [restaurantId],
      );
      await db.asUser(userId, (c) =>
        c.query("select public.revoke_staff_invitation($1);", [pending[0].id]),
      );

      expect(await list(userId, restaurantId)).toEqual([]);
    });

    it("is newest first", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await createInvite(userId, restaurantId, "staff", "first");
      // Backdated: two invitations created in the same millisecond share a
      // created_at, and then the order is whatever Postgres feels like.
      await db.admin.query(
        "update public.staff_invitations set created_at = created_at - interval '1 minute' where restaurant_id = $1;",
        [restaurantId],
      );
      await createInvite(userId, restaurantId, "staff", "second");

      expect((await list(userId, restaurantId)).map((r) => r.label)).toEqual([
        "second",
        "first",
      ]);
    });

    it("is for owners and managers only", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await createInvite(userId, restaurantId);

      const manager = await db.createAuthUser();
      await addMember(db, restaurantId, manager, "manager");
      expect(await list(manager, restaurantId)).toHaveLength(1);

      for (const role of ["kitchen", "staff"] as const) {
        const other = await db.createAuthUser();
        await addMember(db, restaurantId, other, role);
        await expect(list(other, restaurantId)).rejects.toThrow(
          /STAFF_INVITE_INSUFFICIENT_ROLE/,
        );
      }
    });

    it("refuses another restaurant's owner", async () => {
      const a = await fixture("owner");
      const b = await fixture("owner");
      await createInvite(a.userId, a.restaurantId);

      await expect(list(b.userId, a.restaurantId)).rejects.toThrow(
        /STAFF_INVITE_INSUFFICIENT_ROLE/,
      );
    });
  });

  // ------------------------------------------------------------------- RLS

  describe("direct table access", () => {
    it("shows an owner nothing through a plain select", async () => {
      // RLS is on with no policies at all: every read goes through a
      // definer function that shapes its own output.
      const { restaurantId, userId } = await fixture("owner");
      await createInvite(userId, restaurantId);

      const { rows } = await db.asUser(userId, (c) =>
        c.query("select * from public.staff_invitations;"),
      );
      expect(rows).toEqual([]);
    });

    it("refuses a hand-written insert, even from an owner", async () => {
      const { restaurantId, userId } = await fixture("owner");
      await expect(
        db.asUser(userId, (c) =>
          c.query(
            `insert into public.staff_invitations (restaurant_id, token_hash, role, expires_at)
             values ($1, $2, 'owner', now() + interval '1 year');`,
            [restaurantId, "c".repeat(64)],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses a plaintext token in the hash column", async () => {
      // The one mistake in this design that would be both silent and
      // serious, so the column shape is checked rather than trusted.
      const { restaurantId } = await fixture("owner");
      await expect(
        db.admin.query(
          `insert into public.staff_invitations (restaurant_id, token_hash, role, expires_at)
           values ($1, 'plain-text-token', 'staff', now() + interval '7 days');`,
          [restaurantId],
        ),
      ).rejects.toThrow(/staff_invitations_token_hash_shape/);
    });
  });
});
