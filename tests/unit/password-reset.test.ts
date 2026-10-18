import { describe, expect, it } from "vitest";
import {
  allowedNextPath,
  createResetMarker,
  isResetMarkerValid,
  RESET_PASSWORD_PATH,
  RESET_WINDOW_MS,
} from "@/lib/auth/password-reset-core";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  newPasswordSchema,
  PASSWORD_MISMATCH_MESSAGE,
} from "@/lib/auth/auth-schemas";
import { decideRouteAccess } from "@/lib/auth/route-access";
import { TWO_FACTOR_PATH } from "@/lib/auth/two-factor-core";

/**
 * Change password and "Forgot password?". The marker is what keeps
 * /reset-password (no current password asked) to people who came through
 * a real emailed link.
 */

const KEY = "test-secret-key";
const USER = "11111111-1111-1111-1111-111111111111";
const NOW = 1_800_000_000_000;

describe("reset marker", () => {
  it("is valid for its own user inside the window", () => {
    const marker = createResetMarker(USER, NOW, KEY);
    expect(isResetMarkerValid(marker, USER, NOW + 60_000, KEY)).toBe(true);
  });

  it("expires after the window", () => {
    const marker = createResetMarker(USER, NOW, KEY);
    expect(
      isResetMarkerValid(marker, USER, NOW + RESET_WINDOW_MS + 1, KEY),
    ).toBe(false);
  });

  it("is useless for another account", () => {
    const marker = createResetMarker(USER, NOW, KEY);
    expect(
      isResetMarkerValid(
        marker,
        "22222222-2222-2222-2222-222222222222",
        NOW,
        KEY,
      ),
    ).toBe(false);
  });

  it("can't be made up or edited without the key", () => {
    const marker = createResetMarker(USER, NOW, KEY);
    const [user, expiry, sig] = marker.split(".");
    // A later expiry with the old signature.
    expect(
      isResetMarkerValid(
        `${user}.${Number(expiry) + 1e9}.${sig}`,
        USER,
        NOW,
        KEY,
      ),
    ).toBe(false);
    // Signed with some other key.
    expect(
      isResetMarkerValid(createResetMarker(USER, NOW, "guess"), USER, NOW, KEY),
    ).toBe(false);
    for (const junk of [undefined, "", "a.b", "a.b.c.d", `${USER}.${NOW}.`]) {
      expect(isResetMarkerValid(junk, USER, NOW, KEY), String(junk)).toBe(
        false,
      );
    }
  });
});

describe("allowedNextPath", () => {
  it("only lets the reset page through", () => {
    expect(allowedNextPath("/reset-password")).toBe(RESET_PASSWORD_PATH);
    for (const next of [
      "/dashboard",
      "https://evil.example/reset-password",
      "//evil.example",
      "/reset-password/../dashboard",
      null,
      undefined,
    ]) {
      expect(allowedNextPath(next), String(next)).toBeNull();
    }
  });
});

describe("password schemas", () => {
  it("change: needs the current one, a new one of 8+, typed twice", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "old-password",
        newPassword: "new-password",
        confirmPassword: "new-password",
      }).success,
    ).toBe(true);

    const mismatch = changePasswordSchema.safeParse({
      currentPassword: "old-password",
      newPassword: "new-password",
      confirmPassword: "new-passwor",
    });
    expect(mismatch.error?.issues[0]).toMatchObject({
      path: ["confirmPassword"],
      message: PASSWORD_MISMATCH_MESSAGE,
    });

    const same = changePasswordSchema.safeParse({
      currentPassword: "same-password",
      newPassword: "same-password",
      confirmPassword: "same-password",
    });
    expect(same.error?.issues[0].path).toEqual(["newPassword"]);

    expect(
      changePasswordSchema.safeParse({
        currentPassword: "",
        newPassword: "short",
        confirmPassword: "short",
      }).success,
    ).toBe(false);
  });

  it("reset: a new one of 8+, typed twice", () => {
    expect(
      newPasswordSchema.safeParse({
        newPassword: "new-password",
        confirmPassword: "new-password",
      }).success,
    ).toBe(true);
    expect(
      newPasswordSchema.safeParse({
        newPassword: "new-password",
        confirmPassword: "other-password",
      }).success,
    ).toBe(false);
  });

  it("forgot: a real email, normalised", () => {
    expect(
      forgotPasswordSchema.parse({ email: "  Owner@Example.COM " }).email,
    ).toBe("owner@example.com");
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(
      false,
    );
  });
});

describe("routing for the reset page", () => {
  it("needs a signed-in account (the link signs them in)", () => {
    expect(
      decideRouteAccess(RESET_PASSWORD_PATH, {
        signedIn: false,
        isAnonymous: false,
      }),
    ).toEqual({
      type: "redirect",
      to: "/login",
      redirectTo: RESET_PASSWORD_PATH,
    });
  });

  it("with two-step on, goes through the code step and comes back", () => {
    expect(
      decideRouteAccess(RESET_PASSWORD_PATH, {
        signedIn: true,
        isAnonymous: false,
        twoFactorPending: true,
      }),
    ).toEqual({
      type: "redirect",
      to: TWO_FACTOR_PATH,
      redirectTo: RESET_PASSWORD_PATH,
    });
  });

  it("forgot-password stays open to everyone", () => {
    expect(
      decideRouteAccess("/forgot-password", {
        signedIn: false,
        isAnonymous: false,
      }),
    ).toEqual({ type: "continue" });
  });
});
