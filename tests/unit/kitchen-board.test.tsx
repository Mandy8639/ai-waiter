// @vitest-environment jsdom
//
// Component-level coverage for the KDS's Realtime + polling reconciliation
// (Supabase ticket SU-452145 — postgres_changes INSERT delivery is not
// always reliable). Realtime and Supabase are faked (see the vi.mock calls
// below) so these tests are fast and deterministic; the pure
// interval/staleness/dedup decisions this component relies on are
// separately covered, without any mocking at all, in
// tests/unit/kds-reconciliation.test.ts.
import { act, cleanup, render, screen } from "@testing-library/react";
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

// The token-first join is openAuthorizedChannel's own test
// (realtime-authorized-channel.test.ts); here the channel opens at once.
vi.mock("@/lib/supabase/realtime", () => ({
  // The shared Broadcast listener (realtime.ts), over the fake client.
  listenToTopic: (
    supabase: {
      channel: (
        topic: string,
        options?: unknown,
      ) => {
        on: (
          event: string,
          filter: unknown,
          cb: (message: unknown) => void,
        ) => {
          subscribe: (cb: (status: string) => void) => unknown;
        };
      };
      removeChannel?: (channel: unknown) => unknown;
    },
    topic: string,
    listener: {
      onMessage: (payload: Record<string, unknown>) => void;
      onStatus?: (status: string) => void;
    },
  ) => {
    const channel = supabase
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: "change" }, (message) =>
        listener.onMessage(
          ((message as { payload?: Record<string, unknown> })?.payload ??
            {}) as Record<string, unknown>,
        ),
      )
      .subscribe((status) => listener.onStatus?.(status));
    return () => void supabase.removeChannel?.(channel);
  },
  openAuthorizedChannel: (
    supabase: { removeChannel: (channel: unknown) => unknown },
    open: () => unknown,
  ) => {
    const channel = open();
    return () => void supabase.removeChannel(channel);
  },
}));

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

vi.mock("@/lib/pickup/actions", () => ({
  pushBackPickup: vi.fn(async () => ({})),
}));

vi.mock("@/lib/printing/actions", () => ({
  requestPrint: vi.fn(),
}));
vi.mock("@/lib/kitchen/station-actions", () => ({
  setStationDone: vi.fn(async () => ({})),
}));

vi.mock("@/lib/orders/ticket-groups", () => ({
  transitionTicketGroupStatus: vi.fn(),
  splitOrderIntoTickets: vi.fn(),
  mergeOrdersIntoTicket: vi.fn(),
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
    ticketGroups: [],
    mergedWithOrderIds: [],
    stationsDone: [],
    pickup: null,
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual([]);

    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    act(() => realtimeState.onCallback?.({ payload: { table: "orders" } }));
    await flush();

    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 2: a missed Realtime INSERT is still discovered by polling, with no page refresh", async () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
    subscribed();
    await flush();

    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    // Realtime fires...
    act(() => realtimeState.onCallback?.({ payload: { table: "orders" } }));
    // ...and a poll tick also lands shortly after, before/around the same
    // time — both trigger the same full-replace resync().
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);

    const ids = orderCardIds();
    expect(ids).toEqual(["1"]);
    expect(ids.filter((id) => id === "1")).toHaveLength(1);
  });

  it("TEST 4: a Realtime UPDATE changes an order's status and the KDS reflects it", async () => {
    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "pending" })]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
    subscribed();
    await flush();
    expect(
      document.querySelector('[data-order-number="1"]')?.textContent,
    ).toContain("New");

    mockFetchActiveOrders.mockResolvedValue([
      makeOrder({ status: "confirmed" }),
    ]);
    act(() => realtimeState.onCallback?.({ payload: { table: "orders" } }));
    await flush();

    expect(
      document.querySelector('[data-order-number="1"]')?.textContent,
    ).not.toContain("New");
    expect(orderCardIds()).toEqual(["1"]);
  });

  it("TEST 5: a missed Realtime UPDATE is still reconciled by polling", async () => {
    mockFetchActiveOrders.mockResolvedValue([makeOrder({ status: "pending" })]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
    subscribed();
    await flush();
    expect(orderCardIds()).toEqual(["1"]);

    // getActiveOrdersForRestaurant() no longer returns it (served-window
    // expired, or cancelled) — the existing query behavior is reused as-is.
    mockFetchActiveOrders.mockResolvedValue([]);
    act(() => realtimeState.onCallback?.({ payload: { table: "orders" } }));
    await flush();

    expect(orderCardIds()).toEqual([]);
  });

  it("TEST 7: a temporary polling failure does not crash the board and leaves existing state intact", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
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

describe("KitchenBoard — a refresh that hangs", () => {
  // Found in the 2026-10-28 busy-night simulation: one hung refresh froze
  // a kitchen tablet for six minutes, because a browser sends server
  // actions one at a time and every poll tick queued another behind it.
  it("doesn't pile up polls behind it, and catches up once it gives up", async () => {
    let fail!: (error: Error) => void;
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[]}
      />,
    );
    subscribed();
    await flush();

    // The next refresh hangs (Supabase overloaded)...
    mockFetchActiveOrders.mockReturnValueOnce(
      new Promise((_resolve, reject) => (fail = reject)),
    );
    await flush(KDS_NORMAL_POLL_INTERVAL_MS + 300);
    const callsWhenHung = mockFetchActiveOrders.mock.calls.length;

    // ...through three more poll ticks: none of them queue another call.
    mockFetchActiveOrders.mockResolvedValue([makeOrder()]);
    await flush(KDS_NORMAL_POLL_INTERVAL_MS * 3);
    expect(mockFetchActiveOrders.mock.calls.length).toBe(callsWhenHung);
    expect(orderCardIds()).toEqual([]);

    // It finally fails (fetch-timeout.ts); one follow-up finds the order.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => fail(new Error("timed out")));
    await flush();
    expect(orderCardIds()).toEqual(["1"]);
    expect(mockFetchActiveOrders.mock.calls.length).toBe(callsWhenHung + 1);
  });
});

