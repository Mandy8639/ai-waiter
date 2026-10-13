// @vitest-environment jsdom
//
// The store apps' alerts (src/components/kitchen/native-push.ts) talk to a
// Capacitor plugin object, which answers ANY method name: "then" included.
// Returned bare from an async function, JavaScript adopts it as a promise
// and waits forever; that hid the Android app's alerts card ("load-timeout").
// The fake below behaves the same way, so the bug can't come back.
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const capacitorLikePlugin = new Proxy(
  {},
  {
    get(_target, name) {
      // Like Capacitor: every property is a native method.
      return (...args: unknown[]) => {
        calls.push(String(name));
        if (name === "checkPermissions") {
          return Promise.resolve({ receive: "granted" });
        }
        if (name === "requestPermissions") {
          return Promise.resolve({ receive: "denied" });
        }
        // An unanswered native call, e.g. "then": never settles.
        void args;
        return new Promise(() => {});
      };
    },
  },
);

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: capacitorLikePlugin,
}));

const { nativePermission, registerForNativePush } =
  await import("@/components/kitchen/native-push");

describe("talking to the Capacitor push plugin", () => {
  it("checks permission without treating the plugin as a promise", async () => {
    await expect(nativePermission()).resolves.toBe("granted");
    expect(calls).not.toContain("then");
  });

  it("asks for permission the same way", async () => {
    await expect(registerForNativePush()).rejects.toThrow("denied");
    expect(calls).not.toContain("then");
  });
});
