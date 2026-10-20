// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchPush,
  isGoneStatus,
  isSafeNotificationUrl,
  orderPayload,
  orderRingPayload,
  tableRequestPayload,
  type DispatchDeps,
  type PushTarget,
  type SendOutcome,
} from "@/lib/push/dispatch-core";

/**
 * Phase F: kitchen push.
 *
 * The rules live in dispatch-core.ts with their I/O injected, so they are
 * tested here without a push service, keys or a database. The last block
 * guards the security boundary around the service-role sender, which no
 * type checker can see.
 */

const target = (id: string): PushTarget => ({
  id,
  endpoint: `https://push.example/${id}`,
  p256dh: "p".repeat(87),
  auth: "a".repeat(22),
});

function deps(overrides: Partial<DispatchDeps> = {}) {
  const calls = {
    delivered: [] as string[],
    failed: [] as string[],
    removed: [] as string[],
  };
  const base: DispatchDeps = {
    claim: async () => true,
    targets: async () => [target("one"), target("two")],
    send: async () => ({ ok: true }),
    markDelivered: async (ids) => {
      calls.delivered.push(...ids);
    },
    markFailed: async (ids) => {
      calls.failed.push(...ids);
    },
    remove: async (ids) => {
      calls.removed.push(...ids);
    },
    ...overrides,
  };
  return { deps: base, calls };
}

const payload = orderPayload({
  id: "o1",
  orderNumber: 1042,
  itemCount: 3,
  table: { number: "4", displayName: null },
});

describe("dispatching", () => {
  it("sends to every subscribed device", async () => {
    const send = vi.fn(async (): Promise<SendOutcome> => ({ ok: true }));
    const { deps: d, calls } = deps({ send });
    const report = await dispatchPush(d, payload);
    expect(send).toHaveBeenCalledTimes(2);
    expect(report).toEqual({ delivered: 2, failed: 0, removed: 0 });
    expect(calls.delivered).toEqual(["one", "two"]);
  });

  it("sends nothing the second time for the same order", async () => {
    // submit_order() is idempotent; a retry returns the same order.
    const send = vi.fn();
    const { deps: d } = deps({ claim: async () => false, send });
    const report = await dispatchPush(d, payload);
    expect(report.skipped).toBe("already_sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports when no device has alerts on", async () => {
    const { deps: d } = deps({ targets: async () => [] });
    expect((await dispatchPush(d, payload)).skipped).toBe("no_devices");
  });

  it("forgets a device the push service says is gone", async () => {
    const { deps: d, calls } = deps({
      send: async (t) =>
        t.id === "one"
          ? { ok: false, gone: true, statusCode: 410 }
          : { ok: true },
    });
    const report = await dispatchPush(d, payload);
    expect(calls.removed).toEqual(["one"]);
    expect(calls.delivered).toEqual(["two"]);
    expect(report).toEqual({ delivered: 1, failed: 0, removed: 1 });
  });

  it("only counts a failure that isn't a clear 'gone'", async () => {
    const { deps: d, calls } = deps({
      send: async () => ({ ok: false, gone: false, statusCode: 503 }),
    });
    await dispatchPush(d, payload);
    expect(calls.failed).toEqual(["one", "two"]);
    expect(calls.removed).toEqual([]);
  });

  it("treats a send that throws as a failure, not a deletion", async () => {
    const { deps: d, calls } = deps({
      send: async () => {
        throw new Error("socket hang up");
      },
    });
    const report = await dispatchPush(d, payload);
    expect(report.failed).toBe(2);
    expect(calls.removed).toEqual([]);
  });

  it("does not let one slow device hold up the others", async () => {
    const order: string[] = [];
    const { deps: d } = deps({
      send: async (t) => {
        if (t.id === "one") await new Promise((r) => setTimeout(r, 30));
        order.push(t.id);
        return { ok: true };
      },
    });
    await dispatchPush(d, payload);
    expect(order).toEqual(["two", "one"]);
  });

  it("recognises exactly 404 and 410 as gone", () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
    expect(isGoneStatus(429)).toBe(false);
    expect(isGoneStatus(500)).toBe(false);
    expect(isGoneStatus(undefined)).toBe(false);
  });
});

describe("what the kitchen reads", () => {
  it("names the order and the table", () => {
    expect(payload).toEqual({
      title: "New order #1042",
      body: "Table 4 · 3 items",
      url: "/dashboard/kitchen",
      tag: "order-o1",
      group: "order-o1",
      urgent: true,
    });
  });

  it("puts nothing a passer-by shouldn't read on a lock screen", () => {
    // No dish names, prices or notes: the board has those, one tap away.
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/\$|note|biryani/i);
  });

  it("uses the table's display name when it has one", () => {
    expect(
      orderPayload({
        id: "o2",
        orderNumber: 7,
        itemCount: 1,
        table: { number: "12", displayName: "Patio" },
      }).body,
    ).toBe("Table 12 (Patio) · 1 item");
  });

  it("words the two table requests differently", () => {
    const table = { number: "4", displayName: null };
    expect(tableRequestPayload({ id: "r1", kind: "bill", table }).title).toBe(
      "Table 4 asked for the bill",
    );
    expect(tableRequestPayload({ id: "r2", kind: "waiter", table }).title).toBe(
      "Table 4 is asking for a waiter",
    );
  });

  it("gives each event its own tag, so a repeat replaces rather than stacks", () => {
    expect(payload.tag).toBe("order-o1");
    expect(
      tableRequestPayload({
        id: "r1",
        kind: "bill",
        table: { number: "4", displayName: null },
      }).tag,
    ).toBe("request-r1");
  });
});

