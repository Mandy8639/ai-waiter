import { describe, expect, it } from "vitest";
import { parseWifiForm, parseWifiRow, wifiQrPayload } from "@/lib/wifi/core";

describe("wifiQrPayload", () => {
  it("builds the string phone cameras read", () => {
    expect(
      wifiQrPayload({
        ssid: "LanternGuest",
        password: "dosa-and-chai",
        security: "WPA",
        hidden: false,
      }),
    ).toBe("WIFI:T:WPA;S:LanternGuest;P:dosa-and-chai;;");
  });

  it("escapes the characters that would break it", () => {
    expect(
      wifiQrPayload({
        ssid: 'Cafe;"Main":1,2\\',
        password: 'a;b,c:d"e\\f',
        security: "WPA",
        hidden: false,
      }),
    ).toBe(
      'WIFI:T:WPA;S:Cafe\\;\\"Main\\"\\:1\\,2\\\\;P:a\\;b\\,c\\:d\\"e\\\\f;;',
    );
  });

  it("leaves the password out of an open network and marks hidden ones", () => {
    expect(
      wifiQrPayload({
        ssid: "Open",
        password: null,
        security: "nopass",
        hidden: true,
      }),
    ).toBe("WIFI:T:nopass;S:Open;H:true;;");
  });

  it("keeps spaces in a name exactly", () => {
    expect(
      wifiQrPayload({
        ssid: " Cafe ",
        password: null,
        security: "nopass",
        hidden: false,
      }),
    ).toBe("WIFI:T:nopass;S: Cafe ;;");
  });
});

describe("parseWifiForm", () => {
  const base = {
    ssid: "LanternGuest",
    password: "12345678",
    security: "WPA",
    hidden: false,
  };

  it("turns Wi-Fi off when the name is blank", () => {
    expect(parseWifiForm({ ...base, ssid: "  " })).toEqual({
      ok: true,
      wifi: null,
    });
  });

  it("accepts a WPA network with a valid password", () => {
    expect(parseWifiForm(base)).toEqual({
      ok: true,
      wifi: {
        ssid: "LanternGuest",
        password: "12345678",
        security: "WPA",
        hidden: false,
      },
    });
  });

  it("drops the password for an open network", () => {
    expect(parseWifiForm({ ...base, security: "nopass" })).toEqual({
      ok: true,
      wifi: {
        ssid: "LanternGuest",
        password: null,
        security: "nopass",
        hidden: false,
      },
    });
  });

  it.each([
    [{ password: "short" }, /8 to 63/],
    [{ password: "x".repeat(64) }, /8 to 63/],
    [{ security: "WEP", password: "123456" }, /5, 10, 13 or 26/],
    [{ security: "WPA3-enterprise" }, /security/],
    [{ ssid: "x".repeat(33) }, /32/],
    [{ ssid: "é".repeat(17) }, /32/],
  ])("refuses %o", (change, message) => {
    const result = parseWifiForm({ ...base, ...change });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe("parseWifiRow", () => {
  it("reads a row and rejects junk", () => {
    expect(
      parseWifiRow({ ssid: "A", password: "p", security: "WPA", hidden: true }),
    ).toEqual({ ssid: "A", password: "p", security: "WPA", hidden: true });
    expect(parseWifiRow(undefined)).toBeNull();
    expect(parseWifiRow({ ssid: "A", security: "nope" })).toBeNull();
  });
});
