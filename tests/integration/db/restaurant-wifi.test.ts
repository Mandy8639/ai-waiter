// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCustomerSession,
  createRestaurant,
  createTable,
} from "./helpers";

/**
 * Guest Wi-Fi (20261201090000), against the real migration: owners and
 * managers set it, staff and guests seated at that restaurant read it,
 * and nobody else does — not the public, not a guest at another
 * restaurant, not a direct table read.
 */
describe("restaurant wifi", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function restaurantWithOwner() {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    return { restaurantId, owner };
  }

  const setWifi = (
    userId: string,
    restaurantId: string,
    ssid: string | null,
    password: string | null = "dosa-and-chai",
    security = "WPA",
  ) =>
    db.asUser(userId, (c) =>
      c.query("select public.set_restaurant_wifi($1, $2, $3, $4, false);", [
        restaurantId,
        ssid,
        password,
        security,
      ]),
    );

  const asGuest = (userId: string) =>
    db.asUser(userId, async (c) => {
      const { rows } = await c.query<{ ssid: string; password: string | null }>(
        "select * from public.restaurant_wifi_for_guest();",
      );
      return rows;
    });

  const asStaff = (userId: string, restaurantId: string) =>
    db.asUser(userId, async (c) => {
      const { rows } = await c.query<{ ssid: string }>(
        "select * from public.restaurant_wifi_for_staff($1);",
        [restaurantId],
      );
      return rows;
    });

  it("lets the owner set it and a seated guest read it", async () => {
    const { restaurantId, owner } = await restaurantWithOwner();
    await setWifi(owner, restaurantId, "LanternGuest");

    const tableId = await createTable(db, restaurantId);
    const { userId } = await createCustomerSession(db, restaurantId, tableId);
    expect(await asGuest(userId)).toEqual([
      expect.objectContaining({
        ssid: "LanternGuest",
        password: "dosa-and-chai",
      }),
    ]);
  });

  it("gives staff the details but not the right to change them", async () => {
    const { restaurantId, owner } = await restaurantWithOwner();
    await setWifi(owner, restaurantId, "LanternGuest");
    const staff = await db.createAuthUser();
    await addMember(db, restaurantId, staff, "staff");

    expect(await asStaff(staff, restaurantId)).toHaveLength(1);
    await expect(setWifi(staff, restaurantId, "Hijacked")).rejects.toThrow(
      /WIFI_FORBIDDEN/,
    );
  });

  it("shows nothing to a guest at another restaurant, a stranger, or the public", async () => {
    const { restaurantId, owner } = await restaurantWithOwner();
    await setWifi(owner, restaurantId, "LanternGuest");

    const other = await createRestaurant(db);
    const otherTable = await createTable(db, other);
    const { userId: elsewhere } = await createCustomerSession(
      db,
      other,
      otherTable,
    );
    expect(await asGuest(elsewhere)).toHaveLength(0);

    const stranger = await db.createAuthUser();
    expect(await asStaff(stranger, restaurantId)).toHaveLength(0);
    expect(await asGuest(stranger)).toHaveLength(0);

    await expect(
      db.asAnon((c) =>
        c.query("select * from public.restaurant_wifi_for_guest();"),
      ),
    ).rejects.toThrow();
    // And no direct read, even for the owner.
    const direct = await db.asUser(owner, async (c) => {
      const { rows } = await c.query("select * from public.restaurant_wifi;");
      return rows;
    });
    expect(direct).toHaveLength(0);
  });

  it("stops showing it to a guest whose session has ended", async () => {
    const { restaurantId, owner } = await restaurantWithOwner();
    await setWifi(owner, restaurantId, "LanternGuest");
    const tableId = await createTable(db, restaurantId);
    const { userId } = await createCustomerSession(db, restaurantId, tableId, {
      status: "closed",
    });
    expect(await asGuest(userId)).toHaveLength(0);
  });

  it("clears it with a blank name, and stores no password for an open network", async () => {
    const { restaurantId, owner } = await restaurantWithOwner();
    await setWifi(owner, restaurantId, "Open", "ignored", "nopass");
    const { rows } = await db.admin.query<{ password: string | null }>(
      "select password from public.restaurant_wifi where restaurant_id = $1;",
      [restaurantId],
    );
    expect(rows[0].password).toBeNull();

    await setWifi(owner, restaurantId, null);
    const after = await db.admin.query(
      "select 1 from public.restaurant_wifi where restaurant_id = $1;",
      [restaurantId],
    );
    expect(after.rows).toHaveLength(0);
  });
});