describe("KitchenBoard — unaccepted orders keep asking", () => {
  it("says in writing how many orders are waiting to be accepted", async () => {
    // The alert cannot exist only as a noise: a kitchen mutes the board on
    // its first busy night, and a muted alert has simply not happened.
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[
          makeOrder({ id: "a", status: "pending" }),
          makeOrder({ id: "b", status: "pending" }),
        ]}
      />,
    );
    expect(
      screen.getByText(/2 orders are waiting to be accepted/i),
    ).toBeTruthy();
  });

  it("says nothing when every order has been accepted", async () => {
    // A kitchen that is keeping up should hear and see nothing at all.
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[makeOrder({ id: "a", status: "preparing" })]}
      />,
    );
    expect(screen.queryByText(/waiting to be accepted/i)).toBeNull();
  });

  it("stops reminding once the last order is accepted", async () => {
    // The regression that matters: an interval that outlives the thing it
    // was reminding about is worse than no reminder, because the next
    // thing staff do is mute the board permanently.
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[makeOrder({ id: "a", status: "pending" })]}
      />,
    );
    expect(screen.getByText(/waiting to be accepted/i)).toBeTruthy();

    mockFetchActiveOrders.mockResolvedValue([
      makeOrder({ id: "a", status: "confirmed" }),
    ]);
    act(() => realtimeState.onCallback?.({ payload: { table: "orders" } }));
    await flush();

    expect(screen.queryByText(/waiting to be accepted/i)).toBeNull();
  });
});

describe("KitchenBoard — pickup orders", () => {
  const pickup = (startInMinutes: number) => ({
    at: new Date(Date.now() + (startInMinutes + 20) * 60_000).toISOString(),
    time: "18:00",
    name: "Priya",
    startAt: new Date(Date.now() + startInMinutes * 60_000).toISOString(),
    startTime: "17:40",
    slotMinutes: 15,
  });

  it("puts an accepted pickup order that starts later below the work that is due", () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[
          makeOrder({ id: "a", orderNumber: 1, status: "confirmed" }),
          makeOrder({
            id: "b",
            orderNumber: 2,
            status: "confirmed",
            pickup: pickup(120),
          }),
          makeOrder({
            id: "c",
            orderNumber: 3,
            status: "confirmed",
            pickup: pickup(-5),
          }),
        ]}
      />,
    );
    expect(orderCardIds()).toEqual(["1", "3", "2"]);
    expect(screen.getByText("Start 17:40")).toBeTruthy();
    expect(screen.getByText("Start now")).toBeTruthy();
  });

  it("tells the kitchen when to start a pickup order it hasn't accepted yet", () => {
    mockFetchActiveOrders.mockResolvedValue([]);
    render(
      <KitchenBoard
        restaurantId="r1"
        restaurantName="Test"
        timeZone="UTC"
        role="owner"
        initialOrders={[makeOrder({ status: "pending", pickup: pickup(120) })]}
      />,
    );
    expect(screen.getByText("Start 17:40")).toBeTruthy();
    expect(screen.queryByText("Start now")).toBeNull();
  });
});
