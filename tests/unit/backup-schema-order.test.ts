import { describe, it, expect } from "vitest";
import { orderTablesForRestore } from "@/lib/backup/schema-order";

describe("orderTablesForRestore", () => {
  it("puts a parent before its child", () => {
    const { order } = orderTablesForRestore(
      ["orders", "restaurants"],
      [{ child: "orders", parent: "restaurants" }],
    );
    expect(order.indexOf("restaurants")).toBeLessThan(order.indexOf("orders"));
  });

  it("orders a whole chain", () => {
    const { order } = orderTablesForRestore(
      ["order_items", "orders", "restaurants"],
      [
        { child: "orders", parent: "restaurants" },
        { child: "order_items", parent: "orders" },
      ],
    );
    expect(order).toEqual(["restaurants", "orders", "order_items"]);
  });

  it("includes tables with no foreign keys at all", () => {
    const { order, unresolved } = orderTablesForRestore(
      ["platform_plans", "restaurants"],
      [],
    );
    expect(order.sort()).toEqual(["platform_plans", "restaurants"]);
    expect(unresolved).toEqual([]);
  });

  it("ignores a self-reference, which no table order can satisfy", () => {
    // A parent_id-style column. Ordering can't help; the rows' own order
    // handles it. It must not be mistaken for a cycle and dropped.
    const { order, unresolved } = orderTablesForRestore(
      ["categories"],
      [{ child: "categories", parent: "categories" }],
    );
    expect(order).toEqual(["categories"]);
    expect(unresolved).toEqual([]);
  });

  it("ignores edges pointing outside the table set", () => {
    // e.g. a foreign key into auth.users, which isn't a public table.
    const { order, unresolved } = orderTablesForRestore(
      ["restaurant_users"],
      [{ child: "restaurant_users", parent: "users" }],
    );
    expect(order).toEqual(["restaurant_users"]);
    expect(unresolved).toEqual([]);
  });

  it("reports a genuine cycle instead of inventing an order that would fail", () => {
    const { order, unresolved } = orderTablesForRestore(
      ["a", "b"],
      [
        { child: "a", parent: "b" },
        { child: "b", parent: "a" },
      ],
    );
    // Reported, and still exported: a backup must never drop a table.
    expect(order).toEqual(["a", "b"]);
    expect(unresolved).toEqual(["a", "b"]);
  });

  it("breaks a cycle at a nullable key, which can go in empty", () => {
    // restaurants.active_hero_video_id -> restaurant_hero_videos (nullable),
    // restaurant_hero_videos.restaurant_id -> restaurants (required), and a
    // child of restaurants that must still come after it.
    const { order, unresolved } = orderTablesForRestore(
      ["restaurant_hero_videos", "restaurants", "menus"],
      [
        {
          child: "restaurants",
          parent: "restaurant_hero_videos",
          optional: true,
        },
        { child: "restaurant_hero_videos", parent: "restaurants" },
        { child: "menus", parent: "restaurants" },
      ],
    );
    expect(order).toEqual(["restaurants", "menus", "restaurant_hero_videos"]);
    expect(unresolved).toEqual([]);
  });

  it("lists the nullable columns a restore must fill in afterwards", () => {
    const { deferred } = orderTablesForRestore(
      ["menu_item_images", "menu_items"],
      [
        {
          child: "menu_items",
          parent: "menu_item_images",
          optional: true,
          nullableColumns: ["active_image_id"],
        },
        { child: "menu_item_images", parent: "menu_items" },
      ],
    );
    expect(deferred).toEqual([
      { table: "menu_items", columns: ["active_image_id"] },
    ]);
  });

  it("still orders the acyclic tables when part of the graph cycles", () => {
    const { order, unresolved } = orderTablesForRestore(
      ["a", "b", "standalone"],
      [
        { child: "a", parent: "b" },
        { child: "b", parent: "a" },
      ],
    );
    expect(order).toEqual(["standalone", "a", "b"]);
    expect(unresolved).toEqual(["a", "b"]);
  });

  it("is deterministic — the same input always gives the same order", () => {
    const input: [string[], { child: string; parent: string }[]] = [
      ["c", "a", "b"],
      [
        { child: "c", parent: "a" },
        { child: "b", parent: "a" },
      ],
    ];
    const first = orderTablesForRestore(...input).order;
    const second = orderTablesForRestore(...input).order;
    expect(first).toEqual(second);
    expect(first[0]).toBe("a");
  });

  it("returns an empty order for an empty schema", () => {
    expect(orderTablesForRestore([], [])).toEqual({
      order: [],
      unresolved: [],
      deferred: [],
    });
  });
});
