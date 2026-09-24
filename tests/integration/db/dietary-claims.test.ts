// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullRestaurantFixture } from "./helpers";

/**
 * Phase B's columns, against real Postgres running the real migration.
 *
 * The behaviour worth pinning here is the default. Every existing dish on
 * every existing menu gained these columns at `false`, and `false` must
 * mean "the restaurant has not said" — never a denial. A future migration
 * that made one of these NOT NULL with a different default, or backfilled
 * it from ingredients, would break the promise the whole feature rests on.
 */
describe("dietary claim columns", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("defaults every existing dish to unstated, not to denied", async () => {
    const { menuItemId } = await fullRestaurantFixture(db);
    const { rows } = await db.admin.query<{
      is_halal: boolean;
      is_kosher: boolean;
      is_high_protein: boolean;
    }>(
      "select is_halal, is_kosher, is_high_protein from public.menu_items where id = $1;",
      [menuItemId],
    );
    expect(rows[0]).toEqual({
      is_halal: false,
      is_kosher: false,
      is_high_protein: false,
    });
  });

  it("carries a comment saying what false means, for the next person", async () => {
    // The semantics are the feature. A column comment is where someone
    // reading the schema in a year will look.
    const { rows } = await db.admin.query<{ comment: string | null }>(
      `select col_description('public.menu_items'::regclass, ordinal_position) as comment
       from information_schema.columns
       where table_schema = 'public' and table_name = 'menu_items'
         and column_name = 'is_halal';`,
    );
    expect(rows[0].comment).toMatch(/never that the dish is not halal/i);
    expect(rows[0].comment).toMatch(/never inferred/i);
  });

  it("lets an owner assert a claim and a diner read it", async () => {
    const { userId, restaurantId, menuItemId } =
      await fullRestaurantFixture(db);

    await db.asUser(userId, (client) =>
      client.query(
        "update public.menu_items set is_halal = true where id = $1;",
        [menuItemId],
      ),
    );

    // Diners read menu_items through the public storefront policy.
    await db.admin.query(
      "update public.restaurants set is_active = true where id = $1;",
      [restaurantId],
    );
    const { rows } = await db.asAnon((client) =>
      client.query<{ is_halal: boolean }>(
        "select is_halal from public.menu_items where id = $1;",
        [menuItemId],
      ),
    );
    expect(rows[0]?.is_halal).toBe(true);
  });

  it("refuses a claim set by someone outside the restaurant", async () => {
    const { menuItemId } = await fullRestaurantFixture(db);
    const outsider = await fullRestaurantFixture(db);

    await db.asUser(outsider.userId, (client) =>
      client.query(
        "update public.menu_items set is_halal = true where id = $1;",
        [menuItemId],
      ),
    );

    // RLS makes this a no-op rather than an error: the row is invisible.
    const { rows } = await db.admin.query<{ is_halal: boolean }>(
      "select is_halal from public.menu_items where id = $1;",
      [menuItemId],
    );
    expect(rows[0].is_halal).toBe(false);
  });
});
