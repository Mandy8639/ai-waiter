// @vitest-environment node
//
// Batch 7's `ai_conversation_messages` table (see
// supabase/migrations/20260825090000_ai_conversation_messages.sql) — the
// AI waiter's conversation memory, rate-limiting signal, and tool-call
// audit trail. These tests exercise the RLS/constraint layer directly
// against real Postgres semantics (via PGlite — see setup.ts), the same
// way every other table's isolation has been verified since Batch 2. The
// AI orchestration/tool-execution code itself (src/lib/ai/*) can't be
// imported here — see tests/unit/ai-*.test.ts's header comments for why
// (`server-only` throws outside Next.js's RSC bundling) — so this file
// covers what a raw SQL/RLS test CAN prove: session isolation,
// cross-tenant rejection, and the append-only guarantee.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createCustomerSession,
  createRestaurant,
  createTable,
} from "./helpers";

async function insertMessage(
  db: TestDb,
  userId: string,
  restaurantId: string,
  customerSessionId: string,
  role: "user" | "assistant" | "tool",
  content = "hello",
) {
  return db.asUser(userId, (c) =>
    c.query<{ id: string }>(
      "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content) values ($1, $2, $3, $4) returning id;",
      [restaurantId, customerSessionId, role, content],
    ),
  );
}

