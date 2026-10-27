// SettleUpSync: a burst of order and payment changes shares one refresh,
// refreshes stay MIN_REFRESH_GAP_MS apart, and an open dialog holds the
// refresh until it closes. Realtime, Supabase and the router are faked the
// way order-status-sync.test.tsx fakes them.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettleUpSync } from "@/components/payments/settle-up-sync";

const { mockRefresh, realtimeState } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  realtimeState: {
    onCallbacks: [] as Array<(payload: unknown) => void>,
    statusCallback: undefined as ((status: string) => void) | undefined,
  },
}));

vi.mock("next/navigation", () => {
  const router = { refresh: mockRefresh };
  return { useRouter: () => router };
});

vi.mock("@/lib/supabase/realtime", () => ({
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
        realtimeState.onCallbacks.push(cb);
        return channelObj;
      },
      subscribe: (cb: (status: string) => void) => {
        realtimeState.statusCallback = cb;
        return channelObj;
      },
    };
    return { channel: () => channelObj, removeChannel: vi.fn() };
  },
}));

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Order and payment changes, as Realtime delivers them. */
function changes(count: number) {
  for (let i = 0; i < count; i++) {
    realtimeState.onCallbacks[i % realtimeState.onCallbacks.length]?.({});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRefresh.mockReset();
  realtimeState.onCallbacks = [];
  realtimeState.statusCallback = undefined;
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SettleUpSync", () => {
  it("refreshes once for a burst of changes", async () => {
    render(<SettleUpSync restaurantId="r1" />);
    changes(8);
    await advance(300);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps refreshes at least 2.5 seconds apart", async () => {
    render(<SettleUpSync restaurantId="r1" />);
    changes(1);
    await advance(300);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    changes(3);
    await advance(1_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await advance(1_500);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it("waits for an open dialog to close", async () => {
    render(<SettleUpSync restaurantId="r1" />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    changes(1);
    await advance(5_000);
    expect(mockRefresh).not.toHaveBeenCalled();

    dialog.remove();
    await advance(2_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
