/**
 * Guest Wi-Fi: the text a "join Wi-Fi" QR code carries, and what an owner
 * may enter. Pure and free of `server-only` (tests/unit/wifi-core.test.ts).
 *
 * The format is the one phone cameras read (iOS 11+, Android 10+):
 *   WIFI:T:WPA;S:<name>;P:<password>;H:true;;
 * with \ ; , : and " escaped by a backslash in the name and password.
 * Names and passwords are kept exactly as typed, spaces included: a
 * network called "Cafe " is not "Cafe", and trimming would make the code
 * join nothing.
 */

export const WIFI_SECURITY = ["WPA", "WEP", "nopass"] as const;
export type WifiSecurity = (typeof WIFI_SECURITY)[number];

export interface GuestWifi {
  ssid: string;
  /** Null for an open network. */
  password: string | null;
  security: WifiSecurity;
  hidden: boolean;
}

export const WIFI_SECURITY_LABELS: Record<WifiSecurity, string> = {
  WPA: "WPA / WPA2 / WPA3 (most networks)",
  WEP: "WEP (older routers)",
  nopass: "No password",
};

function escape(value: string): string {
  return value.replace(/([\\;,:"])/g, "\\$1");
}

/** The text inside the QR code. */
export function wifiQrPayload(wifi: GuestWifi): string {
  const parts = [`T:${wifi.security}`, `S:${escape(wifi.ssid)}`];
  if (wifi.security !== "nopass" && wifi.password) {
    parts.push(`P:${escape(wifi.password)}`);
  }
  if (wifi.hidden) parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

export type WifiFormResult =
  { ok: true; wifi: GuestWifi | null } | { ok: false; error: string };

/**
 * The owner's form, checked. A blank name turns guest Wi-Fi off. Lengths
 * are the Wi-Fi standard's: a name up to 32 bytes, a WPA password 8 to 63
 * characters, WEP 5, 10, 13 or 26.
 */
export function parseWifiForm(input: {
  ssid: string;
  password: string;
  security: string;
  hidden: boolean;
}): WifiFormResult {
  if (input.ssid.trim() === "") return { ok: true, wifi: null };

  if (new TextEncoder().encode(input.ssid).length > 32) {
    return { ok: false, error: "A Wi-Fi name can be at most 32 characters." };
  }
  const security = (WIFI_SECURITY as readonly string[]).includes(input.security)
    ? (input.security as WifiSecurity)
    : null;
  if (!security) return { ok: false, error: "Choose the network's security." };

  if (security === "nopass") {
    return {
      ok: true,
      wifi: {
        ssid: input.ssid,
        password: null,
        security,
        hidden: input.hidden,
      },
    };
  }

  const password = input.password;
  if (security === "WPA" && (password.length < 8 || password.length > 63)) {
    return {
      ok: false,
      error: "A WPA password is 8 to 63 characters. Check it on your router.",
    };
  }
  if (security === "WEP" && ![5, 10, 13, 26].includes(password.length)) {
    return {
      ok: false,
      error:
        "A WEP password is 5, 10, 13 or 26 characters. Check it on your router.",
    };
  }
  return {
    ok: true,
    wifi: { ssid: input.ssid, password, security, hidden: input.hidden },
  };
}

/** A row from restaurant_wifi_for_staff() / _for_guest(), checked. */
export function parseWifiRow(row: unknown): GuestWifi | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.ssid !== "string" || r.ssid === "") return null;
  if (!(WIFI_SECURITY as readonly unknown[]).includes(r.security)) return null;
  return {
    ssid: r.ssid,
    password: typeof r.password === "string" ? r.password : null,
    security: r.security as WifiSecurity,
    hidden: r.hidden === true,
  };
}
