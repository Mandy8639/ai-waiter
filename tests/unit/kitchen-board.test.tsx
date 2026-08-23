// @vitest-environment jsdom
//
// Component-level coverage for the KDS's Realtime + polling reconciliation
// (Supabase ticket SU-452145 — postgres_changes INSERT delivery is not
// always reliable). Realtime and Supabase are faked (see the vi.mock calls
// below) so these tests are fast and deterministic; the pure
// interval/staleness/dedup decisions this component relies on are
// separately covered, without any mocking at all, in
// tests/unit/kds-reconciliation.test.ts.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KitchenBoard } from "@/components/kitchen/kitchen-board";
import type { KitchenOrder } from "@/lib/orders/kitchen";
import {
  KDS_NORMAL_POLL_INTERVAL_MS,
  KDS_DEGRADED_POLL_INTERVAL_MS,
} from "@/components/kitchen/kds-reconciliation";

const { mockFetchActiveOrders, realtimeState, removeChannelSpy } = vi.hoisted(
  () => ({
    mockFetchActiveOrders: vi.fn(),
    removeChannelSpy: vi.fn(),
    realtimeState: {
      onCallback: undefined as ((payload: unknown) => void) | undefined,
      statusCallback: undefined as ((status: string) => void) | undefined,
    },
  }),
);

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channelObj = {
      on: (
        _event: string,
        _filter: unknown,
        cb: (payload: unknown) => void,
      ) => {
        realtimeState.onCallback = cb;
        return channelObj;
      },
      subscribe: (cb: (status: string) => void) => {
        realtimeState.statusCallback = cb;
        return channelObj;
      },
    };
    return {
      channel: () => channelObj,
      removeChannel: removeChannelSpy,
    };
  },
}));

vi.mock("@/lib/orders/kitchen-actions", () => ({
  fetchActiveOrders: (...args: unknown[]) => mockFetchActiveOrders(...args),
  fetchOrderStatusHistory: vi.fn(async () => []),
}));

vi.mock("@/lib/orders/transition", () => ({
  transitionOrderStatus: vi.fn(),
}));

function makeOrder(overrides: Partial<KitchenOrder> = {}): KitchenOrder {
  return {
    id: "order-1",
    orderNumber: 1,
    status: "pending",
    tableLabel: "Table 1",
    customerNote: null,
    createdAt: new Date().toISOString(),
    items: [],
    ...overrides,
  };
}