describe("keep ringing until accepted", () => {
  const order = {
    id: "o9",
    orderNumber: 12,
    itemCount: 2,
    table: { number: "4", displayName: null },
  };

  it("marks orders urgent, and nothing else", () => {
    expect(orderPayload(order).urgent).toBe(true);
    expect(
      tableRequestPayload({
        id: "r9",
        kind: "waiter",
        table: order.table,
      }).urgent,
    ).toBeUndefined();
  });

  it("says the order is still waiting, in the first alert's group so it replaces it", () => {
    const ring = orderRingPayload(order, 3);
    expect(ring.title).toBe("Order #12 is waiting");
    expect(ring.body).toBe("Table 4 · 2 items · tap to accept");
    expect(ring.group).toBe(orderPayload(order).group);
    expect(ring.url).toBe("/dashboard/kitchen");
    expect(ring.urgent).toBe(true);
  });

  it("gives every ring its own tag, so Android rings instead of swapping the text silently", () => {
    const tags = [1, 2, 3].map((n) => orderRingPayload(order, n).tag);
    expect(new Set([...tags, orderPayload(order).tag]).size).toBe(4);
    expect(tags[0]).toBe("order-o9-ring-1");
  });

  it("re-alerts on the device for a reused tag, and buzzes harder for an order", () => {
    const worker = readFileSync(path.resolve("public/sw.js"), "utf8");
    expect(worker).toMatch(/renotify: typeof payload\.tag === "string"/);
    expect(worker).toMatch(/vibrate: payload\.urgent === true/);
    // Earlier alerts of the same group are closed before the new one shows.
    expect(worker).toMatch(/notification\.data\.group === group/);
    expect(worker).toMatch(/notification\.close\(\)/);
  });
});

describe("where a notification can take someone", () => {
  it.each(["/dashboard", "/dashboard/kitchen", "/dashboard/orders/123"])(
    "allows %s",
    (url) => expect(isSafeNotificationUrl(url)).toBe(true),
  );

  it.each([
    "https://evil.example",
    "//evil.example/dashboard",
    "/dashboardx",
    "/r/menu",
    "javascript:alert(1)",
    "/dashboard/../login",
  ])("refuses %s", (url) => expect(isSafeNotificationUrl(url)).toBe(false));

  it("is the same rule the service worker applies on the device", () => {
    const sw = readFileSync(path.resolve("public/sw.js"), "utf8");
    const swPattern = sw.match(/\/\^\\\/dashboard[^\n]*?\/i/)?.[0];
    expect(swPattern).toBe(String(/^\/dashboard(\/[a-z0-9/_-]*)?$/i));
  });
});

describe("the boundary around the service-role sender", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : /\.(ts|tsx)$/.test(name)
          ? [full]
          : [];
    });
  }

  it("is never a server action, so no browser can call it", () => {
    const source = readFileSync(
      path.resolve("src/lib/push/dispatch.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*["']use server["']/m);
    expect(source).toMatch(/import "server-only"/);
  });

  it("is imported only by the places that just created an order or request", () => {
    // Each of these hands it an id the database returned in the same
    // request. A new importer is a new way to reach the admin client and
    // should be a deliberate decision, not a convenience.
    const importers = sourceFiles(path.resolve("src"))
      .filter((file) =>
        /from ["']@\/lib\/push\/dispatch["']|from ["']\.\/dispatch["']/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(importers).toEqual([
      // The order-ring scheduler: takes no ids at all, and is locked by
      // ORDER_RING_SECRET (tests/unit/order-ring-route.test.ts).
      "src/app/api/cron/order-ring/route.ts",
      "src/lib/ai/tools/service.ts",
      // A diner's own cancel: customer_cancel_order() just accepted this id
      // as theirs; phones still ringing for it go quiet.
      "src/lib/orders/customer-cancel.ts",
      "src/lib/orders/submit-order.ts",
      // Confirm/Cancel on the kitchen board: tells Android phones to stop
      // ringing for an order the database just let this member update.
      "src/lib/orders/transition.ts",
      "src/lib/push/actions.ts",
      "src/lib/table-requests/actions.ts",
    ]);
  });
});
