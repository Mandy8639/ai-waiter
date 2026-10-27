import { describe, expect, it, vi } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { openAuthorizedChannel } from "@/lib/supabase/realtime";

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