/** Advances past the 250ms scheduleResync debounce and flushes the mocked fetch promise. */
async function flush(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function subscribed() {
  realtimeState.statusCallback?.("SUBSCRIBED");
}

function orderCardIds(): string[] {
  return Array.from(document.querySelectorAll("[data-order-number]")).map(
    (el) => el.getAttribute("data-order-number") ?? "",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchActiveOrders.mockReset();
  removeChannelSpy.mockReset();
  realtimeState.onCallback = undefined;
  realtimeState.statusCallback = undefined;
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("KitchenBoard — Realtime + polling reconciliation", () => {
  it("TEST 1: a Realtime INSERT adds a new order — exactly one appears", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual([]);

    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    act(() => realtimeState.onCallback?.({}));
    await flush();

    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 2: a missed Realtime INSERT is still discovered by polling, with no page refresh", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual([]);

    // The order now exists in the DB, but Realtime's INSERT event is
    // deliberately never fired here — only the poll timer should find it.
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 3: Realtime and polling both discover the same order — exactly ONE instance renders", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();

    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    // Realtime fires...
    act(() => realtimeState.onCallback?.({}));
    // ...and a poll tick also lands shortly after, before/around the same
    // time — both trigger the same full-replace resync().
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    const ids = orderCardIds();
    expect(ids).toEqual(["1"]);
    expect(ids.filter((id) => id === "1")).toHaveLength(1);
  });

  it("TEST 4: a Realtime UPDATE changes an order's status and the KDS reflects it", async () => {
    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "pending" })]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    expect(
      document.querySelector('[data-order-number="1"]')?.textContent,
    ).toContain("New");

    mockFetchActiveOrders.mockResolvedValue([
      makeOrder({ status: "confirmed" }),
    ]);
    act(() => realtimeState.onCallback?.({}));
    await flush();

    expect(
      document.querySelector('[data-order-number="1"]')?.textContent,
    ).not.toContain("New");
    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 5: a missed Realtime UPDATE is still reconciled by polling", async () => {
    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "pending" })]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();

    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "ready" })]);
    // No Realtime event fired — only the poll timer reconciles this.
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    expect(orderCardIds()).toEqual(["1"]);
    expect(
      document.querySelector('[data-order-number="1"]')?.textContent,
    ).not.toContain("New");
  });

  it("TEST 6: an order that becomes served/cancelled and drops out of the active query disappears from the board", async () => {
    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "ready" })]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual(["1"]);

    // getActiveOrdersForRestaurant() no longer returns it (served-window
    // expired, or cancelled) — the existing query behavior is reused as-is.
    mockFetchActiveOrders.mockResolvedValue([]);
    act(() => realtimeState.onCallback?.({}));
    await flush();

    expect(orderCardIds()).toEqual([]);
  });

  it("TEST 7: a temporary polling failure does not crash the board and leaves existing state intact", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual(["1"]);

    mockFetchActiveOrders.mockRejectedValueOnce(new Error("network blip"));
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    // State survives the failed poll — no crash, no cleared board.
    expect(orderCardIds()).toEqual(["1"]);
    expect(errorSpy).toHaveBeenCalled();

    // The next poll succeeds normally — the failure didn't kill polling.
    mockFetchActiveOrders.mockResolvedValue([
      makeOrder(),
      makeOrder({ id: "order-2", orderNumber: 2 }),
    ]);
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);
    expect(orderCardIds().sort()).toEqual(["1", "2"]);
  });

  it("TEST 8: Realtime disconnecting activates the fast (degraded) polling interval", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();

    act(() => realtimeState.statusCallback?.("CLOSED"));
    await flush();

    mockFetchActiveOrders.mockClear();
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    // Only the DEGRADED interval elapses — this must already be enough to
    // trigger a poll if the fast interval is actually active.
    await flush(KDS_DEGRADED_POLL_INTERVAL_MS + 300);

    expect(mockFetchActiveOrders).toHaveBeenCalled();
    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 9: Realtime reconnecting stops fast polling and resumes the normal interval", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();
    act(() => realtimeState.statusCallback?.("CLOSED"));
    await flush();

    act(() => realtimeState.statusCallback?.("SUBSCRIBED"));
    await flush();

    mockFetchActiveOrders.mockClear();
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    // Only enough time for the OLD degraded interval elapses — if the
    // board is still correctly on the normal (slower) interval, no poll
    // should fire yet.
    await flush(KDS_DEGRADED_POLL_INTERVAL_MS + 300);
    expect(mockFetchActiveOrders).not.toHaveBeenCalled();

    // The remaining time up to the full normal interval does trigger it.
    await flush(KDS_NORMAL_POLL_INTERVAL_MS - KDS_DEGRADED_POLL_INTERVAL_MS);
    expect(mockFetchActiveOrders).toHaveBeenCalled();
  });

  it("TEST 10: unmounting cleans up the polling timer and the Realtime subscription", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    const { unmount } = render(
      <KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />,
    );
    subscribed();
    await flush();

    unmount();
    expect(removeChannelSpy).toHaveBeenCalledTimes(1);

    mockFetchActiveOrders.mockClear();
    await flush(KDS_NORMAL_POLL_INTERVAL_MS * 2);

    // No further polling after unmount — no timer leak, no state update
    // on an unmounted component.
    expect(mockFetchActiveOrders).not.toHaveBeenCalled();
  });

  it("TEST 11: polling does not fire while the tab is hidden", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });

    mockFetchActiveOrders.mockClear();
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    expect(mockFetchActiveOrders).not.toHaveBeenCalled();
  });

  it("TEST 12: the tab becoming visible again triggers immediate reconciliation, not a wait for the next interval", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(<KitchenBoard restaurantId="r1" role="owner" initialOrders={[]} />);
    subscribed();
    await flush();

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await flush(1000);

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    // Far less than the normal poll interval — this only succeeds if the
    // visibilitychange listener reconciles immediately.
    await flush(500);

    expect(orderCardIds()).toEqual(["1"]);
  });
});
