// @vitest-environment jsdom
//
// Component-level coverage for the customer order page's Realtime +
// polling reconciliation (Supabase ticket SU-452145 — postgres_changes
// delivery is not always reliable), mirroring kitchen-board.test.tsx's
// approach: Realtime, Supabase, and the Next.js router are faked so these
// tests are fast and deterministic. The pure interval/visibility rules
// this component relies on (resolvePagePollIntervalMs/shouldPollNow) are
// already covered, without any mocking, in kds-reconciliation.test.ts —
// not re-tested here.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatusSync } from "@/components/customer/order-status-sync";
import {
  PAGE_NORMAL_POLL_INTERVAL_MS,
  PAGE_DEGRADED_POLL_INTERVAL_MS,
} from "@/components/kitchen/kds-reconciliation";

const { mockRefresh, realtimeState, removeChannelSpy } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  removeChannelSpy: vi.fn(),
  realtimeState: {
    onCallback: undefined as ((payload: unknown) => void) | undefined,
    statusCallback: undefined as ((status: string) => void) | undefined,
  },
}));

vi.mock("next/navigation", () => {
  // A stable object, matching the real useRouter()'s stable reference
  // across re-renders — a fresh object per call would defeat
  // scheduleResync's useCallback([router]) memoization and cause the
  // Realtime effect to needlessly tear down and rebuild.
  const router = { refresh: mockRefresh };
  return { useRouter: () => router };
});

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

/** Advances past the 250ms scheduleResync debounce. */
async function flush(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function subscribed() {
  realtimeState.statusCallback?.("SUBSCRIBED");
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRefresh.mockReset();
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

describe("OrderStatusSync — Realtime + polling reconciliation", () => {
  it("subscribing triggers an initial refresh", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("a Realtime UPDATE for this order triggers a refresh", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();
    mockRefresh.mockClear();

    act(() => realtimeState.onCallback?.({}));
    await flush();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("a missed Realtime UPDATE is still reconciled by polling", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();
    mockRefresh.mockClear();

    // No Realtime event fired — only the poll timer should refresh.
    await flush(PAGE_NORMAL_POLL_INTERVAL_MS + 300);

    expect(mockRefresh).toHaveBeenCalled();
  });

  it("Realtime disconnecting activates the fast (degraded) polling interval", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();

    act(() => realtimeState.statusCallback?.("CLOSED"));
    await flush();
    mockRefresh.mockClear();

    // Only the DEGRADED interval elapses — this must already be enough to
    // trigger a refresh if the fast interval is actually active.
    await flush(PAGE_DEGRADED_POLL_INTERVAL_MS + 300);

    expect(mockRefresh).toHaveBeenCalled();
  });

  it("Realtime reconnecting stops fast polling and resumes the normal interval", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();
    act(() => realtimeState.statusCallback?.("CLOSED"));
    await flush();

    act(() => realtimeState.statusCallback?.("SUBSCRIBED"));
    await flush();
    mockRefresh.mockClear();

    // Only enough time for the OLD degraded interval elapses — if this is
    // correctly back on the normal (slower) interval, no refresh yet.
    await flush(PAGE_DEGRADED_POLL_INTERVAL_MS + 300);
    expect(mockRefresh).not.toHaveBeenCalled();

    // The remaining time up to the full normal interval does trigger it.
    await flush(PAGE_NORMAL_POLL_INTERVAL_MS - PAGE_DEGRADED_POLL_INTERVAL_MS);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("unmounting cleans up the polling timer and the Realtime subscription", async () => {
    const { unmount } = render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();

    unmount();
    expect(removeChannelSpy).toHaveBeenCalledTimes(1);

    mockRefresh.mockClear();
    await flush(PAGE_NORMAL_POLL_INTERVAL_MS * 2);

    // No further polling after unmount — no timer leak.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("polling does not fire while the tab is hidden", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    mockRefresh.mockClear();

    await flush(PAGE_NORMAL_POLL_INTERVAL_MS + 300);

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("the tab becoming visible again triggers immediate reconciliation, not a wait for the next interval", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await flush(1000);
    mockRefresh.mockClear();

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    // Far less than the normal poll interval — this only succeeds if the
    // visibilitychange listener reconciles immediately.
    await flush(500);

    expect(mockRefresh).toHaveBeenCalled();
  });

  it("coming back online triggers immediate reconciliation", async () => {
    render(<OrderStatusSync orderId="order-1" />);
    subscribed();
    await flush();
    mockRefresh.mockClear();

    act(() => window.dispatchEvent(new Event("online")));
    await flush(500);

    expect(mockRefresh).toHaveBeenCalled();
  });
});
