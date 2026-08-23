// @vitest-environment node
//
// Tests the exact query shape src/lib/ai/conversation.ts#getLatestSuccessfulToolCall
// runs (mirrored here as raw SQL, since that file has `server-only` and
// can't be imported directly — see tests/unit/ai-*.test.ts's header
// comments for why) — specifically the fix for the confirmation-gate
// regression: a same-turn request_order_confirmation re-verification call
// must never shadow a still-valid confirmation from an earlier turn. The
// pure decision logic given a correctly-selected row is already covered
// by tests/unit/ai-order-confirmation.test.ts; this file covers what that
// can't: whether the DATABASE actually returns the right row when there
// are multiple candidates at different timestamps.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createCustomerSession,
  createRestaurant,
  createTable,
} from "./helpers";

async function insertUserMessage(
  db: TestDb,
  userId: string,
  restaurantId: string,
  sessionId: string,
  createdAt: string,
) {
  await db.asUser(userId, (c) =>
    c.query(
      "insert into public.ai_conversation_messages (restaurant_id, customer_session_id, role, content, created_at) values ($1, $2, 'user', 'hi', $3);",
      [restaurantId, sessionId, createdAt],
    ),
  );
}

async function insertConfirmationCall(
  db: TestDb,
  userId: string,
  restaurantId: string,
  sessionId: string,
  createdAt: string,
  fingerprint = "fp-default",
) {
  await db.asUser(userId, (c) =>
    c.query(
      `insert into public.ai_conversation_messages
         (restaurant_id, customer_session_id, role, content, tool_name, tool_success, created_at)
       values ($1, $2, 'tool', $3, 'request_order_confirmation', true, $4);`,
      [
        restaurantId,
        sessionId,
        JSON.stringify({ ok: true, data: { cartFingerprint: fingerprint } }),
        createdAt,
      ],
    ),
  );
}

/** The exact query shape getLatestSuccessfulToolCall(sessionId, toolName, before) runs. */
async function queryLatestConfirmation(
  db: TestDb,
  userId: string,
  sessionId: string,
  before: string | null,
): Promise<{ content: string; created_at: string } | null> {
  const { rows } = await db.asUser(userId, (c) =>
    c.query<{ content: string; created_at: string }>(
      before
        ? `select content, created_at from public.ai_conversation_messages
           where customer_session_id = $1 and role = 'tool' and tool_name = 'request_order_confirmation'
             and tool_success = true and created_at < $2
           order by created_at desc limit 1;`
        : `select content, created_at from public.ai_conversation_messages
           where customer_session_id = $1 and role = 'tool' and tool_name = 'request_order_confirmation'
             and tool_success = true
           order by created_at desc limit 1;`,
      before ? [sessionId, before] : [sessionId],
    ),
  );
  return rows[0] ?? null;
}

describe("confirmation-gate query: latest request_order_confirmation strictly before a threshold", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("A. no confirmation exists → returns null", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertUserMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );

    const result = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );
    expect(result).toBeNull();
  });

  it("B. a prior-turn confirmation is found", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:05Z",
      "fp-prior",
    );

    const result = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.content).data.cartFingerprint).toBe("fp-prior");
  });

  it("C/D. a confirmation created in/after the current turn is excluded, even though it's the global latest", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertUserMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );
    // Same-turn / after-message confirmation — must never count.
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:15Z",
      "fp-same-turn",
    );

    const result = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );
    expect(result).toBeNull();
  });

  it("E (the critical regression test). prior-turn confirmation + same-turn re-verification → the query still returns the PRIOR-turn one, not the same-turn one", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );

    // Turn N: propose, confirmation stored.
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:05Z",
      "fp-cart-v1",
    );
    // Turn N+1 begins: the customer's "yes".
    const currentTurnUserMessageAt = "2026-01-01T00:00:20Z";
    await insertUserMessage(
      db,
      userId,
      restaurantId,
      sessionId,
      currentTurnUserMessageAt,
    );
    // Turn N+1: the model re-verifies by calling request_order_confirmation
    // AGAIN before submit_order — same cart, so same fingerprint, but this
    // row must not become "the" confirmation used for the gate check.
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:25Z",
      "fp-cart-v1",
    );

    const result = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      currentTurnUserMessageAt,
    );
    expect(result).not.toBeNull();
    // PGlite's raw driver returns timestamptz as a Date object (unlike
    // the real Supabase REST client, which always serializes to a JSON
    // string) — compare via getTime() rather than a raw `<`, which would
    // silently coerce the string side to NaN and always read false.
    expect(new Date(result!.created_at).getTime()).toBeLessThan(
      new Date(currentTurnUserMessageAt).getTime(),
    );
    expect(JSON.parse(result!.content).data.cartFingerprint).toBe("fp-cart-v1");

    // Sanity check: the OLD (pre-fix) unfiltered query would have picked
    // the same-turn row instead — proving this scenario actually
    // exercises the fix, not a no-op.
    const unfiltered = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      null,
    );
    expect(new Date(unfiltered!.created_at).getTime()).toBe(
      new Date("2026-01-01T00:00:25.000Z").getTime(),
    );
  });

  it("G. multiple prior confirmations → the latest one before the threshold wins, not an older one", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:01Z",
      "fp-oldest",
    );
    await insertConfirmationCall(
      db,
      userId,
      restaurantId,
      sessionId,
      "2026-01-01T00:00:05Z",
      "fp-most-recent-valid",
    );

    const result = await queryLatestConfirmation(
      db,
      userId,
      sessionId,
      "2026-01-01T00:00:10Z",
    );
    expect(JSON.parse(result!.content).data.cartFingerprint).toBe(
      "fp-most-recent-valid",
    );
  });

  it("H. a confirmation from a DIFFERENT customer session is never returned", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const sessionA = await createCustomerSession(db, restaurantId, tableId);
    const sessionB = await createCustomerSession(db, restaurantId, tableId);

    await insertConfirmationCall(
      db,
      sessionB.userId,
      restaurantId,
      sessionB.sessionId,
      "2026-01-01T00:00:01Z",
      "fp-belongs-to-B",
    );

    const result = await queryLatestConfirmation(
      db,
      sessionA.userId,
      sessionA.sessionId,
      "2026-01-01T00:00:10Z",
    );
    expect(result).toBeNull();
  });
});
