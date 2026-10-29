import { describe, expect, it, vi } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { listenToTopic, openAuthorizedChannel } from "@/lib/supabase/realtime";

function fakeClient(setAuth: () => Promise<void>) {
  return {
    realtime: { setAuth: vi.fn(setAuth) },
    removeChannel: vi.fn(async () => "ok"),
  };
}

const channel = { topic: "realtime:test" } as unknown as RealtimeChannel;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openAuthorizedChannel", () => {
  it("joins only after the session token is loaded", async () => {
    let release!: () => void;
    const client = fakeClient(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const open = vi.fn(() => channel);

    openAuthorizedChannel(client, open);
    await flush();
    expect(client.realtime.setAuth).toHaveBeenCalledWith();
    expect(open).not.toHaveBeenCalled();

    release();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("removes the channel when closed after joining", async () => {
    const client = fakeClient(async () => undefined);
    const close = openAuthorizedChannel(client, () => channel);
    await flush();

    close();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("never joins when closed before the token arrives", async () => {
    let release!: () => void;
    const client = fakeClient(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const open = vi.fn(() => channel);

    const close = openAuthorizedChannel(client, open);
    close();
    release();
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("still joins when loading the token fails", async () => {
    const client = fakeClient(async () => {
      throw new Error("offline");
    });
    const open = vi.fn(() => channel);

    openAuthorizedChannel(client, open);
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
  });
});

/** A client whose channels deliver Broadcast messages on demand. */
function broadcastClient() {
  const channels: Array<{
    topic: string;
    options: unknown;
    send: (payload: unknown) => void;
    setStatus: (status: string) => void;
  }> = [];
  const client = {
    realtime: { setAuth: vi.fn(async () => undefined) },
    removeChannel: vi.fn(async () => "ok"),
    channel: vi.fn((topic: string, options: unknown) => {
      let onMessage: (message: unknown) => void = () => undefined;
      let onStatus: (status: string) => void = () => undefined;
      const record = {
        topic,
        options,
        send: (payload: unknown) => onMessage({ payload }),
        setStatus: (status: string) => onStatus(status),
      };
      channels.push(record);
      const ch = {
        on: (_type: string, _filter: unknown, cb: (m: unknown) => void) => {
          onMessage = cb;
          return ch;
        },
        subscribe: (cb: (status: string) => void) => {
          onStatus = cb;
          return ch;
        },
      };
      return ch as unknown as RealtimeChannel;
    }),
  };
  return { client, channels };
}

describe("listenToTopic", () => {
  it("joins the topic as a private Broadcast channel and passes on what changed", async () => {
    const { client, channels } = broadcastClient();
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const stop = listenToTopic(client, "orders:restaurant:r1", {
      onMessage,
      onStatus,
    });
    await flush();

    expect(channels).toHaveLength(1);
    expect(channels[0].topic).toBe("orders:restaurant:r1");
    expect(channels[0].options).toEqual({ config: { private: true } });
    channels[0].setStatus("SUBSCRIBED");
    channels[0].send({ table: "orders", id: "o1", status: "ready" });
    expect(onStatus).toHaveBeenCalledWith("SUBSCRIBED");
    expect(onMessage).toHaveBeenCalledWith({
      table: "orders",
      id: "o1",
      status: "ready",
    });
    stop();
  });

  it("shares one channel between two screens, and closes it with the last", async () => {
    // The bookings badge sits in both navs: two listeners, one topic.
    const { client, channels } = broadcastClient();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = listenToTopic(client, "reservations:restaurant:r2", {
      onMessage: a,
    });
    await flush();
    channels[0].setStatus("SUBSCRIBED");
    const statusB = vi.fn();
    const stopB = listenToTopic(client, "reservations:restaurant:r2", {
      onMessage: b,
      onStatus: statusB,
    });
    // The second screen hears straight away that the channel is live.
    expect(statusB).toHaveBeenCalledWith("SUBSCRIBED");
    expect(channels).toHaveLength(1);

    channels[0].send({ table: "reservations" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    stopA();
    expect(client.removeChannel).not.toHaveBeenCalled();
    channels[0].send({ table: "reservations" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    stopB();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh channel after the last listener left", async () => {
    const { client, channels } = broadcastClient();
    listenToTopic(client, "requests:restaurant:r3", {
      onMessage: vi.fn(),
    })();
    await flush();
    const stop = listenToTopic(client, "requests:restaurant:r3", {
      onMessage: vi.fn(),
    });
    await flush();
    expect(channels).toHaveLength(1); // the first never joined: closed before its token
    stop();
  });
});
