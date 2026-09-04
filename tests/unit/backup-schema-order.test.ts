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
    expect(order).toEqual([]);
    expect(unresolved).toEqual(["a", "b"]);
  });

  it("still orders the acyclic tables when part of the graph cycles", () => {
    const { order, unresolved } = orderTablesForRestore(
      ["a", "b", "standalone"],
      [
        { child: "a", parent: "b" },
        { child: "b", parent: "a" },
      ],
    );
    expect(order).toEqual(["standalone"]);
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
    });
  });
});
