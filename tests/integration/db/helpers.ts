import type { TestDb } from "./setup";

export type Role = "owner" | "manager" | "kitchen" | "staff";

let counter = 0;
/** A slug-safe unique token, so fixtures from different tests sharing one DB never collide. */
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createRestaurant(
  db: TestDb,
  overrides: { name?: string; slug?: string } = {},
): Promise<string> {
  const slug = overrides.slug ?? unique("restaurant");
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.restaurants (name, slug) values ($1, $2) returning id;",
    [overrides.name ?? slug, slug],
  );
  const restaurantId = rows[0].id;
  await db.admin.query(
    "insert into public.restaurant_settings (restaurant_id) values ($1);",
    [restaurantId],
  );
  return restaurantId;
}

export async function addMember(
  db: TestDb,
  restaurantId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db.admin.query(
    "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, $3);",
    [restaurantId, userId, role],
  );
}

export async function createCategory(
  db: TestDb,
  restaurantId: string,
  name = unique("category"),
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.categories (restaurant_id, name) values ($1, $2) returning id;",
    [restaurantId, name],
  );
  return rows[0].id;
}

export async function createMenuItem(
  db: TestDb,
  restaurantId: string,
  categoryId: string,
  overrides: { name?: string; slug?: string; price?: number } = {},
): Promise<string> {
  const slug = overrides.slug ?? unique("item");
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, $3, $4, $5) returning id;",
    [
      restaurantId,
      categoryId,
      overrides.name ?? slug,
      slug,
      overrides.price ?? 9.99,
    ],
  );
  return rows[0].id;
}

export async function createIngredient(
  db: TestDb,
  restaurantId: string,
  name = unique("ingredient"),
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.ingredients (restaurant_id, name) values ($1, $2) returning id;",
    [restaurantId, name],
  );
  return rows[0].id;
}

export async function createAllergen(
  db: TestDb,
  restaurantId: string,
  name = unique("allergen"),
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.allergens (restaurant_id, name) values ($1, $2) returning id;",
    [restaurantId, name],
  );
  return rows[0].id;
}

export async function createModifier(
  db: TestDb,
  restaurantId: string,
  menuItemId: string,
  name = unique("modifier"),
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name) values ($1, $2, $3) returning id;",
    [restaurantId, menuItemId, name],
  );
  return rows[0].id;
}

export async function createTable(
  db: TestDb,
  restaurantId: string,
  tableNumber = unique("t"),
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.tables (restaurant_id, table_number) values ($1, $2) returning id;",
    [restaurantId, tableNumber],
  );
  return rows[0].id;
}

/** A ready-to-use restaurant with one member, one category, and one menu item. */
export async function fullRestaurantFixture(db: TestDb, role: Role = "owner") {
  const userId = await db.createAuthUser();
  const restaurantId = await createRestaurant(db);
  await addMember(db, restaurantId, userId, role);
  const categoryId = await createCategory(db, restaurantId);
  const menuItemId = await createMenuItem(db, restaurantId, categoryId);
  return { userId, restaurantId, categoryId, menuItemId };
}

export async function getTablePublicToken(
  db: TestDb,
  tableId: string,
): Promise<string> {
  const { rows } = await db.admin.query<{ public_token: string }>(
    "select public_token from public.tables where id = $1;",
    [tableId],
  );
  return rows[0].public_token;
}

export async function createModifierOption(
  db: TestDb,
  modifierId: string,
  overrides: {
    name?: string;
    priceAdjustment?: number;
    isAvailable?: boolean;
  } = {},
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.modifier_options (modifier_id, name, price_adjustment, is_available) values ($1, $2, $3, $4) returning id;",
    [
      modifierId,
      overrides.name ?? unique("option"),
      overrides.priceAdjustment ?? 0,
      overrides.isAvailable ?? true,
    ],
  );
  return rows[0].id;
}

/**
 * Simulates the anonymous-auth customer bootstrap the QR route handler
 * performs: a fresh auth.users row standing in for the anonymous Supabase
 * Auth identity, plus its customer_sessions row. Created via the admin
 * client for setup convenience (mirroring every other fixture in this
 * file) — the actual RLS enforcement is what the tests exercise
 * afterwards via db.asUser().
 */
