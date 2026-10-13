// @vitest-environment jsdom
//
// The kitchen board's alerts card. A phone (or browser) that already has
// alerts on is registered for the restaurant ON SCREEN before the card
// says "on": someone in two restaurants turned alerts on at one, and the
// other restaurant's card claimed "on" while the server had no device for
// it, so its orders never reached the phone's alarm.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveNativePushToken = vi.fn();
vi.mock("@/lib/push/actions", () => ({
  saveNativePushToken: (...args: unknown[]) => saveNativePushToken(...args),
  deleteNativePushToken: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  sendTestPushToMyDevices: vi.fn(),
}));

vi.mock("@/components/kitchen/native-push", () => ({
  nativePlatform: () => "android",
  pushPluginAvailable: () => true,
  nativePermission: async () => "granted",
  rememberedToken: () => "T".repeat(150),
  registerForNativePush: vi.fn(),
  forgetToken: vi.fn(),
  isNativeApp: () => true,
}));

const { PushAlertsToggle } =
  await import("@/components/kitchen/push-alerts-toggle");

beforeEach(() => saveNativePushToken.mockReset());
afterEach(cleanup);

describe("the alerts card in the Android app", () => {
  it("registers this phone for the restaurant on screen before saying 'on'", async () => {
    saveNativePushToken.mockResolvedValue({ ok: true });
    render(
      <PushAlertsToggle
        restaurantId="demo-cafe"
        nativeAlerts={{ ios: false, android: true }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Alerts are on for this device")).toBeVisible(),
    );
    expect(saveNativePushToken).toHaveBeenCalledWith(
      "demo-cafe",
      "T".repeat(150),
      "android",
    );
  });

  it("says 'off' when the server didn't take it, even though the phone remembers a token", async () => {
    saveNativePushToken.mockResolvedValue({ ok: false, error: "nope" });
    render(
      <PushAlertsToggle
        restaurantId="demo-cafe"
        nativeAlerts={{ ios: false, android: true }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Get alerts on this device")).toBeVisible(),
    );
  });
});
