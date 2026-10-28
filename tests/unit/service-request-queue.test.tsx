// @vitest-environment jsdom
//
// The "tables waiting" queue on the dashboard. Found in the 2026-10-28
// busy-night simulation: a refresh already on its way when a waiter tapped
// "Done" came back with the request still open, the row reappeared, and
// the waiter tapped "Done" again (four times for one table).
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadOpenRequests = vi.fn();
const resolveServiceRequest = vi.fn();
vi.mock("@/lib/table-requests/actions", () => ({
  loadOpenRequests: (...args: unknown[]) => loadOpenRequests(...args),
  resolveServiceRequest: (...args: unknown[]) => resolveServiceRequest(...args),
}));

// The realtime channel: captured, so a test can fire "something changed".
const realtime = vi.hoisted(() => {
  const state = { onChange: () => {} };
  const channel = {
    on: (_event: string, _filter: unknown, cb: () => void) => {
      state.onChange = cb;
      return channel;
    },
    subscribe: () => channel,
  };
  return { state, client: { channel: () => channel } };
});
const onChange = () => realtime.state.onChange();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => realtime.client,
}));
vi.mock("@/lib/supabase/realtime", () => ({
  openAuthorizedChannel: (_client: unknown, make: () => unknown) => {
    make();
    return () => undefined;
  },
}));

const { ServiceRequestQueue } =
  await import("@/components/dashboard/service-request-queue");

const request = (id: string, table: string) => ({
  id,
  kind: "bill" as const,
  note: null,
  createdAt: new Date().toISOString(),
  tableId: `t-${table}`,
  tableNumber: table,
  tableDisplayName: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  loadOpenRequests.mockReset();
  resolveServiceRequest.mockReset();
});
afterEach(cleanup);

describe("clearing a table's request", () => {
  it("stays cleared when a slower refresh comes back with it still open", async () => {
    const stale = deferred<ReturnType<typeof request>[]>();
    loadOpenRequests.mockReturnValueOnce(stale.promise);
    resolveServiceRequest.mockResolvedValue({ ok: true });

    render(
      <ServiceRequestQueue
        restaurantId="r1"
        initial={[request("a", "3"), request("b", "6")]}
      />,
    );
    // A change elsewhere starts a refresh, which is slow...
    act(() => onChange());
    // ...and meanwhile the waiter taps Done on table 3.
    await act(async () => {
      screen.getAllByRole("button", { name: "Done" })[0].click();
    });
    expect(screen.queryByText(/Table 3/)).not.toBeInTheDocument();

    // The refresh that started before the tap arrives, still listing it.
    await act(async () =>
      stale.resolve([request("a", "3"), request("b", "6")]),
    );
    expect(screen.queryByText(/Table 3/)).not.toBeInTheDocument();
    expect(screen.getByText(/Table 6/)).toBeInTheDocument();
  });

  it("clears a second table while the first is still saving", async () => {
    const first = deferred<{ ok: boolean }>();
    resolveServiceRequest.mockReturnValueOnce(first.promise);
    resolveServiceRequest.mockResolvedValue({ ok: true });

    render(
      <ServiceRequestQueue
        restaurantId="r1"
        initial={[request("a", "7"), request("b", "4")]}
      />,
    );
    await act(async () => {
      screen.getAllByRole("button", { name: "Done" })[0].click(); // table 7, slow
    });
    await act(async () => {
      screen.getByRole("button", { name: "Done" }).click(); // table 4
    });
    expect(screen.queryByText(/Table 7/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Table 4/)).not.toBeInTheDocument();
    expect(resolveServiceRequest).toHaveBeenCalledWith("r1", "b");
    await act(async () => first.resolve({ ok: true }));
  });

  it("comes back if clearing it failed", async () => {
    loadOpenRequests.mockResolvedValue([request("a", "3")]);
    resolveServiceRequest.mockResolvedValue({ ok: false });

    render(
      <ServiceRequestQueue restaurantId="r1" initial={[request("a", "3")]} />,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Done" }).click();
    });
    expect(await screen.findByText(/Table 3/)).toBeInTheDocument();
  });

  it("fetches again after a slow refresh when something changed meanwhile, without piling up", async () => {
    const older = deferred<ReturnType<typeof request>[]>();
    const newer = deferred<ReturnType<typeof request>[]>();
    loadOpenRequests
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    render(<ServiceRequestQueue restaurantId="r1" initial={[]} />);
    act(() => onChange());
    act(() => onChange());
    act(() => onChange());
    await act(async () => newer.resolve([request("c", "9")]));
    await act(async () => older.resolve([]));
    expect(screen.getByText(/Table 9/)).toBeInTheDocument();
    // Two changes during one refresh cost one extra fetch, not two.
    expect(loadOpenRequests).toHaveBeenCalledTimes(2);
  });
});