export async function createCustomerSession(
  db: TestDb,
  restaurantId: string,
  tableId: string,
  overrides: {
    expiresInHours?: number;
    status?: "active" | "expired" | "closed";
  } = {},
): Promise<{ userId: string; sessionId: string }> {
  const userId = await db.createAuthUser();
  const expiresInHours = overrides.expiresInHours ?? 4;
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into public.customer_sessions (restaurant_id, table_id, user_id, status, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
     returning id;`,
    [
      restaurantId,
      tableId,
      userId,
      overrides.status ?? "active",
      String(expiresInHours),
    ],
  );
  return { userId, sessionId: rows[0].id };
}

export async function createCart(
  db: TestDb,
  restaurantId: string,
  customerSessionId: string,
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    "insert into public.carts (customer_session_id, restaurant_id) values ($1, $2) returning id;",
    [customerSessionId, restaurantId],
  );
  return rows[0].id;
}

/** A full customer-side fixture: restaurant + table + category + menu item + active session + empty cart. */
export async function fullCustomerFixture(db: TestDb) {
  const restaurantId = await createRestaurant(db);
  const tableId = await createTable(db, restaurantId);
  const categoryId = await createCategory(db, restaurantId);
  const menuItemId = await createMenuItem(db, restaurantId, categoryId);
  const { userId, sessionId } = await createCustomerSession(
    db,
    restaurantId,
    tableId,
  );
  const cartId = await createCart(db, restaurantId, sessionId);
  return {
    restaurantId,
    tableId,
    categoryId,
    menuItemId,
    userId,
    sessionId,
    cartId,
  };
}

/**
 * Inserts a cart_item as the owning customer (via db.asUser, so it's
 * subject to the same RLS the real add-to-cart action goes through), with
 * sensible defaults matching fullCustomerFixture's menu item ($9.99).
 */
export async function addCartItem(
  db: TestDb,
  userId: string,
  cartId: string,
  restaurantId: string,
  menuItemId: string,
  overrides: {
    quantity?: number;
    unitPrice?: number;
    modifiersPrice?: number;
    spicePreference?: string | null;
    notes?: string | null;
  } = {},
): Promise<string> {
  const quantity = overrides.quantity ?? 1;
  const unitPrice = overrides.unitPrice ?? 9.99;
  const modifiersPrice = overrides.modifiersPrice ?? 0;
  const lineTotal = Math.max(0, (unitPrice + modifiersPrice) * quantity);

  const { rows } = await db.asUser(userId, (c) =>
    c.query<{ id: string }>(
      "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, modifiers_price, line_total, spice_preference, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id;",
      [
        cartId,
        restaurantId,
        menuItemId,
        quantity,
        unitPrice,
        modifiersPrice,
        lineTotal,
        overrides.spicePreference ?? null,
        overrides.notes ?? null,
      ],
    ),
  );
  return rows[0].id;
}

export async function addCartItemModifier(
  db: TestDb,
  userId: string,
  cartItemId: string,
  restaurantId: string,
  modifierId: string,
  modifierOptionId: string,
  overrides: { name?: string; priceAdjustment?: number } = {},
): Promise<string> {
  const { rows } = await db.asUser(userId, (c) =>
    c.query<{ id: string }>(
      "insert into public.cart_item_modifiers (cart_item_id, restaurant_id, modifier_id, modifier_option_id, name, price_adjustment) values ($1, $2, $3, $4, $5, $6) returning id;",
      [
        cartItemId,
        restaurantId,
        modifierId,
        modifierOptionId,
        overrides.name ?? "Option",
        overrides.priceAdjustment ?? 0,
      ],
    ),
  );
  return rows[0].id;
}

export interface SubmittedOrder {
  id: string;
  restaurant_id: string;
  table_id: string;
  customer_session_id: string;
  order_number: number;
  status: string;
  subtotal: number;
  tax: number;
  service_charge: number;
  total: number;
  currency: string;
  customer_note: string | null;
  idempotency_key: string;
}

/** Calls submit_order() as the given customer user — the same RPC path src/lib/orders/submit-order.ts uses. */
export async function submitOrder(
  db: TestDb,
  userId: string,
  idempotencyKey: string,
  customerNote: string | null = null,
): Promise<SubmittedOrder> {
  const { rows } = await db.asUser(userId, (c) =>
    c.query<SubmittedOrder>("select * from public.submit_order($1, $2);", [
      idempotencyKey,
      customerNote,
    ]),
  );
  return rows[0];
}

/** Calls transition_order_status() as the given user (staff or otherwise) — the same RPC path src/lib/orders/transition.ts uses. */
export async function transitionOrderStatus(
  db: TestDb,
  userId: string,
  orderId: string,
  targetStatus: string,
): Promise<{ status: string }> {
  const { rows } = await db.asUser(userId, (c) =>
    c.query<{ status: string }>(
      "select status from public.transition_order_status($1, $2);",
      [orderId, targetStatus],
    ),
  );
  return rows[0];
}

/**
 * A restaurant with one staff member (default role: owner) and one
 * already-submitted order, ready for status-transition tests — the
 * customer-side setup (table/category/menu item/session/cart/submission)
 * is identical to fullCustomerFixture()/submitOrder() above, just bundled
 * for tests that only care about the resulting order.
 */
export async function fullOrderFixture(db: TestDb, staffRole: Role = "owner") {
  const restaurantId = await createRestaurant(db);
  const staffUserId = await db.createAuthUser();
  await addMember(db, restaurantId, staffUserId, staffRole);
  const tableId = await createTable(db, restaurantId);
  const categoryId = await createCategory(db, restaurantId);
  const menuItemId = await createMenuItem(db, restaurantId, categoryId);
  const { userId: customerUserId, sessionId } = await createCustomerSession(
    db,
    restaurantId,
    tableId,
  );
  const cartId = await createCart(db, restaurantId, sessionId);
  await addCartItem(db, customerUserId, cartId, restaurantId, menuItemId);
  const order = await submitOrder(db, customerUserId, unique("order-fixture"));
  return {
    restaurantId,
    staffUserId,
    tableId,
    categoryId,
    menuItemId,
    customerUserId,
    sessionId,
    orderId: order.id,
  };
}

/**
 * Puts a restaurant past its free first month (20261018120000), so the
 * platform fee and billing rules after it apply. New restaurants, fixtures
 * included, start inside it: no fee on card payments.
 */
export async function endFreeMonth(
  db: TestDb,
  restaurantId: string,
  daysAgo = 1,
): Promise<void> {
  await db.admin.query(
    "update public.restaurants set trial_ends_at = now() - make_interval(days => $2) where id = $1;",
    [restaurantId, daysAgo],
  );
}
