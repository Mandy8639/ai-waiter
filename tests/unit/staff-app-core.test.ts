import { describe, expect, it } from "vitest";
import {
  shouldOfferStaffApp,
  staffAppPitch,
  storeForUserAgent,
} from "@/lib/staff-app/core";

describe("shouldOfferStaffApp", () => {
  const base = {
    inApp: false,
    hasAppOnAPhone: false,
    twoFactorReminderShown: false,
  };

  it("offers the app on the web to someone without it", () => {
    expect(shouldOfferStaffApp(base)).toBe(true);
  });

  it("never inside the app, never to someone who has it, never over the two-step reminder", () => {
    expect(shouldOfferStaffApp({ ...base, inApp: true })).toBe(false);
    expect(shouldOfferStaffApp({ ...base, hasAppOnAPhone: true })).toBe(false);
    expect(shouldOfferStaffApp({ ...base, twoFactorReminderShown: true })).toBe(
      false,
    );
  });
});

describe("staffAppPitch", () => {
  it("talks about new orders to the people who handle them", () => {
    expect(staffAppPitch("kitchen").title).toBe(
      "Get new orders on your phone.",
    );
    expect(staffAppPitch("staff").title).toBe("Get new orders on your phone.");
  });

  it("adds the kitchen board for owners and managers", () => {
    expect(staffAppPitch("owner").title).toMatch(/kitchen board/);
    expect(staffAppPitch("manager").title).toMatch(/kitchen board/);
  });

  it("always says to use the same account", () => {
    for (const role of ["owner", "manager", "staff", "kitchen"] as const) {
      expect(staffAppPitch(role).body).toMatch(/same account/);
    }
  });
});

describe("storeForUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "ios",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "ios",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      "android",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      null,
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      null,
    ],
    [null, null],
  ])("%s → %s", (ua, store) => {
    expect(storeForUserAgent(ua)).toBe(store);
  });
});