describe("ai_conversation_messages: session isolation", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("a customer can insert and read their own session's messages", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    const { rows } = await insertMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      "user",
      "I'd like a dosa",
    );
    expect(rows).toHaveLength(1);

    const { rows: selected } = await db.asUser(userId, (c) =>
      c.query(
        "select content from public.ai_conversation_messages where customer_session_id = $1;",
        [sessionId],
      ),
    );
    expect(selected).toHaveLength(1);
  });

  it("a DIFFERENT customer cannot read another session's messages", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertMessage(db, userId, restaurantId, sessionId, "user");

    const otherUserId = await db.createAuthUser();
    const { rows } = await db.asUser(otherUserId, (c) =>
      c.query(
        "select id from public.ai_conversation_messages where customer_session_id = $1;",
        [sessionId],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("a customer cannot insert a message into another customer's session", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const otherUserId = await db.createAuthUser();

    await expect(
      insertMessage(db, otherUserId, restaurantId, sessionId, "user"),
    ).rejects.toThrow(/row-level security/i);
  });

  it("Restaurant A's customer cannot read Restaurant B's conversation (cross-tenant)", async () => {
    const restaurantA = await createRestaurant(db);
    const tableA = await createTable(db, restaurantA);
    const sessionA = await createCustomerSession(db, restaurantA, tableA);

    const restaurantB = await createRestaurant(db);
    const tableB = await createTable(db, restaurantB);
    const sessionB = await createCustomerSession(db, restaurantB, tableB);
    await insertMessage(
      db,
      sessionB.userId,
      restaurantB,
      sessionB.sessionId,
      "user",
      "restaurant B secret",
    );

    const { rows } = await db.asUser(sessionA.userId, (c) =>
      c.query(
        "select id from public.ai_conversation_messages where restaurant_id = $1;",
        [restaurantB],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("an anonymous (no session at all) caller cannot read any conversation", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertMessage(db, userId, restaurantId, sessionId, "user");

    const { rows } = await db.asAnon((c) =>
      c.query(
        "select id from public.ai_conversation_messages where customer_session_id = $1;",
        [sessionId],
      ),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("ai_conversation_messages: append-only", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("no client role can UPDATE a message (not even the caller's own)", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const { rows } = await insertMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      "user",
      "original",
    );

    const result = await db.asUser(userId, (c) =>
      c.query(
        "update public.ai_conversation_messages set content = 'tampered' where id = $1;",
        [rows[0].id],
      ),
    );
    expect(result.affectedRows).toBe(0);

    const { rows: after } = await db.admin.query<{ content: string }>(
      "select content from public.ai_conversation_messages where id = $1;",
      [rows[0].id],
    );
    expect(after[0].content).toBe("original");
  });

  it("no client role can DELETE a message", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const { rows } = await insertMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      "user",
    );

    const result = await db.asUser(userId, (c) =>
      c.query("delete from public.ai_conversation_messages where id = $1;", [
        rows[0].id,
      ]),
    );
    expect(result.affectedRows).toBe(0);
  });
});

describe("ai_conversation_messages: constraints", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("rejects an invalid role", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    await expect(
      db.asUser(userId, (c) =>
        c.query(
          "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content) values ($1, $2, 'system', 'x');",
          [restaurantId, sessionId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects content over the length cap", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    await expect(
      insertMessage(
        db,
        userId,
        restaurantId,
        sessionId,
        "user",
        "x".repeat(8001),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a 'tool' row with no tool_name", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    await expect(
      insertMessage(db, userId, restaurantId, sessionId, "tool", "result"),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a non-'tool' row that has a tool_name set", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    await expect(
      db.asUser(userId, (c) =>
        c.query(
          "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content, tool_name) values ($1, $2, 'user', 'x', 'get_cart');",
          [restaurantId, sessionId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("a message can never point at a different restaurant's session (composite FK)", async () => {
    const restaurantA = await createRestaurant(db);
    const restaurantB = await createRestaurant(db);
    const tableB = await createTable(db, restaurantB);
    const sessionB = await createCustomerSession(db, restaurantB, tableB);

    await expect(
      db.admin.query(
        "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content) values ($1, $2, 'user', 'x');",
        [restaurantA, sessionB.sessionId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts a well-formed 'tool' row with tool_name and tool_success", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    const result = await db.asUser(userId, (c) =>
      c.query(
        "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content, tool_name, tool_success) values ($1, $2, 'tool', '{\"ok\":true}', 'get_cart', true);",
        [restaurantId, sessionId],
      ),
    );
    expect(result.affectedRows).toBe(1);
  });
});

describe("rate-limiting query correctness (the same COUNT src/lib/ai/rate-limit.ts issues)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("counts only this session's own 'user'-role messages within the window, scoped by RLS", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    for (let i = 0; i < 3; i++) {
      await insertMessage(
        db,
        userId,
        restaurantId,
        sessionId,
        "user",
        `message ${i}`,
      );
    }
    // An assistant reply shouldn't count toward the customer's own rate limit.
    await db.admin.query(
      "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content) values ($1, $2, 'assistant', 'reply');",
      [restaurantId, sessionId],
    );

    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ count: string }>(
        "select count(*) from public.ai_conversation_messages where customer_session_id = $1 and role = 'user' and created_at >= now() - interval '10 minutes';",
        [sessionId],
      ),
    );
    expect(Number(rows[0].count)).toBe(3);
  });
});

describe("get_public_order_settings() returns the AI toggles (Batch 7 extension)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("defaults to the restaurant_settings defaults (both true)", async () => {
    const restaurantId = await createRestaurant(db);
    const { rows } = await db.admin.query<{
      allow_ai_recommendations: boolean;
      allow_upselling: boolean;
    }>("select * from public.get_public_order_settings($1);", [restaurantId]);

    expect(rows[0].allow_ai_recommendations).toBe(true);
    expect(rows[0].allow_upselling).toBe(true);
  });

  it("reflects allow_ai_recommendations = false once a restaurant opts out", async () => {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurant_settings set allow_ai_recommendations = false where restaurant_id = $1;",
      [restaurantId],
    );

    const { rows } = await db.asAnon((c) =>
      c.query<{ allow_ai_recommendations: boolean }>(
        "select * from public.get_public_order_settings($1);",
        [restaurantId],
      ),
    );
    expect(rows[0].allow_ai_recommendations).toBe(false);
  });

  it("is callable by anon (the AI waiter availability check runs before any customer session exists)", async () => {
    const restaurantId = await createRestaurant(db);
    const { rows } = await db.asAnon((c) =>
      c.query("select * from public.get_public_order_settings($1);", [
        restaurantId,
      ]),
    );
    expect(rows).toHaveLength(1);
  });
});
